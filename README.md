# Fleet

Autonomous developer agents driven by Linear tickets. A label on a Linear
issue dispatches a Claude Agent SDK session, which works in an isolated git
worktree and opens a PR on GitHub. Branch protection enforces that nothing
merges to `main` without human approval.

## Status

Weekend 3 — hardened. The agent loop runs unattended with: per-task
USD/wallclock budgets, a fleet-wide rolling 24h spend cap that pauses
claims, mandatory Linear webhook signing, graceful SIGTERM drain (only
*next* claim is blocked; in-flight tasks finish), and failure
diagnostics that show up in the Linear comment without needing the
admin CLI.

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

The target repo must be cloned to `REPO_PATH` (e.g.
`~/fleet-repos/myrepo`). Worktrees are placed in
`~/fleet-repos/myrepo-worktrees/<task-id>`. The user running the worker
must have an authenticated `gh` (`gh auth status`) and SSH/HTTPS push
credentials for the repo.

Point a Linear webhook at `http://<host>:8787/linear/webhook`. Apply the
`agent-ready` label to an issue and the worker will pick it up.

## GitHub side: branch protection (do this once per repo)

The fleet relies entirely on GitHub for the "no merge to main without
approval" guarantee. On the target repo:

1. **Branch ruleset** on `main`:
   - Require a pull request before merging
   - Require 1 approving review
   - **Dismiss stale approvals on push** (so the agent can't sneak
     commits past your approval)
   - Require status checks to pass: lint, typecheck, test, build —
     whatever the repo has
   - Require linear history (optional, but cleaner)
2. **CODEOWNERS** at `.github/CODEOWNERS` listing yourself as the owner
   of `.github/**` and other sensitive paths so the agent's edits there
   require your review by definition.
3. **Auto-merge** enabled at the repo level so once you approve and
   checks pass, GitHub merges without you clicking again.
4. **Dedicated GitHub App or machine user** for agent commits: gives
   the fleet a clear identity in `git log` and lets you scope it down.
   Auth `gh` on the worker box as that identity.

## Operations

```bash
pnpm admin list             # recent tasks (status + cost + title)
pnpm admin list failed      # filter by status
pnpm admin logs <id>        # pretty event timeline for a task
pnpm admin show <id>        # raw task row + raw events (JSON)
pnpm admin stats            # counts by status, 24h spend, last 7 days
pnpm admin cancel <id>      # mark a task cancelled
pnpm admin retry <id>       # re-queue a failed/cancelled task
```

Send `SIGTERM` to drain (workers stop claiming; in-flight tasks finish).
`Ctrl-C` twice aborts in-flight work too.
