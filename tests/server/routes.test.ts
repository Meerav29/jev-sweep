import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../../server/app';
import { EventHub } from '../../server/events';
import { fakeServices, realServices, staticServices } from '../../server/services';
import type { Services } from '../../server/services';
import { Repo } from '../../server/db/repo';
import { FakeMail, loadFakeInbox } from '../../server/mail/fake';
import { FakeJev } from '../../server/jev/client';
import type { JevClient } from '../../server/jev/client';
import { FakeWriter } from '../../server/claude/cardText';
import { loadConfig } from '../../server/config';
import { oauthRoutes } from '../../server/mail/oauth';
import type { BatchView, Email, JevAnswers, QueueItem, SessionEvent } from '../../shared/types';

const PORT = 8787;
const HOST = `localhost:${PORT}`;
const now = new Date('2026-10-31T12:00:00Z');
const raw = JSON.parse(readFileSync('fixtures/fake-inbox.json', 'utf8')) as unknown;
const fixture = loadFakeInbox(raw, now);
const answers = Object.fromEntries(fixture.map((f) => [f.threadId, f.jev]));

/** Jev whose answers wait until the test releases them, so a batch can be held mid-run. */
class GatedJev implements JevClient {
  asked: string[] = [];
  private gates = new Map<string, () => void>();
  private waiting = new Map<string, Promise<void>>();
  private released = new Set<string>();
  async ask(email: Email): Promise<JevAnswers> {
    this.asked.push(email.threadId);
    if (!this.released.has(email.threadId)) {
      const p = new Promise<void>((r) => this.gates.set(email.threadId, r));
      this.waiting.set(email.threadId, p);
      await p;
    }
    return answers[email.threadId];
  }
  release(threadId: string): void {
    this.released.add(threadId);
    this.gates.get(threadId)?.();
  }
  releaseAll(): void {
    for (const f of fixture) this.release(f.threadId);
  }
}

let repo: Repo;
let hub: EventHub;
let services: Services;
let app: Hono;
let fakeMail: FakeMail;

function build(s: Services, opts: { heartbeatMs?: number; oauth?: Hono } = {}): Hono {
  services = s;
  app = createApp({ repo, hub, services: s, port: PORT, ...opts });
  return app;
}

function fake(jev?: JevClient, heartbeatMs?: number): Hono {
  const s = fakeServices({ repo, hub, fixture: raw, now, concurrency: 2, jev });
  fakeMail = s.fakeMail;
  return build(s, { heartbeatMs });
}

beforeEach(() => {
  repo = new Repo(':memory:');
  repo.saveSettings({ batchSize: 50 });
  hub = new EventHub();
  fake();
});

const call = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { Host: HOST, ...(init.headers as Record<string, string> | undefined) } });
const send = (method: 'POST' | 'PUT', path: string, body?: unknown) =>
  call(path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const post = (path: string, body?: unknown) => send('POST', path, body);

const runner = () => services.runtime()!.runner;
async function start(): Promise<{ sessionId: string; batchId: string }> {
  const res = await post('/api/sessions');
  expect(res.status).toBe(200);
  return (await res.json()) as { sessionId: string; batchId: string };
}
const view = async (batchId: string) => (await (await call(`/api/batches/${batchId}`)).json()) as BatchView;

// ---- SSE reader ----

interface SSEMessage { event: string; data: SessionEvent }
async function openSSE(batchId: string) {
  const res = await call(`/api/batches/${batchId}/events`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const comments: string[] = [];
  const pending: SSEMessage[] = [];
  const parse = () => {
    let i: number;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const lines = block.split('\n');
      if (lines.every((l) => l.startsWith(':'))) { comments.push(block); continue; }
      const event = lines.find((l) => l.startsWith('event: '))!.slice(7);
      const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      pending.push({ event, data: JSON.parse(data) as SessionEvent });
    }
  };
  async function pump(ms: number): Promise<boolean> {
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));
    const r = await Promise.race([reader.read(), timeout]);
    if (r === 'timeout') return false;
    if (r.done) return false;
    buf += dec.decode(r.value, { stream: true });
    parse();
    return true;
  }
  return {
    comments,
    async next(ms = 2000): Promise<SSEMessage> {
      const until = Date.now() + ms;
      while (pending.length === 0) {
        if (Date.now() > until || !(await pump(until - Date.now()))) throw new Error('no SSE event');
      }
      return pending.shift()!;
    },
    /** Everything that arrives until the stream has been quiet for `quietMs`. */
    async drain(quietMs = 100): Promise<SSEMessage[]> {
      while (await pump(quietMs)) { /* keep reading */ }
      return pending.splice(0);
    },
    async waitComment(ms = 2000): Promise<void> {
      const until = Date.now() + ms;
      while (comments.length === 0) {
        if (Date.now() > until || !(await pump(until - Date.now()))) throw new Error('no SSE comment');
      }
    },
    close: () => reader.cancel(),
  };
}

