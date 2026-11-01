import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { streamSSE } from 'hono/streaming';
import type { BatchStatus, BatchView, Dest, Folder, SessionEvent, Settings, Thresholds } from '../shared/types';
import type { Repo } from './db/repo';
import type { EventHub } from './events';
import type { Runtime, Services } from './services';
import { applyBatch } from './session/apply';

export interface ApiDeps {
  repo: Repo;
  hub: EventHub;
  services: Services;
  /** The port the server listens on; the Host check accepts only localhost/127.0.0.1 on it. */
  port: number;
  /** SSE keep-alive comment interval. 15 s by default. */
  heartbeatMs?: number;
}

class HttpError extends Error {
  constructor(readonly status: ContentfulStatusCode, message: string) {
    super(message);
  }
}
const bad = (message: string) => new HttpError(400, message);

// ---- security middleware ----

/** Refuses any request whose Host isn't this server on loopback (blocks DNS rebinding). */
export function hostGuard(port: number): MiddlewareHandler {
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  return async (c, next) => {
    const host = c.req.header('host')?.toLowerCase();
    if (!host || !allowed.has(host)) return c.json({ error: 'forbidden host' }, 403);
    await next();
  };
}

/** State-changing requests must be JSON, which a cross-site form can't send without a (refused) CORS preflight. */
export const jsonOnly: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  const changes = m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
  // Only the OAuth GETs are exempt, and GETs never reach this check, so no path exemption is needed.
  if (changes) {
    const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return c.json({ error: 'Content-Type must be application/json' }, 415);
  }
  await next();
};

// ---- validation ----

const SYSTEM_LABELS = new Set(['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT']);

export function isSystemLabel(name: string): boolean {
  const u = name.trim().toUpperCase();
  return SYSTEM_LABELS.has(u) || u.startsWith('CATEGORY_');
}

function checkFolderName(name: unknown, what: string): string {
  if (typeof name !== 'string' || name.trim() === '') throw bad(`${what} must be a non-empty string`);
  if (isSystemLabel(name)) throw bad(`"${name}" is a Gmail system label and can't be used as a folder`);
  return name;
}

export function parseDest(v: unknown): Dest {
  if (v === 'archive' || v === 'keep') return v;
  if (typeof v === 'string' && v.startsWith('label:')) {
    checkFolderName(v.slice('label:'.length), 'label name');
    return v as Dest;
  }
  throw bad('dest must be "archive", "keep" or "label:<name>"');
}

function threadIdOf(b: Record<string, unknown>): string {
  if (typeof b.threadId !== 'string' || b.threadId === '') throw bad('threadId must be a non-empty string');
  return b.threadId;
}

const BATCH_SIZES = [10, 20, 30, 50];
const UNIT_THRESHOLDS = ['guardNoul', 'importantQueue', 'needsReplyQueue', 'autoArchiveConfidence', 'proposeConfidence'] as const;

function parseFolder(v: unknown, i: number): Folder {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`folders[${i}] must be an object`);
  const f = v as Record<string, unknown>;
  for (const k of Object.keys(f)) if (k !== 'name' && k !== 'enabled' && k !== 'description') throw bad(`folders[${i}].${k} is not a folder field`);
  const name = checkFolderName(f.name, `folders[${i}].name`);
  if (typeof f.enabled !== 'boolean') throw bad(`folders[${i}].enabled must be a boolean`);
  const out: Folder = { name, enabled: f.enabled };
  if (f.description !== undefined) {
    if (typeof f.description !== 'string') throw bad(`folders[${i}].description must be a string`);
    out.description = f.description;
  }
  return out;
}

