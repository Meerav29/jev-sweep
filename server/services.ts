import { existsSync } from 'node:fs';
import type { Email, Folder, JevAnswers, SetupStatus } from '../shared/types';
import type { Config } from './config';
import type { Repo } from './db/repo';
import type { EventHub } from './events';
import { ClaudeWriter, FakeWriter } from './claude/cardText';
import type { CardText, CardTextWriter } from './claude/cardText';
import { FakeJev, TypeSafeJev } from './jev/client';
import type { JevClient } from './jev/client';
import { FakeMail, loadFakeInbox } from './mail/fake';
import { GmailProvider } from './mail/gmail';
import { loadAuth } from './mail/oauth';
import type { MailProvider } from './mail/provider';
import { BatchRunner } from './session/runner';

/** What the batch routes need once mail, Jev and Claude are all configured. */
export interface Runtime {
  mail: MailProvider;
  runner: BatchRunner;
}

/**
 * The app's dependency container. Real mode starts with nothing configured and fills in lazily:
 * `mail()` and `runtime()` are null until the keys and the Gmail token exist.
 */
export interface Services {
  setupStatus(): SetupStatus;
  /** Null until Gmail is connected. */
  mail(): MailProvider | null;
  /** Null until mail, Jev and Claude are all configured. Built once, then kept (the runner holds batch state). */
  runtime(): Runtime | null;
  /** Called after the OAuth callback stored a new token. */
  authChanged(): void;
}

interface RunnerOpts {
  repo: Repo;
  hub: EventHub;
  concurrency: number;
  cardTextTimeoutMs?: number;
  now?: () => Date;
}

function makeRunner(o: RunnerOpts, mail: MailProvider, jev: JevClient, writer: CardTextWriter): BatchRunner {
  return new BatchRunner({
    mail, jev, writer, repo: o.repo, emit: (batchId, e) => o.hub.emit(batchId, e),
    concurrency: o.concurrency, cardTextTimeoutMs: o.cardTextTimeoutMs, now: o.now,
  });
}

/** Fixed providers, always configured. Tests inject their own fakes through this. */
export function staticServices(o: RunnerOpts & {
  mail: MailProvider; jev: JevClient; writer: CardTextWriter; setup: () => SetupStatus;
}): Services {
  const runtime: Runtime = { mail: o.mail, runner: makeRunner(o, o.mail, o.jev, o.writer) };
  return { setupStatus: o.setup, mail: () => o.mail, runtime: () => runtime, authChanged: () => {} };
}

/** Delays each answer, so fake mode looks like a live batch instead of finishing before the page opens. */
class SlowJev implements JevClient {
  constructor(private readonly inner: JevClient, private readonly ms: number) {}
  async ask(email: Email, folders: Folder[]): Promise<JevAnswers> {
    await new Promise((r) => setTimeout(r, this.ms));
    return this.inner.ask(email, folders);
  }
}

const ALL_SET: SetupStatus = { typesafe: true, anthropic: true, google: true, gmailConnected: true, foldersChosen: true, fake: true };

/**
 * Fake mode: the fixture inbox, Jev answers and summaries from the fixture, no network.
 * `now` anchors the fixture's `daysAgo` and is the runner's clock, so every email keeps the age the fixture intends.
 */
export function fakeServices(o: Omit<RunnerOpts, 'now'> & {
  fixture: unknown; now: Date; jev?: JevClient; jevDelayMs?: number;
}): Services & { fakeMail: FakeMail } {
  const items = loadFakeInbox(o.fixture, o.now);
  const fakeMail = new FakeMail(items);
  const base: JevClient = o.jev ?? new FakeJev(Object.fromEntries(items.map((f) => [f.threadId, f.jev])));
  const jev = o.jevDelayMs ? new SlowJev(base, o.jevDelayMs) : base;
  const writer = new FakeWriter(Object.fromEntries(items.filter((f) => f.summary).map((f) => [f.threadId, f.summary!])));
  const now = o.now;
  return { ...staticServices({ ...o, now: () => now, mail: fakeMail, jev, writer, setup: () => ({ ...ALL_SET }) }), fakeMail };
}

/** Forwards to the current Gmail provider, so a reconnect swaps it without rebuilding the runner. */
class SwitchMail implements MailProvider {
  constructor(public target: MailProvider) {}
  listLabels() { return this.target.listLabels(); }
  listCandidates(q: string, n: number, ex: Map<string, string>) { return this.target.listCandidates(q, n, ex); }
  getThread(t: string) { return this.target.getThread(t); }
  archive(t: string) { return this.target.archive(t); }
  unarchive(t: string) { return this.target.unarchive(t); }
  addLabel(t: string, name: string) { return this.target.addLabel(t, name); }
  star(t: string) { return this.target.star(t); }
  markRead(t: string) { return this.target.markRead(t); }
}

/** Used when there is no Anthropic key: cards get no extra text. */
class NoWriter implements CardTextWriter {
  async write(): Promise<CardText> { return {}; }
}

/** Real mode: Gmail, TypeSafe Jev and Claude, each picked up once its key or token exists. */
export function realServices(o: { repo: Repo; hub: EventHub; config: Config; tokenPath: string }): Services {
  const { config, tokenPath, repo } = o;
  const { keys } = config;
  let mail: SwitchMail | null = null;
  let runtime: Runtime | null = null;

  const loadGmail = (): void => {
    const auth = loadAuth(config, tokenPath);
    if (!auth) return;
    const gmail = new GmailProvider(auth);
    if (mail) mail.target = gmail;
    else mail = new SwitchMail(gmail);
  };
  const getMail = (): MailProvider | null => {
    if (!mail) loadGmail(); // lazy: the token may have appeared since the last request
    return mail;
  };

  return {
    setupStatus: () => ({
      typesafe: !!keys.typesafe,
      anthropic: !!keys.anthropic,
      google: !!(keys.googleId && keys.googleSecret),
      gmailConnected: existsSync(tokenPath),
      foldersChosen: repo.getSettings().folders.length > 0,
      fake: false,
    }),
    mail: getMail,
    runtime: () => {
      if (runtime) return runtime;
      const m = getMail();
      if (!m || !keys.typesafe) return null;
      const jev = new TypeSafeJev(keys.typesafe, config.jevModel);
      // The Anthropic key is optional: without it cards simply carry no "why" line or summary.
      const writer: CardTextWriter = keys.anthropic ? new ClaudeWriter(keys.anthropic, config.claudeModel) : new NoWriter();
      runtime = {
        mail: m,
        runner: makeRunner({ repo, hub: o.hub, concurrency: config.concurrency, cardTextTimeoutMs: config.cardTextTimeoutMs },
          m, jev, writer),
      };
      return runtime;
    },
    authChanged: loadGmail,
  };
}
