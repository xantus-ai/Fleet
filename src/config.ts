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
    /**
     * Workflow state names the fleet transitions issues to. Names are
     * matched case-insensitively against the issue's team workflow
     * states. Empty string disables that transition.
     */
    stateInProgress: optional("LINEAR_STATE_IN_PROGRESS", "In Progress"),
    stateInReview: optional("LINEAR_STATE_IN_REVIEW", "In Review"),
  },

  github: {
    defaultRepo: optional("GITHUB_DEFAULT_REPO", ""),
    repoPath: optional("REPO_PATH", ""),
    defaultBranch: optional("DEFAULT_BRANCH", "main"),
  },

  /**
   * Git author identity applied inside each per-task worktree. When
   * both name and email are set, every commit the agent makes is
   * attributed to the bot — separating fleet-authored commits from
   * the operator's manual work in `git log`. When either is empty,
   * the worktree inherits the repo's normal config (= the operator's
   * identity), and bot attribution is off.
   */
  bot: {
    gitName: optional("BOT_GIT_NAME", ""),
    gitEmail: optional("BOT_GIT_EMAIL", ""),
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
    /**
     * After creating a worktree, copy every node_modules/ from the
     * source repo into the worktree using APFS clonefile (`cp -cR`)
     * on macOS or reflink (`cp --reflink=auto -R`) on Linux. Both are
     * copy-on-write — instant, zero extra disk, and writes from
     * `npm install` in the worktree don't propagate back to the main
     * checkout. Saves the agent ~5 turns and 30-60s per task by
     * skipping the cold install. Set to 0 to disable.
     */
    shareNodeModules: optional("WORKER_SHARE_NODE_MODULES", "1") === "1",
  },

  security: {
    allowUnsignedWebhooks:
      optional("FLEET_ALLOW_UNSIGNED_WEBHOOKS", "0") === "1",
  },
} as const;

export type Config = typeof config;