// What a browser builds from snapshot + events.
function outranks(a: QueueItem, b: QueueItem): boolean {
  return a.important !== b.important ? a.important : a.n < b.n;
}
function mirror(events: SessionEvent[]): BatchView {
  let v: BatchView | null = null;
  for (const e of events) {
    if (e.type === 'snapshot') { v = structuredClone(e.view); continue; }
    if (!v) throw new Error(`event ${e.type} before snapshot`);
    switch (e.type) {
      case 'decided':
        v.queue = v.queue.filter((q) => q.threadId !== e.decision.threadId);
        v.decisions = v.decisions.filter((d) => d.threadId !== e.decision.threadId);
        v.decisions.push(e.decision);
        v.decisions.sort((x, y) => x.n - y.n);
        break;
      case 'queued': {
        const at = v.queue.findIndex((q) => outranks(e.item, q));
        v.queue.splice(at === -1 ? v.queue.length : at, 0, e.item);
        break;
      }
      case 'current':
        v.current = e.card;
        if (e.card) v.queue = v.queue.filter((q) => q.threadId !== e.card!.threadId);
        break;
      case 'progress': v.read = e.read; v.fetched = e.fetched; v.total = e.total; v.paused = e.paused; break;
      case 'status': v.status = e.status; break;
      default: break;
    }
  }
  if (!v) throw new Error('no snapshot');
  return v;
}

/** Answers every card until the queue is empty, so the batch reaches `reviewing`. */
async function reviewAll(batchId: string): Promise<void> {
  await runner().idle(batchId);
  for (let v = runner().view(batchId); v.current; v = runner().view(batchId)) {
    expect((await post(`/api/batches/${batchId}/resolve`, { threadId: v.current.threadId, dest: 'keep' })).status).toBe(200);
    await runner().idle(batchId);
  }
  expect(runner().view(batchId).status).toBe('reviewing');
}

// ---- brief tests ----

describe('brief', () => {
  test('POST /api/sessions starts a session and its first batch', async () => {
    const { sessionId, batchId } = await start();
    expect(typeof sessionId).toBe('string');
    expect(typeof batchId).toBe('string');
    expect(repo.batchStatus(batchId)).toBe('running');
  });

  test('the SSE stream starts with a snapshot of the batch', async () => {
    const { batchId } = await start();
    const s = await openSSE(batchId);
    const first = await s.next();
    expect(first.event).toBe('snapshot');
    expect(first.data.type).toBe('snapshot');
    expect((first.data as Extract<SessionEvent, { type: 'snapshot' }>).view.batchId).toBe(batchId);
    await s.close();
  });

  test('two subscribers both receive the same next decided event', async () => {
    const jev = new GatedJev();
    fake(jev);
    const { batchId } = await start();
    const a = await openSSE(batchId);
    const b = await openSSE(batchId);
    expect((await a.next()).event).toBe('snapshot');
    expect((await b.next()).event).toBe('snapshot');
    jev.release(jev.asked[0]);
    const firstDecided = async (s: Awaited<ReturnType<typeof openSSE>>) => {
      for (;;) { const m = await s.next(); if (m.event === 'decided') return m.data; }
    };
    const [da, db] = await Promise.all([firstDecided(a), firstDecided(b)]);
    expect(da).toEqual(db);
    expect((da as Extract<SessionEvent, { type: 'decided' }>).decision.threadId).toBe(jev.asked[0]);
    jev.releaseAll();
    await runner().idle(batchId);
    await a.close(); await b.close();
  });

  test('subscribing after some events still starts with a snapshot holding the decisions so far', async () => {
    const { batchId } = await start();
    await runner().idle(batchId);
    const made = repo.loadBatch(batchId).decisions;
    expect(made.length).toBeGreaterThan(0);
    const s = await openSSE(batchId);
    const first = await s.next();
    expect(first.event).toBe('snapshot');
    expect((first.data as Extract<SessionEvent, { type: 'snapshot' }>).view.decisions).toEqual(made);
    await s.close();
  });

  test('resolving the same thread twice is 200 both times and leaves one decision', async () => {
    const { batchId } = await start();
    await runner().idle(batchId);
    const t = runner().view(batchId).current!.threadId;
    const seen: SessionEvent[] = [];
    hub.subscribe(batchId, (e) => seen.push(e));
    expect((await post(`/api/batches/${batchId}/resolve`, { threadId: t, dest: 'keep' })).status).toBe(200);
    expect((await post(`/api/batches/${batchId}/resolve`, { threadId: t, dest: 'archive' })).status).toBe(200);
    const mine = repo.loadBatch(batchId).decisions.filter((d) => d.threadId === t);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ dest: 'keep', who: 'you' });
    expect(seen.filter((e) => e.type === 'decided' && e.decision.threadId === t)).toHaveLength(1);
  });

  test('GET /api/setup in fake mode is all true', async () => {
    const res = await call('/api/setup');
    expect(await res.json()).toEqual({ typesafe: true, anthropic: true, google: true, gmailConnected: true, foldersChosen: true, fake: true });
  });

  test('PUT /api/settings {dryRun:true} is persisted', async () => {
    const res = await send('PUT', '/api/settings', { dryRun: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dryRun: boolean }).dryRun).toBe(true);
    expect(repo.getSettings().dryRun).toBe(true);
    expect(((await (await call('/api/settings')).json()) as { dryRun: boolean }).dryRun).toBe(true);
  });
});

