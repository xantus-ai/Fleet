# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Fleet is an orchestrator that turns Linear tickets into GitHub PRs autonomously. Linear webhook → Postgres job queue → worker pool → Claude Agent SDK runs in a per-task git worktree → `gh pr create`. Owner is the release manager; agents never merge. The "nothing reaches `main` without approval" guarantee is enforced by **GitHub branch protection on the target repo**, not by trust in this code.

`README.md` covers setup and operations. `docs/PROJECT_BRIEF.md` is the dense architecture reference and the canonical list of decisions/non-goals — read it before structural changes.

## Decisions that are locked in

These were chosen deliberately and the alternatives were rejected. Don't propose swapping them as part of unrelated work — if there's a real reason to revisit, surface it explicitly.

- **Custom orchestrator + Claude Agent SDK** (not Devin / Cursor background agents / Copilot coding agent — they take over the workflow).
- **Local git worktrees on a dedicated host** (not E2B / Daytona / Modal microVMs / Codespaces — cost and cold-start).
- **Postgres job queue with `FOR UPDATE SKIP LOCKED`** (not Redis/BullMQ, Inngest, Trigger.dev, Temporal — one fewer moving part).
- **Label-gated Linear webhook** for v1 (not the Linear Agent API yet — `agentApiAdapter.ts` is a stub behind the same interface; swap is one file).
- **No build step.** `tsc --noEmit` for typecheck only; `tsx` runs `.ts` directly. Don't add a `dist/` pipeline.
- **TypeScript on Node 22, pnpm, tsx.** Not Bun, not plain JS.

## Commands

```bash
pnpm install                         # Node 22+, pnpm 10+
pnpm typecheck                       # tsc --noEmit (the type gate)
pnpm test                            # all tests
node --import tsx --test src/agent/bashAllowlist.test.ts   # single test file
pnpm migrate                         # apply migrations/*.sql against $DATABASE_URL
pnpm serve                           # webhook receiver (Hono, :8787)
pnpm worker                          # claims tasks and runs agents
pnpm admin <list|logs|show|stats|cancel|retry> [...]
```

CI (`.github/workflows/ci.yml`) runs `pnpm typecheck && pnpm test` only — there is no separate linter. Both must pass.

No build step: `tsx` executes `.ts` directly; `tsconfig.json` has `noEmit: true` and `allowImportingTsExtensions: true` (imports use `.ts` extensions).

## How tests work

- `node --test` with the `tsx` import hook (no Vitest/Jest).
- Deterministic units only — Postgres and the Claude Agent SDK are **not mocked**; tests that would need them don't exist. Don't introduce a mocking layer just to get coverage of those paths; integration is intentionally deferred (see "What's not built" in `docs/PROJECT_BRIEF.md`).
- Tests live next to source: `src/foo/bar.test.ts` next to `src/foo/bar.ts`.

## Architecture — what to read first

The end-to-end loop is in `src/worker/runTask.ts:runTask`. It is the single source of truth for task lifecycle ordering — when changing what happens during a run, change it there.

```
src/webhook/server.ts      Hono receiver, HMAC verify, label gate, enqueue,
                           chain expansion via Linear blocks-graph
src/queue/claim.ts         enqueue (idempotent on linear_issue_id),
                           claimNext (SELECT FOR UPDATE SKIP LOCKED, blocker-gated), heartbeats
src/queue/dependencies.ts  task_dependencies upsert (blocker→blocked edges)
                           and getBlockerContext (merged-blocker prompt injection)
src/queue/budget.ts        24h fleet spend cap (checked before each claim)
src/queue/diagnostics.ts   event-stream → Linear failure comment context
src/worker/pool.ts         N concurrent workers, two-stage SIGTERM drain
src/worker/runTask.ts      one task end-to-end (the orchestration spine)
src/worktree/manager.ts    git worktree create/remove, branch naming
src/agent/runner.ts        Claude Agent SDK invocation
src/agent/systemPrompt.ts  fleet rules + loads target repo's CLAUDE.md
src/agent/bashAllowlist.ts canUseTool defense — every Bash command goes here
src/taskRecords/manager.ts plan/progress/overview audit files (outside worktree)
src/github/pr.ts           gh pr create wrapper; embeds overview.md as body
src/linear/adapter.ts      LinearAdapter interface
src/linear/webhookAdapter.ts   v1 implementation (GraphQL commentCreate)
src/linear/agentApiAdapter.ts  v2 stub (Linear Agent API) — same interface
src/linear/dependencyGraph.ts  blocks/blocked-by graph walker (BFS, both directions)
src/repos/registry.ts      repos table, resolveRepo, ensureDefaultRepo
src/config.ts              env loading; this is where new env vars get parsed
```

## Things to know that aren't obvious from the code

**Audit files are outside the worktree on purpose.** `src/taskRecords/manager.ts` writes `plan.md`/`progress.md`/`overview.md` to a sibling of the worktree (`<repo>-fleet/<branch>/`). The agent gets write access via `additionalDirectories` on the SDK call. They must never live inside the worktree — that would let the agent commit them. The fleet **fails the task if `overview.md` is still the template**; that gate enforces "all PRs annotated" and is wired in `runTask.ts`'s `readOverview` call before `createPullRequest`.

**Bash allowlist is the agent's only filesystem/network constraint.** `src/agent/bashAllowlist.ts:inspectBashCommand` is plugged into `canUseTool` in `runner.ts`. The agent runs with `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`, so this allowlist is what stops it from running `curl` to arbitrary hosts or `git push origin main`. Changing it changes what the fleet can do — keep its tests passing.