export function parseSettingsPatch(b: Record<string, unknown>): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const [k, v] of Object.entries(b)) {
    switch (k) {
      case 'query':
        if (typeof v !== 'string') throw bad('query must be a string');
        out.query = v;
        break;
      case 'batchSize':
        if (typeof v !== 'number' || !BATCH_SIZES.includes(v)) throw bad('batchSize must be 10, 20, 30 or 50');
        out.batchSize = v as Settings['batchSize'];
        break;
      case 'dryRun':
        if (typeof v !== 'boolean') throw bad('dryRun must be a boolean');
        out.dryRun = v;
        break;
      case 'folders':
        if (!Array.isArray(v)) throw bad('folders must be an array');
        out.folders = v.map(parseFolder);
        break;
      case 'thresholds': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('thresholds must be an object');
        const t: Partial<Thresholds> = {};
        for (const [tk, tv] of Object.entries(v as Record<string, unknown>)) {
          if (tk === 'recentDays') {
            if (typeof tv !== 'number' || !Number.isInteger(tv) || tv <= 0) throw bad('thresholds.recentDays must be a positive integer');
            t.recentDays = tv;
          } else if ((UNIT_THRESHOLDS as readonly string[]).includes(tk)) {
            if (typeof tv !== 'number' || !Number.isFinite(tv) || tv < 0 || tv > 1) throw bad(`thresholds.${tk} must be a number from 0 to 1`);
            t[tk as typeof UNIT_THRESHOLDS[number]] = tv;
          } else throw bad(`thresholds.${tk} is not a threshold`);
        }
        out.thresholds = t as Thresholds; // partial: the repo merges it over the stored thresholds
        break;
      }
      default:
        throw bad(`${k} is not a setting`);
    }
  }
  return out;
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw bad('Body must be valid JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Body must be a JSON object');
  return v as Record<string, unknown>;
}