// ---- ruling 1: security ----

describe('security', () => {
  test('requests with a foreign or missing Host are refused', async () => {
    expect((await app.request('/api/setup', { headers: { Host: 'evil.example.com' } })).status).toBe(403);
    expect((await app.request('/api/setup', { headers: { Host: `evil.example.com:${PORT}` } })).status).toBe(403);
    expect((await app.request('/api/setup', { headers: { Host: 'localhost:9999' } })).status).toBe(403);
    expect((await app.request('/api/setup')).status).toBe(403);
    expect((await app.request('/api/health', { headers: { Host: 'evil.example.com' } })).status).toBe(403);
    expect((await app.request('/api/setup', { headers: { Host: `127.0.0.1:${PORT}` } })).status).toBe(200);
    expect((await app.request('/api/setup', { headers: { Host: `LOCALHOST:${PORT}` } })).status).toBe(200);
  });

  test('POST and PUT need a JSON content type', async () => {
    expect((await call('/api/sessions', { method: 'POST' })).status).toBe(415);
    expect((await call('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await call('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'dryRun=true' })).status).toBe(415);
    expect(repo.getSettings().dryRun).toBe(false);
    expect((await call('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"dryRun":true}' })).status).toBe(200);
  });

  test('the OAuth GET routes are mounted and exempt from the JSON rule', async () => {
    const cfg = loadConfig({});
    build(fakeServices({ repo, hub, fixture: raw, now, concurrency: 2 }), { oauth: oauthRoutes(cfg, join(tmpdir(), 'none.json')) });
    const res = await call('/api/auth/google');
    expect(res.status).toBe(400); // no Google client configured: the OAuth route's own answer
    expect(((await res.json()) as { error: string }).error).toMatch(/GOOGLE_CLIENT_ID/);
  });

  test('no CORS headers, even for a cross-origin request or preflight', async () => {
    const res = await call('/api/setup', { headers: { Origin: 'https://evil.example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await call('/api/sessions', { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    expect(pre.headers.get('access-control-allow-methods')).toBeNull();
  });

  test('invalid JSON is a 400', async () => {
    const res = await call('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    expect(res.status).toBe(400);
  });
});

// ---- ruling 2: lazy real mode ----

describe('real mode', () => {
  function realSetup(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'jev-routes-'));
    const config = loadConfig({ ...env, JEV_SWEEP_DATA_DIR: dir });
    const tokenPath = join(dir, 'google-token.json');
    build(realServices({ repo, hub, config, tokenPath }));
    return { tokenPath };
  }
  const SECRETS = { TYPESAFE_API_KEY: 'ts-SECRET-1', ANTHROPIC_API_KEY: 'sk-ant-SECRET-2', GOOGLE_CLIENT_ID: 'gid-SECRET-3', GOOGLE_CLIENT_SECRET: 'gsec-SECRET-4' };

  test('with nothing configured, setup/settings/sessions work and the rest is 503', async () => {
    realSetup({});
    const setup = await call('/api/setup');
    expect(await setup.json()).toEqual({ typesafe: false, anthropic: false, google: false, gmailConnected: false, foldersChosen: false, fake: false });
    expect((await call('/api/settings')).status).toBe(200);
    expect((await send('PUT', '/api/settings', { folders: [{ name: 'Receipts', enabled: true }] })).status).toBe(200);
    expect((await call('/api/sessions')).status).toBe(200);
    for (const res of [
      await post('/api/sessions'),
      await call('/api/labels'),
    ]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'setup incomplete' });
    }
    expect(((await (await call('/api/setup')).json()) as { foldersChosen: boolean }).foldersChosen).toBe(true);
  });

  test('batch routes are 503 until configured (a known batch, not a 404)', async () => {
    realSetup({});
    const sessionId = repo.createSession().id;
    const { id } = repo.createBatch(sessionId, 0);
    for (const res of [
      await post(`/api/batches/${id}/resume`),
      await post(`/api/batches/${id}/resolve`, { threadId: 't1', dest: 'keep' }),
      await post(`/api/batches/${id}/apply`),
      await post(`/api/sessions/${sessionId}/batches`),
      await call(`/api/batches/${id}/events`),
      await call(`/api/batches/${id}`), // still running: building its view needs the runner
    ]) expect(res.status).toBe(503);
  });

  test('a finished batch view (receipt) works without setup', async () => {
    realSetup({});
    const sessionId = repo.createSession().id;
    const { id } = repo.createBatch(sessionId, 1);
    const e = fixture[0];
    repo.saveEmail(id, 1, e);
    repo.saveDecision(id, { threadId: e.threadId, n: 1, subject: e.subject, fromName: e.fromName, dest: 'archive', who: 'jev',
      important: false, star: false, opened: false, status: 'applied' });
    repo.setBatchStatus(id, 'applied');
    const res = await call(`/api/batches/${id}`);
    expect(res.status).toBe(200);
    const v = (await res.json()) as BatchView;
    expect(v).toMatchObject({ batchId: id, sessionId, status: 'applied', total: 1, read: 1, fetched: 1, queue: [], current: null });
    expect(v.decisions).toHaveLength(1);
  });

  test('keys present are reported as booleans only; the token is picked up lazily', async () => {
    const { tokenPath } = realSetup(SECRETS);
    const before = await call('/api/setup');
    const text = await before.text();
    for (const s of Object.values(SECRETS)) expect(text).not.toContain(s);
    expect(JSON.parse(text)).toMatchObject({ typesafe: true, anthropic: true, google: true, gmailConnected: false });
    expect((await call('/api/labels')).status).toBe(503);
    expect(services.runtime()).toBeNull();

    mkdirSync(join(tokenPath, '..'), { recursive: true });
    writeFileSync(tokenPath, JSON.stringify({ access_token: 'tok-SECRET-5', refresh_token: 'ref-SECRET-6' }));
    const after = await call('/api/setup');
    const t2 = await after.text();
    expect(t2).not.toContain('SECRET');
    expect(JSON.parse(t2)).toMatchObject({ gmailConnected: true });
    expect(services.mail()).not.toBeNull();
    expect(services.runtime()).not.toBeNull();
    expect(services.runtime()).toBe(services.runtime()); // one runner, kept
  });
});