**`task_events` is the authoritative transcript.** The SDK is run with `persistSession: false` so nothing is written to `~/.claude/projects/`; every assistant message, tool call, tool result, and result row is persisted to `task_events` instead. Failure diagnostics (`src/queue/diagnostics.ts`) reconstruct what happened from these rows, so don't change the event-type strings or shapes without updating diagnostics.

**Idempotency lives in the schema.** `tasks.linear_issue_id` is `unique`; `enqueue` uses `on conflict do nothing`. Webhook redeliveries don't double-run. Don't paper over this in application code.

**One label can enqueue many tasks.** When a labelled issue has `blocks`/`blocked-by` relations in Linear, `expandDependencyChain` (`src/webhook/server.ts`) walks the connected component and enqueues every reachable issue, recording blocker→blocked edges in `task_dependencies`. `claimNext` only claims a `pending` task whose every recorded blocker has reached `done`. The chain walk requires `LINEAR_API_KEY`; without it the labelled issue is enqueued alone (legacy behaviour). Errors during chain expansion are logged and swallowed — the labelled task always runs regardless.

**Chained tasks see each other's merged context.** When a task has rows in `task_dependencies`, `runTask` calls `getBlockerContext` (`src/queue/dependencies.ts`) to load each `done` blocker's identifier, title, body, PR URL, and `overview_text`, then passes them to `buildUserPrompt` which prepends a "Related context (already merged)" section to the user prompt. Single-hop only (transitive blockers excluded). The agent treats this as informational — authoritative state is the code on `main` and the current ticket body. Blocker bodies are truncated at 4000 chars. See `docs/cross-task-context.md`.

**Stale-claim recovery is heartbeat-based.** Workers update `tasks.heartbeat_at` every 30s; another worker can re-claim a task whose heartbeat has gone stale (`WORKER_STALE_CLAIM_SECONDS`, default 5 min). This is why workers are safe to kill at any time — but it's also why long-running synchronous work inside a single tick can starve heartbeats.

**SIGTERM is two-stage.** First signal → workers stop claiming, in-flight tasks finish (drain). Second signal → in-flight tasks are aborted via `AbortController`. Implemented in `src/worker/pool.ts:runPool`. Preserve this when touching shutdown.

**Multi-repo is shaped but not wired.** `repos` table + `resolveRepo` exist; the routing step ("which repo does this Linear ticket target?") is the missing piece. For v1, `ensureDefaultRepo()` seeds one row from env (`GITHUB_DEFAULT_REPO`, `REPO_PATH`). When extending, route at the webhook (`src/webhook/server.ts`) — not in the worker.

**The fleet rules in `src/agent/systemPrompt.ts` are advisory** (the agent receives them as text). The *enforced* rules are: (1) GitHub branch protection on the target repo, (2) target repo's `.github/CODEOWNERS`, (3) the bash allowlist. Treat the system prompt as documentation of intent, not a security boundary.

**`src/agent/systemPrompt.ts:buildSystemPrompt` loads the *target* repo's `CLAUDE.md`** at the path passed in, not this one. This file you're reading is for Claude Code working on the orchestrator itself; the fleet's agents read the target repo's `CLAUDE.md`.

## Schema enums worth memorizing

- `tasks.status`: `pending | claimed | running | pr_open | done | failed | cancelled`. Treat these as a state machine — `markRunning`/`markPrOpen`/`markDone` etc. in `src/queue/claim.ts` are the only legal transitions.
- `task_events.type`: `status_change | branch_assigned | worktree_created | blocker_context_loaded | task_records_created | overview_captured | tool_call | tool_result | tool_call_denied | agent_message | agent_result | agent_error`. `agent_message` rows carry a `kind` of `user_prompt | text`. `src/queue/diagnostics.ts` reconstructs failure context from these — adding a new event type means updating diagnostics too.

## Deliberately not built (don't drift into these without being asked)

`docs/PROJECT_BRIEF.md` lists these as non-goals. If a task seems to require one, raise it before implementing — the codebase has named extension points and these are not accidental gaps.

- Linear Agent API adapter (only a stub at `src/linear/agentApiAdapter.ts`).
- Multi-repo trigger routing (the `repos` table and `resolveRepo` exist; the routing decision at the webhook does not).
- PR review iteration (no `pull_request_review` listener).
- Cross-task **write-side** memory (no `fleet_memory` table the agent can write to, no per-repo memory file). Read-side merged-blocker context **is** built — see the "Chained tasks see each other's merged context" note above and `docs/cross-task-context.md`.
- Web admin UI — the `pnpm admin` CLI is sufficient for solo operation.
- Process supervisor config (pm2/systemd/launchd) — documented, not provided.
- Integration tests against real Postgres / SDK — only deterministic units exist.

## Conventions

- Logs: stdout, prefix style `[serve]`, `[pool]`, `[<worker-id>#<n>]`. No structured logging.
- New env vars are parsed in `src/config.ts` and documented in `.env.example` and the README's configuration table.
- Imports of local files use the `.ts` extension (`./foo.ts`) — required by `verbatimModuleSyntax` + `allowImportingTsExtensions`.
- Migrations are append-only SQL files in `migrations/`, numbered `NNNN_name.sql`. The runner is `src/queue/migrate.ts`; it tracks applied migrations in a `schema_migrations` table.
