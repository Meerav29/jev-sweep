export interface Config {
  jevModel: string;
  claudeModel: string;
  port: number;
  fake: boolean;
  dataDir: string;
  /** Where the browser app lives; the OAuth callback sends the user back here. */
  webOrigin: string;
  concurrency: number;
  cardTextTimeoutMs: number;
  keys: { typesafe?: string; anthropic?: string; googleId?: string; googleSecret?: string };
}

type Env = Record<string, string | undefined>;

const nonEmpty = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

const DEFAULT_PORT = 8787;

/** A whole number 1–65535, or the default. Its own name: a generic PORT is often set for the web dev server. */
function portOf(v: string | undefined): number {
  const t = v?.trim() ?? '';
  if (!/^\d+$/.test(t)) return DEFAULT_PORT;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

/** Reads only the env object passed in. .env loading happens in server/index.ts. */
export function loadConfig(env: Env = process.env): Config {
  return {
    jevModel: nonEmpty(env.JEV_MODEL) ?? 'jev-1.14.0',
    claudeModel: nonEmpty(env.CLAUDE_MODEL) ?? 'claude-haiku-5-5',
    port: portOf(env.JEV_SWEEP_PORT),
    fake: env.JEV_SWEEP_FAKE === '1',
    dataDir: nonEmpty(env.JEV_SWEEP_DATA_DIR) ?? 'data',
    webOrigin: (nonEmpty(env.WEB_ORIGIN) ?? 'http://localhost:5173').replace(/\/+$/, ''),
    concurrency: 6,
    cardTextTimeoutMs: 4000,
    keys: {
      typesafe: nonEmpty(env.TYPESAFE_API_KEY),
      anthropic: nonEmpty(env.ANTHROPIC_API_KEY),
      googleId: nonEmpty(env.GOOGLE_CLIENT_ID),
      googleSecret: nonEmpty(env.GOOGLE_CLIENT_SECRET),
    },
  };
}
