# Fleet — Project Brief

A dense reference for picking the project back up. If you're an LLM
loaded fresh into this repo, read this end-to-end before touching
anything; it's the cliff-notes summary of decisions that aren't
recoverable from the code alone.

## What it is

Fleet is an orchestrator that turns Linear tickets into GitHub pull
requests autonomously. The owner files a ticket, labels it
`agent-ready`, and an agent picks it up, works in an isolated git
worktree, and opens a PR. The owner is the release manager — agents
never merge. The hard guarantee ("nothing reaches `main` without
approval") is enforced by GitHub branch protection, not by trust in
the orchestrator.

## Why it exists

The owner wants to file work in Linear and review PRs in GitHub —
nothing in between. The product is the loop that connects them.

Goals (in priority order):

1. **Safe by default.** A bug in the orchestrator must not be able to
   merge code to `main`. GitHub-side enforcement is load-bearing.
2. **Observable from Linear.** When a ticket fails, the comment on
   the ticket has enough context to triage without opening a CLI.
3. **Cheap to leave running.** Per-task and per-fleet budgets so a
   runaway prompt loop can't burn the bill.
4. **Single repo for v1, but shaped for multi-repo from day 1.** No
   second-system rewrite when the second repo lands.

Non-goals for now: PR review iteration, cross-task memory, multi-repo
trigger routing, native Linear Agent API integration. Each has a
clearly identified extension point — see "Extension points" below.

## Architecture decisions

These are decided. Treat as constraints, not preferences.

| Decision | Why | Alternatives rejected |
|---|---|---|
| **Custom orchestrator + Claude Agent SDK** | Maximum control over the loop; no vendor lock-in | Devin, Cursor background agents, Copilot coding agent — they each take over the workflow |
| **Local git worktrees on a dedicated machine** | Cheap, simple, fast cold-starts; concurrency naturally bounded by host | E2B/Daytona/Modal microVMs (per-session-hour cost), Codespaces (slow start) |
| **Postgres job queue with `FOR UPDATE SKIP LOCKED`** | One less moving part; scales to many concurrent workers and machines | Redis/BullMQ, Inngest, Trigger.dev, Temporal |
| **Trigger: label-gated webhook** | Working PR-bot in days; the human triage gate before the agent burns cycles | Linear Agent API (Developer Preview as of Mar 2026; nicer UX but more surface to learn). Adapter is an interface — swap is a single file |
| **TypeScript on Node 22, pnpm, tsx** | The Claude Agent SDK has a first-class TS surface; tsx avoids a build step in dev | Bun (not installed locally); plain JS (gives up types) |
| **No build step** | `tsc` runs in `--noEmit` mode for typecheck only; tsx executes `.ts` directly | A `dist/` build pipeline — unnecessary complexity for a single-host service |

## Top-level flow

```
Linear ─webhook──▶ src/webhook/server.ts ─enqueue──▶ Postgres tasks
                                                          │
                                                          ▼
                                       src/worker/pool.ts (N workers)
                                                          │
                                                          ▼
                            src/worker/runTask.ts: one task end-to-end
                                  │
                                  ├──▶ src/repos/registry.ts (resolveRepo)
                                  ├──▶ src/worktree/manager.ts (createWorktree)
                                  ├──▶ src/agent/runner.ts (Claude Agent SDK)
                                  ├──▶ src/github/pr.ts (createPullRequest)
                                  └──▶ src/linear/webhookAdapter.ts (notify*)
```

Step-by-step (file:function references):

1. **Webhook arrives.** `src/webhook/server.ts:buildApp` verifies
   HMAC via `src/webhook/verify.ts:verifyLinearSignature`, filters
   by event type and label, calls `src/queue/claim.ts:enqueue`.
2. **Enqueue is idempotent.** `linear_issue_id` is unique;
   `on conflict do nothing` makes redeliveries no-ops.
3. **Worker claims.** `src/worker/pool.ts:runOneWorker` loops:
   `checkDailyBudget` → `claimNext` (`SELECT FOR UPDATE SKIP LOCKED`)
   → `runTask`. Heartbeat updates run on a 30s timer.
4. **runTask executes a single task.**
   `src/worker/runTask.ts:runTask`:
   - `markRunning`
   - `linear.notifyStarted`
   - `createWorktree` from `origin/main`, branch
     `agent/<linear-id>-<slug>`
   - `runAgent` with a wallclock-bounded `AbortController`
   - `recordCost`
   - `hasNewCommits` and `branchPushed` sanity checks
   - `createPullRequest` (or `findOpenPrForBranch` if the agent
     somehow opened it — fallback path)
   - `markPrOpen`, `linear.notifyPrOpened`, `markDone`,
     `linear.notifyDone`
   - `removeWorktree` on success; left in place on failure
5. **Agent runs in the worktree.** `src/agent/runner.ts:runAgent`
   calls `query()` from the Claude Agent SDK with:
   - `cwd = worktreeDir`
   - System prompt: `buildSystemPrompt` (fleet rules + repo
     `CLAUDE.md` if present)
   - User prompt: `buildUserPrompt` (Linear title/body, branch name,
     instructions to push but not open PR)
   - `tools = ENABLED_TOOLS` (`Read`, `Edit`, `Write`, `Bash`,
     `Grep`, `Glob`)
   - `permissionMode = 'bypassPermissions'` +
     `allowDangerouslySkipPermissions: true` — combined with
     `canUseTool` that runs every Bash command through
     `inspectBashCommand`
   - `maxTurns`, `maxBudgetUsd`, `taskBudget`
   - `persistSession: false` (no `~/.claude/projects/` writes; the
     authoritative transcript is `task_events` in Postgres)
   - Streams `assistant` / `user` / `result` messages; persists
     each as a row in `task_events`
6. **PR opens.** `src/github/pr.ts:createPullRequest` shells out to
   `gh pr create` with title `<IDENT>: <title>` and a body that
   includes a Linear back-link.
7. **Failure path.** `src/queue/diagnostics.ts:buildDiagnostics`
   pulls the last 60 events, pairs each `tool_call` with the
   following `tool_result`, captures the agent's last assistant text;
   `src/linear/webhookAdapter.ts:formatFailure` formats this as a
   Linear comment.

## Data model

Three tables — see `migrations/0001_init.sql` and `0002_cost.sql`.

**`tasks`** — one row per Linear ticket the fleet has seen.
- `id uuid` — internal task ID; UUID, used everywhere
- `linear_issue_id text unique` — dedup key
- `linear_issue_identifier` — e.g. `ENG-123`, used in branch names
- `title`, `body` — copied from the Linear issue at enqueue time
- `repo` — slug; FK into `repos`
- `branch_name`, `pr_url`
- `status` — `pending | claimed | running | pr_open | done | failed | cancelled`
- `claimed_by`, `claimed_at`, `heartbeat_at` — for stale-claim recovery
- `cost_usd numeric(10,4)` — accumulated agent cost
- `attempt_count`, `budget_*_remaining`, `error`
- `created_at`, `updated_at` (trigger keeps `updated_at` fresh)

**`task_events`** — append-only timeline. The authoritative
transcript and the source of failure diagnostics. Types observed:
`status_change`, `branch_assigned`, `worktree_created`, `tool_call`,
`tool_result`, `tool_call_denied`, `agent_message` (with `kind:
'user_prompt' | 'text'`), `agent_result`, `agent_error`.

**`repos`** — repo registry. Seeded from env on the first migrate via
`ensureDefaultRepo()`, but designed to be edited directly when
multi-repo lands.
- `slug` (PK), `github_full_name`, `default_branch`, `workdir`,
  `config jsonb` (currently holds `worktreeRoot`)

## Safety mechanisms — where each lives

| Mechanism | File | Notes |
|---|---|---|
| HMAC webhook verify | `src/webhook/verify.ts` | Boot-time check in `src/bin/serve.ts`; refuses to start without a secret unless `FLEET_ALLOW_UNSIGNED_WEBHOOKS=1` |
| Idempotent enqueue | `src/queue/claim.ts:enqueue` | `linear_issue_id` unique + `on conflict do nothing` |
| Bash allowlist | `src/agent/bashAllowlist.ts:inspectBashCommand` | Plugged into `canUseTool` in `src/agent/runner.ts` |
| Branch / `.github/` rules | `src/agent/systemPrompt.ts` (advisory) + GitHub CODEOWNERS (enforced) | Fleet rules in the system prompt are reminders; the real lock is server-side |
| Per-task wallclock | `src/worker/runTask.ts` | `AbortController` passed to `runAgent` |
| Per-task USD/turns | `src/agent/runner.ts` | `maxBudgetUsd`, `maxTurns` options to `query()` |
| Daily fleet USD cap | `src/queue/budget.ts:checkDailyBudget` | Checked before each claim in `src/worker/pool.ts` |
| Stale-claim recovery | `src/queue/claim.ts:claimNext` | Heartbeat-based; threshold from `WORKER_STALE_CLAIM_SECONDS` |
| Worktree isolation | `src/worktree/manager.ts:createWorktree` | Cleans up any prior worktree at the path before creating |
| Two-stage SIGTERM drain | `src/worker/pool.ts:runPool` | First signal stops claiming; second aborts in-flight |
| Branch protection (the real one) | GitHub | Configured per-repo, not in this codebase |

## Extension points

When the next thing lands, here's where it goes.

- **Linear Agent API** — `src/linear/agentApiAdapter.ts` is a stub
  implementing the same `LinearAdapter` interface as `webhookAdapter`.
  Implement the methods (using AgentSession + AgentActivity), then
  switch `src/bin/worker.ts` to import `agentApiAdapter` instead.
  Nothing else changes.
- **Multi-repo** — `repos` table is already populated, and
  `src/repos/registry.ts:resolveRepo` resolves a repo per task. The
  remaining work: pick which repo a Linear ticket targets and write
  it into `tasks.repo` at enqueue time. Options: a label prefix
  (`repo:foo`), a Linear custom field, or a project-to-repo mapping.
  The webhook handler is the place to do this routing — see
  `src/webhook/server.ts`.
- **PR review iteration** — listen for GitHub
  `pull_request_review` webhooks; on a non-approving review, re-open
  the task in `pending` with the review thread appended to the user
  prompt. The agent runner is already idempotent on rerun (worktree
  manager handles cleanup of prior attempts).
- **Cross-task memory** — could add a `fleet_memory` table the agent
  edits via a custom MCP tool, or a per-repo memory file the system
  prompt loader reads.
- **Per-repo overrides** — `repos.config jsonb` is the place. Today
  it only stores `worktreeRoot`; add fields like `testCommand`,
  `lintCommand`, model overrides, and have `runAgent` read them.

## What's *not* built (and was deliberately deferred)

- The Linear Agent API adapter — only a stub
- Multi-repo trigger routing
- PR review iteration
- Cross-task memory
- A web admin UI (CLI is sufficient for solo operation)
- Process supervisor config (`pm2`/`launchd`/`systemd` is documented
  in the README but not provided)
- A real CI pipeline for *this* repo (the fleet itself); local `pnpm
  typecheck` + `pnpm test` is the only gate today

## Tech stack — hard facts

- Node 22, pnpm 10, TypeScript 5.7+, Hono 4 (`@hono/node-server`),
  `pg` 8, `@anthropic-ai/claude-agent-sdk` ^0.2 (subprocess-based;
  spawns Claude Code under the hood), `dotenv`, `tsx`
- Postgres 14+ (uses `gen_random_uuid()`, `pgcrypto`, jsonb,
  `FOR UPDATE SKIP LOCKED`)
- macOS dev (Postgres via Homebrew); Linux ops should be fine, not
  tested
- Tests: `node --test` with `tsx` import hook; deterministic units
  only — DB and SDK are not mocked, those need a live env
- Typecheck: `tsc` in `--noEmit` mode (`allowImportingTsExtensions:
  true`); `pnpm typecheck` is the gate

## Operating posture

- The fleet is **single-tenant**. There's no auth on the admin CLI
  (it talks to Postgres directly). Don't expose the webhook port
  without a tunnel + signature.
- Logs go to stdout. No structured logging yet; if you add it,
  preserve the existing prefix style (`[serve]`, `[pool]`,
  `[<worker-id>#<n>]`).
- Costs are persisted as `cost_usd` per task. `pnpm admin stats`
  is the dashboard.
- The receiver and worker are **separate processes** by design — the
  receiver is stateless and ought to scale horizontally if it ever
  needs to; workers are pinned to a host with the repo cloned at
  `REPO_PATH`.

## Common follow-up tasks for the next contributor

If you're picking this up and want a useful first PR:

- **Add `pnpm admin repo add owner/name --path /local/path`** to
  populate the `repos` table without env vars. The schema already
  supports it; `src/bin/admin.ts` is where it lands.
- **Write an integration test** that spins up Postgres in a Docker
  container, runs `migrate`, posts a synthetic Linear webhook, and
  asserts a row appears with `status='pending'`. The deterministic
  units we have don't cover the wiring.
- **Add a `pull_request.closed` GitHub webhook** so that when you
  merge a PR, the corresponding Linear ticket is auto-transitioned
  to "Done". This is genuine quality-of-life and trivial to wire.
- **Replace the `webhookAdapter` with a real Linear Agent API
  implementation.** The adapter interface is already shaped for it;
  the test harness (`webhookAdapter.test.ts:formatFailure`) shows
  what shape the failure comments should take.

## Glossary

- **Task**: one Linear ticket the fleet is processing. Has a row in
  `tasks` and a stream of rows in `task_events`.
- **Worker**: a goroutine-style loop inside `src/worker/pool.ts`
  that claims and runs one task at a time. There are
  `WORKER_CONCURRENCY` of them per process.
- **Worktree**: a git working tree separate from the main checkout,
  on its own branch. Created per task. See `git-worktree(1)`.
- **Heartbeat**: a periodic update of `tasks.heartbeat_at` so that
  if the worker dies, another worker knows the claim is stale and
  recovers it.
- **Drain**: the state after the first SIGTERM/SIGINT — workers
  finish in-flight tasks and exit.
- **Linear adapter**: the interface in `src/linear/adapter.ts` that
  the orchestrator uses to talk to Linear, regardless of whether the
  underlying mechanism is a webhook + GraphQL comment or the Linear
  Agent API.
