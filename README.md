# Fleet

Autonomous developer agents driven by Linear tickets. A label on a Linear
issue dispatches a Claude Agent SDK session, which works in an isolated git
worktree and opens a PR on GitHub. Branch protection enforces that nothing
merges to `main` without human approval.

## Status

Weekend 1 — skeleton. The end-to-end loop is wired (webhook → queue →
worker) but the worker only logs the task it would run; the agent loop
lands in Weekend 2.

## Layout

```
src/
  bin/             entrypoints: serve, worker, admin, migrate
  config.ts        env loading + per-repo registry
  queue/           Postgres-backed job queue (SKIP LOCKED)
  webhook/         Linear webhook HTTP server + HMAC verify
  worker/          long-running worker pool
  worktree/        git worktree manager (Weekend 2)
  agent/           Claude Agent SDK runner (Weekend 2)
  linear/          adapter interface + v1 webhook impl + v2 stub
  github/          gh CLI helpers (Weekend 2)
migrations/        SQL migrations
```

## Local setup

```bash
pnpm install
cp .env.example .env       # fill in
createdb fleet
pnpm migrate
pnpm serve   # webhook receiver on :8787
pnpm worker  # in a second terminal
```

Point a Linear webhook at `http://<host>:8787/linear/webhook`. Apply the
`agent-ready` label to an issue and the worker will pick it up.

## Operations

```bash
pnpm admin list          # current tasks
pnpm admin show <id>     # task transcript
pnpm admin cancel <id>
pnpm admin retry <id>
```