// ---- ruling 4: validation ----

describe('validation', () => {
  let batchId: string;
  beforeEach(async () => {
    ({ batchId } = await start());
    await runner().idle(batchId);
  });
  const resolve = (body: unknown) => post(`/api/batches/${batchId}/resolve`, body);

  test('resolve and move bodies are checked', async () => {
    const t = runner().view(batchId).current!.threadId;
    expect((await resolve({ dest: 'keep' })).status).toBe(400);
    expect((await resolve({ threadId: 5, dest: 'keep' })).status).toBe(400);
    expect((await resolve({ threadId: t, dest: 'trash' })).status).toBe(400);
    expect((await resolve({ threadId: t, dest: 'label:' })).status).toBe(400);
    expect((await resolve({ threadId: t, dest: 'keep', star: 'yes' })).status).toBe(400);
    expect((await resolve([])).status).toBe(400);
    expect((await post(`/api/batches/${batchId}/move`, { threadId: t })).status).toBe(400);
    expect((await post(`/api/batches/${batchId}/jump`, {})).status).toBe(400);
    expect(repo.loadBatch(batchId).decisions.some((d) => d.threadId === t)).toBe(false);
    expect((await resolve({ threadId: t, dest: 'label:Receipts', star: true })).status).toBe(200);
  });

  test('system label names are refused as destinations and folders', async () => {
    const t = runner().view(batchId).current!.threadId;
    for (const name of ['INBOX', 'spam', 'Trash', 'unread', 'STARRED', 'Important', 'sent', 'DRAFT', 'chat', 'CATEGORY_PROMOTIONS', 'category_social']) {
      const res = await resolve({ threadId: t, dest: `label:${name}` });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/system label/i);
      const f = await send('PUT', '/api/settings', { folders: [{ name, enabled: true }] });
      expect(f.status).toBe(400);
      expect(((await f.json()) as { error: string }).error).toMatch(/system label/i);
    }
    expect((await post(`/api/batches/${batchId}/move`, { threadId: t, dest: 'label:Inbox' })).status).toBe(400);
  });

  test('settings patches are typed', async () => {
    const bad: unknown[] = [
      { batchSize: 25 }, { batchSize: '20' }, { query: 5 }, { dryRun: 'true' },
      { folders: 'Receipts' }, { folders: [{ name: 'Receipts' }] }, { folders: [{ name: '', enabled: true }] },
      { folders: [{ name: 'Receipts', enabled: true, description: 3 }] },
      { thresholds: { guardNoul: 1.5 } }, { thresholds: { proposeConfidence: -0.1 } }, { thresholds: { importantQueue: 'x' } },
      { thresholds: { recentDays: 0 } }, { thresholds: { recentDays: 1.5 } }, { thresholds: { bogus: 1 } },
      { unknownField: 1 }, [], null,
    ];
    for (const b of bad) expect((await send('PUT', '/api/settings', b)).status, JSON.stringify(b)).toBe(400);
    const ok = await send('PUT', '/api/settings', {
      batchSize: 30, query: 'in:inbox', folders: [{ name: 'Receipts', enabled: true, description: 'shop mail' }],
      thresholds: { guardNoul: 0, autoArchiveConfidence: 1, recentDays: 3 }, dryRun: true,
    });
    expect(ok.status).toBe(200);
    expect(repo.getSettings()).toMatchObject({ batchSize: 30, query: 'in:inbox', dryRun: true,
      thresholds: { guardNoul: 0, autoArchiveConfidence: 1, recentDays: 3, importantQueue: 0.7 } });
  });
});

