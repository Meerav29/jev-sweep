export interface Config {
  jevModel: string;
  claudeModel: string;
  port: number;
  fake: boolean;
  dataDir: string;
  concurrency: number;
  cardTextTimeoutMs: number;
  keys: { typesafe?: string; anthropic?: string; googleId?: string; googleSecret?: string };
}

type Env = Record<string, string | undefined>;

const nonEmpty = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

/** Reads only the env object passed in. .env loading happens in server/index.ts. */
export function loadConfig(env: Env = process.env): Config {
  return {
    jevModel: nonEmpty(env.JEV_MODEL) ?? 'jev-1.14.0',
    claudeModel: nonEmpty(env.CLAUDE_MODEL) ?? 'claude-haiku-5-5',
    port: Number(nonEmpty(env.PORT) ?? 8787),
    fake: env.JEV_SWEEP_FAKE === '1',
    dataDir: nonEmpty(env.JEV_SWEEP_DATA_DIR) ?? 'data',
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
