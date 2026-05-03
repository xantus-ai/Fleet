import "dotenv/config";

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid number for ${name}: ${v}`);
  return n;
}

export const config = {
  databaseUrl: optional(
    "DATABASE_URL",
    "postgres://postgres@localhost:5432/fleet",
  ),
  port: num("PORT", 8787),

  linear: {
    webhookSecret: optional("LINEAR_WEBHOOK_SECRET", ""),
    apiKey: optional("LINEAR_API_KEY", ""),
    triggerLabel: optional("LINEAR_TRIGGER_LABEL", "agent-ready"),
  },

  github: {
    defaultRepo: optional("GITHUB_DEFAULT_REPO", ""),
    repoPath: optional("REPO_PATH", ""),
    defaultBranch: optional("DEFAULT_BRANCH", "main"),
  },

  anthropic: {
    apiKey: optional("ANTHROPIC_API_KEY", ""),
  },

  agent: {
    model: optional("AGENT_MODEL", "claude-sonnet-4-6"),
    maxTurns: num("AGENT_MAX_TURNS", 80),
    maxUsd: num("AGENT_MAX_USD", 5),
  },

  worker: {
    concurrency: num("WORKER_CONCURRENCY", 2),
    id: optional("WORKER_ID", `local-${process.pid}`),
    tokenBudget: num("TASK_TOKEN_BUDGET", 2_000_000),
    wallclockSeconds: num("TASK_WALLCLOCK_SECONDS", 1800),
    heartbeatIntervalMs: num("WORKER_HEARTBEAT_MS", 30_000),
    pollIntervalMs: num("WORKER_POLL_MS", 2_000),
    staleClaimSeconds: num("WORKER_STALE_CLAIM_SECONDS", 300),
    dailyUsdCap: num("FLEET_DAILY_USD_CAP", 50),
  },

  security: {
    allowUnsignedWebhooks:
      optional("FLEET_ALLOW_UNSIGNED_WEBHOOKS", "0") === "1",
  },
} as const;

export type Config = typeof config;