// ---- 404 / 409 ----

describe('errors', () => {
  test('unknown batch or session is a 404', async () => {
    expect((await call('/api/batches/nope')).status).toBe(404);
    expect((await call('/api/batches/nope/events')).status).toBe(404);
    for (const action of ['resume', 'pause', 'continue', 'apply', 'discard']) {
      expect((await post(`/api/batches/nope/${action}`)).status).toBe(404);
    }
    expect((await post('/api/batches/nope/resolve', { threadId: 't1', dest: 'keep' })).status).toBe(404);
    expect((await post('/api/sessions/nope/batches')).status).toBe(404);
  });

  test('a next batch is refused while the session has an open batch', async () => {
    const { sessionId, batchId } = await start();
    expect((await post(`/api/sessions/${sessionId}/batches`)).status).toBe(409);
    await reviewAll(batchId);
    expect((await post(`/api/sessions/${sessionId}/batches`)).status).toBe(409); // reviewing is still open
    expect((await post(`/api/batches/${batchId}/apply`)).status).toBe(200);
    const next = await post(`/api/sessions/${sessionId}/batches`);
    expect(next.status).toBe(200);
    expect(typeof ((await next.json()) as { batchId: string }).batchId).toBe('string');
  });

  test('wrong-state actions are a 409', async () => {
    const { batchId } = await start();
    await runner().idle(batchId);
    expect((await post(`/api/batches/${batchId}/apply`)).status).toBe(409); // still running
    await reviewAll(batchId);
    expect((await post(`/api/batches/${batchId}/apply`)).status).toBe(200);
    expect((await post(`/api/batches/${batchId}/discard`)).status).toBe(409); // already applied
    expect((await post(`/api/batches/${batchId}/resolve`, { threadId: 't1', dest: 'keep' })).status).toBe(409);
    expect((await post(`/api/batches/${batchId}/move`, { threadId: 't1', dest: 'keep' })).status).toBe(409);
  });

  test('applying a discarded batch is a 409', async () => {
    const { batchId } = await start();
    await runner().idle(batchId);
    expect((await post(`/api/batches/${batchId}/discard`)).status).toBe(200);
    expect((await post(`/api/batches/${batchId}/apply`)).status).toBe(409);
  });
});

// ---- ruling 3: apply and discard ----