function param(c: Context, name: string): string {
  const v = c.req.param(name);
  if (!v) throw new HttpError(404, `missing ${name}`);
  return v;
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const FINISHED: BatchStatus[] = ['applied', 'discarded'];
const OPEN: BatchStatus[] = ['running', 'reviewing'];

// ---- routes ----

export function apiRoutes(deps: ApiDeps): Hono {
  const { repo, hub, services } = deps;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const app = new Hono();
  /** Resumes in progress, so two requests for an unloaded batch never resume it twice. */
  const resuming = new Map<string, Promise<void>>();
  /** Sessions whose next batch is being fetched (the batch row doesn't exist yet). */
  const starting = new Set<string>();
  /** Batches with an apply request in flight here: a second one is refused rather than joined. */
  const applying = new Set<string>();

  const known = (batchId: string): BatchStatus => {
    const s = repo.batchStatus(batchId);
    if (!s) throw new HttpError(404, 'unknown batch');
    return s;
  };
  const needRuntime = (): Runtime => {
    const rt = services.runtime();
    if (!rt) throw new HttpError(503, 'setup incomplete');
    return rt;
  };
  const sessionExists = (id: string) => repo.listSessions().some((s) => s.id === id);

  async function ensureLoaded(rt: Runtime, batchId: string): Promise<void> {
    if (rt.runner.has(batchId)) return;
    let p = resuming.get(batchId);
    if (!p) {
      p = rt.runner.resume(batchId).finally(() => { resuming.delete(batchId); });
      resuming.set(batchId, p);
    }
    await p;
  }

  /** A finished batch nobody has loaded: its receipt, straight from the repo (no Gmail calls). */
  function viewFromRepo(batchId: string): BatchView {
    const lb = repo.loadBatch(batchId);
    const read = new Set([...lb.decisions.map((d) => d.threadId), ...Object.keys(lb.jev)]).size;
    return {
      // Nothing fetches for a batch the runner hasn't loaded, so it reads as fully fetched.
      sessionId: lb.sessionId, batchId, batchNo: lb.batchNo, total: lb.total, read, fetched: lb.total, status: lb.status,
      paused: false, dryRun: lb.dryRun, decisions: lb.decisions, queue: [], current: null,
    };
  }

  /**
   * Makes the batch viewable: loaded in the runner, or finished and readable from the repo.
   * Loading means resuming (Gmail calls, Jev carries on), which a cross-site page must not be able to trigger with a GET.
   */
  async function prepare(c: Context, batchId: string): Promise<void> {
    const status = known(batchId);
    const rt = services.runtime();
    if (rt?.runner.has(batchId) || FINISHED.includes(status)) return;
    const loaded = rt ?? needRuntime();
    if (c.req.header('sec-fetch-site')?.toLowerCase() === 'cross-site') throw new HttpError(403, 'cross-site request');
    await ensureLoaded(loaded, batchId);
  }

  /** Synchronous, so a caller can pair it with a hub subscription in the same tick. Call prepare() first. */
  function currentView(batchId: string): BatchView {
    const rt = services.runtime();
    return rt?.runner.has(batchId) ? rt.runner.view(batchId) : viewFromRepo(batchId);
  }

  /** Loads the batch and checks it accepts review actions. */
  async function forAction(batchId: string): Promise<Runtime> {
    const status = known(batchId);
    const rt = needRuntime();
    if (!OPEN.includes(status)) throw new HttpError(409, `batch is ${status}`);
    await ensureLoaded(rt, batchId);
    const now = repo.batchStatus(batchId)!;
    if (!OPEN.includes(now)) throw new HttpError(409, `batch is ${now}`);
    return rt;
  }

  const route = (fn: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };

  app.get('/api/setup', route((c) => c.json(services.setupStatus())));

  app.get('/api/labels', route(async (c) => {
    const mail = services.mail();
    if (!mail) throw new HttpError(503, 'setup incomplete');
    return c.json(await mail.listLabels());
  }));

  app.get('/api/settings', route((c) => c.json(repo.getSettings())));

  app.put('/api/settings', route(async (c) => c.json(repo.saveSettings(parseSettingsPatch(await jsonBody(c))))));

  // A session with no batch is what a failed start leaves behind; it has nothing to show.
  app.get('/api/sessions', route((c) => c.json(repo.listSessions().filter((s) => s.batches > 0))));

  app.post('/api/sessions', route(async (c) => {
    await jsonBody(c);
    const rt = needRuntime();
    const { id: sessionId } = repo.createSession();
    starting.add(sessionId);
    try {
      const batchId = await rt.runner.start(sessionId);
      return c.json({ sessionId, batchId });
    } catch (e) {
      throw new HttpError(502, `Starting the batch failed: ${errMessage(e)}`);
    } finally {
      starting.delete(sessionId);
    }
  }));

  app.post('/api/sessions/:id/batches', route(async (c) => {
    await jsonBody(c);
    const sessionId = param(c, 'id');
    if (!sessionExists(sessionId)) throw new HttpError(404, 'unknown session');
    const rt = needRuntime();
    const open = repo.listSessions().find((s) => s.id === sessionId)?.unfinishedBatchId;
    if (starting.has(sessionId) || open) throw new HttpError(409, 'this session already has an open batch');
    starting.add(sessionId);
    try {
      return c.json({ batchId: await rt.runner.start(sessionId) });
    } catch (e) {
      throw new HttpError(502, `Starting the batch failed: ${errMessage(e)}`);
    } finally {
      starting.delete(sessionId);
    }
  }));

  app.get('/api/batches/:batchId', route(async (c) => {
    const id = param(c, 'batchId');
    await prepare(c, id);
    return c.json(currentView(id));
  }));

  app.post('/api/batches/:id/resume', route(async (c) => {
    await jsonBody(c);
    const id = param(c, 'id');
    const status = known(id);
    if (!FINISHED.includes(status)) await ensureLoaded(needRuntime(), id);
    return c.json(currentView(id));
  }));

  app.post('/api/batches/:id/pause', route(async (c) => {
    await jsonBody(c);
    const id = param(c, 'id');
    (await forAction(id)).runner.pause(id);
    return c.json({ ok: true });
  }));

  app.post('/api/batches/:id/continue', route(async (c) => {
    await jsonBody(c);
    const id = param(c, 'id');
    (await forAction(id)).runner.continue(id);
    return c.json({ ok: true });
  }));

  app.post('/api/batches/:id/resolve', route(async (c) => {
    const b = await jsonBody(c);
    const id = param(c, 'id');
    known(id);
    const threadId = threadIdOf(b);
    const dest = parseDest(b.dest);
    if (b.star !== undefined && typeof b.star !== 'boolean') throw bad('star must be a boolean');
    (await forAction(id)).runner.resolve(id, threadId, dest, { star: b.star === true });
    return c.json({ ok: true });
  }));

  app.post('/api/batches/:id/jump', route(async (c) => {
    const b = await jsonBody(c);
    const id = param(c, 'id');
    known(id);
    const threadId = threadIdOf(b);
    (await forAction(id)).runner.jumpTo(id, threadId);
    return c.json({ ok: true });
  }));

  app.post('/api/batches/:id/move', route(async (c) => {
    const b = await jsonBody(c);
    const id = param(c, 'id');
    known(id);
    const threadId = threadIdOf(b);
    const dest = parseDest(b.dest);
    (await forAction(id)).runner.move(id, threadId, dest);
    return c.json({ ok: true });
  }));

  app.post('/api/batches/:id/apply', route(async (c) => {
    await jsonBody(c);
    const id = param(c, 'id');
    const status = known(id);
    const rt = needRuntime();
    if (status === 'running' || status === 'discarded') throw new HttpError(409, `batch is ${status}; only a reviewed batch can be applied`);
    // A stored 'applying' with no entry here is a crashed apply; finishing it is allowed.
    if (applying.has(id)) throw new HttpError(409, 'apply is already running for this batch');
    applying.add(id);
    try {
      return c.json(await applyBatch({ mail: rt.mail, repo, emit: (b, e) => hub.emit(b, e) }, id));
    } catch (e) {
      throw new HttpError(500, `Apply failed: ${errMessage(e)}`);
    } finally {
      applying.delete(id);
      rt.runner.refresh(id);
    }
  }));

  app.post('/api/batches/:id/discard', route(async (c) => {
    await jsonBody(c);
    const id = param(c, 'id');
    const status = known(id);
    if (status === 'discarded') return c.json({ ok: true });
    if (status === 'applying' || status === 'applied') throw new HttpError(409, `batch is ${status}`);
    const rt = services.runtime();
    if (rt?.runner.has(id)) {
      // Stop Jev first and wait out the in-flight answers, so nothing acts on the batch after it is discarded.
      rt.runner.pause(id);
      await rt.runner.idle(id);
      const now = repo.batchStatus(id);
      if (now === 'applying' || now === 'applied') throw new HttpError(409, `batch is ${now}`);
    }
    repo.setBatchStatus(id, 'discarded');
    for (const d of repo.loadBatch(id).decisions) if (d.status === 'proposed') repo.deleteDecision(id, d.threadId);
    rt?.runner.refresh(id);
    return c.json({ ok: true });
  }));

  app.get('/api/batches/:id/events', route(async (c) => {
    const id = param(c, 'id');
    const signal = c.req.raw.signal;
    await prepare(c, id);
    // Gone while the batch was resuming: the node server won't cancel the body, so onAbort would never fire.
    if (signal.aborted) return c.body(null, 204);
    return streamSSE(c, async (stream) => {
      let chain: Promise<unknown> = Promise.resolve();
      let done = false;
      const enqueue = (write: () => Promise<unknown>) => {
        if (!done) chain = chain.then(write).catch(() => {});
      };
      // Serialized now: a later change to an object the runner still holds can't alter what was sent.
      const send = (e: SessionEvent) => {
        const data = JSON.stringify(e);
        enqueue(() => stream.writeSSE({ event: e.type, data }));
      };
      let off = () => {};
      let timer: ReturnType<typeof setInterval> | undefined;
      let finish = () => {};
      const closed = new Promise<void>((resolve) => { finish = resolve; });
      /** Idempotent: either the stream's abort or the request's signal can end it, or both. */
      const cleanup = () => {
        if (done) return;
        done = true;
        off();
        clearInterval(timer);
        signal.removeEventListener('abort', cleanup);
        finish();
      };
      stream.onAbort(cleanup);
      signal.addEventListener('abort', cleanup, { once: true });
      if (signal.aborted) return cleanup();
      // Subscribe and read the snapshot in the same synchronous step: every event emitted before this point is
      // already in the view, and every later one is queued behind the snapshot. Nothing lost, nothing twice.
      off = hub.subscribe(id, send);
      send({ type: 'snapshot', view: currentView(id) });
      timer = setInterval(() => enqueue(() => stream.write(': ping\n\n')), heartbeatMs);
      await closed;
    });
  }));

  return app;
}