describe('apply and discard', () => {
  test('apply returns counts and refreshes the runner, so a later view matches the repo', async () => {
    const { batchId } = await start();
    await reviewAll(batchId);
    const res = await post(`/api/batches/${batchId}/apply`);
    expect(res.status).toBe(200);
    const counts = (await res.json()) as { applied: number; skipped: number; failed: number };
    expect(counts.applied).toBeGreaterThan(0);
    expect(counts.failed).toBe(0);
    const v = await view(batchId);
    expect(v.status).toBe('applied');
    expect(v.decisions).toEqual(repo.loadBatch(batchId).decisions);
    expect(v.decisions.some((d) => d.status === 'proposed')).toBe(false);
  });

  test('discard marks the batch discarded and drops proposed decisions', async () => {
    const { batchId } = await start();
    await runner().idle(batchId);
    expect(repo.loadBatch(batchId).decisions.some((d) => d.status === 'proposed')).toBe(true);
    const res = await post(`/api/batches/${batchId}/discard`);
    expect(res.status).toBe(200);
    expect(repo.batchStatus(batchId)).toBe('discarded');
    const stored = repo.loadBatch(batchId).decisions;
    expect(stored.some((d) => d.status === 'proposed')).toBe(false);
    expect(stored.some((d) => d.status === 'auto_applied')).toBe(true);
    const v = await view(batchId);
    expect(v.status).toBe('discarded');
    expect(v.decisions).toEqual(stored);
    expect((await post(`/api/batches/${batchId}/discard`)).status).toBe(200); // idempotent
  });

  test('discarding a running batch stops Jev before it acts again', async () => {
    const jev = new GatedJev();
    fake(jev);
    const { batchId } = await start();
    const discarding = post(`/api/batches/${batchId}/discard`);
    await new Promise((r) => setTimeout(r, 20)); // the handler has paused and is waiting on the two in-flight answers
    jev.releaseAll();
    expect((await discarding).status).toBe(200);
    await runner().idle(batchId);
    expect(repo.batchStatus(batchId)).toBe('discarded');
    expect(repo.loadBatch(batchId).decisions.some((d) => d.status === 'proposed')).toBe(false);
    expect(jev.asked.length).toBeLessThan(fixture.length);
  });
});

// ---- other routes ----

describe('routes', () => {
  test('labels, sessions, batch view, pause/continue, jump, move', async () => {
    expect(await (await call('/api/labels')).json()).toEqual(await new FakeMail(fixture).listLabels());
    const { sessionId, batchId } = await start();
    await runner().idle(batchId);
    const sessions = (await (await call('/api/sessions')).json()) as { id: string; unfinishedBatchId?: string }[];
    expect(sessions).toEqual([expect.objectContaining({ id: sessionId, unfinishedBatchId: batchId })]);

    expect((await post(`/api/batches/${batchId}/pause`)).status).toBe(200);
    expect((await view(batchId)).paused).toBe(true);
    expect((await post(`/api/batches/${batchId}/continue`)).status).toBe(200);
    expect((await view(batchId)).paused).toBe(false);

    const v = await view(batchId);
    const target = v.queue[0].threadId;
    expect((await post(`/api/batches/${batchId}/jump`, { threadId: target })).status).toBe(200);
    expect((await view(batchId)).current!.threadId).toBe(target);

    const proposed = v.decisions.find((d) => d.status === 'proposed')!;
    expect((await post(`/api/batches/${batchId}/move`, { threadId: proposed.threadId, dest: 'keep' })).status).toBe(200);
    expect(repo.decision(batchId, proposed.threadId)).toMatchObject({ dest: 'keep', who: 'you' });
    expect(await view(batchId)).toEqual(runner().view(batchId));
  });

  test('resume loads a batch the runner has never seen (server restart)', async () => {
    const { batchId } = await start();
    await runner().idle(batchId);
    const before = runner().view(batchId);
    fake(); // new runner, same repo
    expect(services.runtime()!.runner.has(batchId)).toBe(false);
    const res = await post(`/api/batches/${batchId}/resume`);
    expect(res.status).toBe(200);
    const after = await view(batchId);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.current?.threadId).toBe(before.current?.threadId);
  });
});

// ---- ruling 5/6: SSE and the hub ----

describe('sse', () => {
  test('reload mid-batch: snapshot then live events, nothing lost or duplicated', async () => {
    const jev = new GatedJev();
    fake(jev);
    const { batchId } = await start();
    const firstHalf = fixture.slice(0, 19).map((f) => f.threadId);
    for (const t of firstHalf) jev.release(t);
    // Let part of the batch happen with nobody listening.
    await new Promise((r) => setTimeout(r, 30));
    const s = await openSSE(batchId);
    const snap = await s.next();
    expect(snap.event).toBe('snapshot');
    const snapView = (snap.data as Extract<SessionEvent, { type: 'snapshot' }>).view;
    jev.releaseAll();
    await runner().idle(batchId);
    const rest = await s.drain();
    for (const m of rest) expect(m.event).toBe(m.data.type);
    const all = [snap.data, ...rest.map((m) => m.data)];
    expect(mirror(all)).toEqual(runner().view(batchId));
    // A thread decided before the snapshot is never decided again on the stream.
    const before = new Set(snapView.decisions.map((d) => d.threadId));
    const again = rest.filter((m) => m.data.type === 'decided' && before.has(m.data.decision.threadId));
    expect(again).toEqual([]);
    // And each thread is decided at most once.
    const decided = rest.flatMap((m) => (m.data.type === 'decided' ? [m.data.decision.threadId] : []));
    expect(new Set(decided).size).toBe(decided.length);
    await s.close();
  });

  test('a batch the runner has not loaded is resumed for the stream', async () => {
    const { batchId } = await start();
    await runner().idle(batchId);
    const before = runner().view(batchId);
    fake();
    const s = await openSSE(batchId);
    const snap = await s.next();
    expect(snap.event).toBe('snapshot');
    expect((snap.data as Extract<SessionEvent, { type: 'snapshot' }>).view.decisions).toEqual(before.decisions);
    await s.close();
  });

  test('a finished batch still streams its snapshot (receipt)', async () => {
    const { batchId } = await start();
    await reviewAll(batchId);
    await post(`/api/batches/${batchId}/apply`);
    fake();
    const s = await openSSE(batchId);
    const snap = await s.next();
    expect((snap.data as Extract<SessionEvent, { type: 'snapshot' }>).view.status).toBe('applied');
    await s.close();
  });

  test('closing the stream unsubscribes', async () => {
    const { batchId } = await start();
    const s = await openSSE(batchId);
    await s.next();
    expect(hub.count(batchId)).toBe(1);
    await s.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(hub.count(batchId)).toBe(0);
  });

  test('a heartbeat comment keeps the stream alive', async () => {
    fake(undefined, 20);
    const { batchId } = await start();
    const s = await openSSE(batchId);
    await s.next();
    await s.waitComment();
    expect(s.comments[0].startsWith(':')).toBe(true);
    await s.close();
  });
});

describe('EventHub', () => {
  test('delivers per batch, survives a throwing subscriber, unsubscribes', () => {
    const h = new EventHub();
    const got: string[] = [];
    h.subscribe('b1', () => { throw new Error('bad subscriber'); });
    const off = h.subscribe('b1', (e) => got.push(`x:${e.type}`));
    h.subscribe('b2', (e) => got.push(`y:${e.type}`));
    const e: SessionEvent = { type: 'status', status: 'reviewing' };
    h.emit('b1', e);
    expect(got).toEqual(['x:status']);
    off();
    h.emit('b1', e);
    expect(got).toEqual(['x:status']);
    expect(h.count('b1')).toBe(1);
    h.emit('b2', e);
    expect(got).toEqual(['x:status', 'y:status']);
  });
});

test('staticServices wires injected providers', async () => {
  const s = staticServices({
    repo, hub, mail: new FakeMail(fixture), jev: new FakeJev(answers), writer: new FakeWriter(), concurrency: 1,
    setup: () => ({ typesafe: true, anthropic: true, google: true, gmailConnected: true, foldersChosen: false, fake: false }),
  });
  build(s);
  expect(((await (await call('/api/setup')).json()) as { foldersChosen: boolean }).foldersChosen).toBe(false);
  const { batchId } = await start();
  await s.runtime()!.runner.idle(batchId);
  expect(repo.loadBatch(batchId).decisions.length).toBeGreaterThan(0);
});

// ---- fix round 1 ----

/** FakeMail whose getThread waits for a gate, so a resume (and the request waiting on it) can be held open. */
class GatedMail extends FakeMail {
  private open!: () => void;
  readonly gate = new Promise<void>((r) => { this.open = r; });
  waiting = 0;
  release(): void { this.open(); }
  async getThread(threadId: string): Promise<Email | null> {
    this.waiting++;
    await this.gate;
    return super.getThread(threadId);
  }
}

/** A batch with queued cards, left unloaded: the app now runs on a fresh runner whose mail blocks in getThread. */
async function unloadedBatch(): Promise<{ batchId: string; mail: GatedMail }> {
  const { batchId } = await start();
  await runner().idle(batchId);
  expect(runner().view(batchId).current).not.toBeNull();
  const mail = new GatedMail(fixture);
  build(staticServices({
    repo, hub, mail, jev: new FakeJev(answers), writer: new FakeWriter(), concurrency: 2, now: () => now,
    setup: () => ({ typesafe: true, anthropic: true, google: true, gmailConnected: true, foldersChosen: true, fake: true }),
  }));
  expect(runner().has(batchId)).toBe(false);
  return { batchId, mail };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('fix round 1', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test('a client gone while the batch resumes leaves no subscription and no heartbeat', async () => {
    const { batchId, mail } = await unloadedBatch();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const ac = new AbortController();
    const pending = call(`/api/batches/${batchId}/events`, { signal: ac.signal });
    await tick();
    expect(mail.waiting).toBeGreaterThan(0); // stuck in prepare (resume → getThread)
    ac.abort();
    mail.release();
    const res = await pending;
    await runner().idle(batchId);
    await tick();
    expect(res.status).toBe(204);
    expect(hub.count(batchId)).toBe(0);
    expect(intervals).not.toHaveBeenCalled();
  });

  test("the request's abort signal also ends an open stream (idempotently)", async () => {
    const { batchId } = await start();
    const ac = new AbortController();
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const res = await call(`/api/batches/${batchId}/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read(); // the snapshot
    expect(hub.count(batchId)).toBe(1);
    ac.abort();
    await tick();
    expect(hub.count(batchId)).toBe(0);
    expect(clear).toHaveBeenCalledTimes(1);
    await reader.cancel(); // the stream's own abort afterwards: cleanup doesn't run twice
    await tick();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  test('two parallel applies: one 200, one 409, Gmail written once', async () => {
    const { batchId } = await start();
    await reviewAll(batchId);
    const before = fakeMail.log.length;
    const [a, b] = await Promise.all([post(`/api/batches/${batchId}/apply`), post(`/api/batches/${batchId}/apply`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const writes = fakeMail.log.slice(before);
    expect(writes.length).toBeGreaterThan(0);
    expect(new Set(writes).size).toBe(writes.length);
    expect(repo.batchStatus(batchId)).toBe('applied');
  });

  test('a stored applying status with no apply in flight (crash) can still be applied', async () => {
    const { batchId } = await start();
    await reviewAll(batchId);
    repo.setBatchStatus(batchId, 'applying');
    const res = await post(`/api/batches/${batchId}/apply`);
    expect(res.status).toBe(200);
    expect(repo.batchStatus(batchId)).toBe('applied');
  });

  test('a cross-site GET cannot resume an unloaded running batch', async () => {
    const { batchId, mail } = await unloadedBatch();
    const xs = { 'Sec-Fetch-Site': 'cross-site' };
    expect((await call(`/api/batches/${batchId}`, { headers: xs })).status).toBe(403);
    expect((await call(`/api/batches/${batchId}/events`, { headers: xs })).status).toBe(403);
    expect(runner().has(batchId)).toBe(false);
    expect(mail.waiting).toBe(0);
    mail.release();
    const same = await call(`/api/batches/${batchId}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(same.status).toBe(200);
    expect(runner().has(batchId)).toBe(true);
    // Once loaded, viewing it resumes nothing, so the header no longer matters.
    expect((await call(`/api/batches/${batchId}`, { headers: xs })).status).toBe(200);
    await runner().idle(batchId);
  });

  test('the JSON exemption for /api/auth/ covers GET only', async () => {
    build(fakeServices({ repo, hub, fixture: raw, now, concurrency: 2 }),
      { oauth: oauthRoutes(loadConfig({}), join(tmpdir(), 'none.json')) });
    expect((await call('/api/auth/google', { method: 'POST' })).status).toBe(415);
    expect((await call('/api/auth/google/callback?code=x&state=y', { method: 'POST', body: 'a=b',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    expect((await call('/api/auth/google')).status).toBe(400); // GET still reaches the OAuth route
  });

  test('sessions with no batch (a failed start) are not listed', async () => {
    class BrokenMail extends FakeMail {
      async listCandidates(): Promise<{ threadId: string; latestMessageId: string }[]> { throw new Error('gmail down'); }
    }
    build(staticServices({
      repo, hub, mail: new BrokenMail(fixture), jev: new FakeJev(answers), writer: new FakeWriter(), concurrency: 1,
      setup: () => ({ typesafe: true, anthropic: true, google: true, gmailConnected: true, foldersChosen: true, fake: false }),
    }));
    const res = await post('/api/sessions');
    expect(res.status).toBe(502);
    expect(repo.listSessions()).toHaveLength(1);
    expect(await (await call('/api/sessions')).json()).toEqual([]);
    fake();
    const { sessionId } = await start();
    const listed = (await (await call('/api/sessions')).json()) as { id: string }[];
    expect(listed.map((s) => s.id)).toEqual([sessionId]);
  });
});
