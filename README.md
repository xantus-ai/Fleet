# Fleet

An autonomous developer-agent orchestrator. You file Linear tickets;
the fleet picks them up, implements the change in a sandboxed git
worktree, and opens a pull request on GitHub. You review and merge.

The agents never touch `main` directly — that's enforced by GitHub
branch protection, not by trust. Your role is release manager.

```
Linear ─webhook──▶ Receiver ─enqueue──▶ Postgres (job queue)
                                              │
                                              ▼
                                       Worker pool ──▶ Worktree mgr ──▶ Agent (Claude Agent SDK)
                                              │                              │
                                              ▼                              ▼
                                         Linear adapter ◀──comments── gh pr create
                                              │
                                              ▼
                                         GitHub (branch protection enforces approval)
```

## Table of contents

- [What it does](#what-it-does)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Setting up the target repo on GitHub](#setting-up-the-target-repo-on-github)
- [Setting up Linear](#setting-up-linear)
- [Running it](#running-it)
- [Day-to-day operations](#day-to-day-operations)
- [Configuration reference](#configuration-reference)
- [Safety model](#safety-model)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)

## What it does

1. You create a Linear ticket and add the `agent-ready` label.
2. Linear sends a signed webhook to the fleet's HTTP receiver.
3. The receiver inserts a row into Postgres (deduplicated by Linear
   issue ID — webhook redeliveries don't double-run).
4. A worker pool claims the task using `SELECT FOR UPDATE SKIP LOCKED`
   so any number of workers on any number of machines can run safely
   in parallel.
5. The worker creates a fresh git worktree on a new branch
   (`agent/<linear-id>-<slug>`) off the latest `main`.
6. The Claude Agent SDK runs in that worktree. The agent reads the
   ticket, implements the change, runs the project's tests and linter,
   commits, and pushes the branch.
7. The orchestrator runs `gh pr create` with a back-link to the Linear
   ticket and posts the PR URL as a comment on the ticket.
8. You review the PR. Branch protection blocks the merge until you
   approve and required checks pass. Once approved, GitHub auto-merges.
9. The worktree is torn down on success; on failure it's left for
   inspection and a structured diagnostic comment is posted to Linear
   with the agent's last assistant message and last few tool calls.

Throughout the run the agent maintains three audit files in a
per-project directory **outside the worktree** (so they can never be
committed): `plan.md` written before work starts, `progress.md`
ticked off as the agent goes, and `overview.md` written at the end.
The fleet refuses to open a PR if `overview.md` is left as the
template — that's how "all PRs are annotated" is enforced.

## Prerequisites

- **macOS or Linux** (the worker is a long-running local process; this
  hasn't been tested on Windows)
- **Node 22+** and **pnpm 10+**
- **PostgreSQL 14+** — easiest via the bundled `docker-compose.yml`
  (needs Docker / Docker Desktop / OrbStack). A local install works
  too (`brew install postgresql@14`), as does any Postgres reachable
  via `DATABASE_URL`.
- **Git 2.30+** (for `git worktree`)
- **`gh` CLI** authenticated for the GitHub identity that should own
  the PRs (`gh auth status` should show you're logged in)
- An **Anthropic API key** with access to the model you want the agents
  to use (`AGENT_MODEL`, defaults to `claude-sonnet-4-6`)
- A **Linear workspace** where you can create webhooks and an API key

## Quick start

```bash
# 1. Install
git clone https://github.com/xantus-ai/Fleet.git fleet && cd fleet
pnpm install

# 2. Postgres — pick ONE
#    a) Docker (recommended): isolates the data, no system service.
docker compose up -d
#    b) Local install via Homebrew:
#       brew services start postgresql@14 && createdb fleet

# 3. Configure
cp .env.example .env
# fill in LINEAR_WEBHOOK_SECRET, LINEAR_API_KEY, ANTHROPIC_API_KEY,
# GITHUB_DEFAULT_REPO, REPO_PATH. The default DATABASE_URL works for
# both options above.

# 4. Migrate
pnpm migrate

# 5. Point REPO_PATH at the target repo. If you don't already have it
#    cloned locally, clone it now (any path is fine):
#       git clone git@github.com:owner/myrepo.git ~/fleet-repos/myrepo
#    If you already have it, just set REPO_PATH to that path. The
#    fleet creates two siblings next to it: <repo>-worktrees/ and
#    <repo>-fleet/ — make sure that's an OK place for them.

# 6. Run (three terminals)
ngrok http 8787
pnpm serve     # webhook receiver on :8787
pnpm worker    # claims and runs tasks
```

The Docker setup binds Postgres to `127.0.0.1:5432` only and stores
data in a named volume (`fleet-postgres`). To stop it:
`docker compose down`. To wipe the database too:
`docker compose down -v`.

For Linear to reach your local receiver, expose port `8787` with a
tunnel — `cloudflared`, `ngrok`, or whatever you prefer. Set the
webhook URL in Linear to `https://<tunnel>.example.com/linear/webhook`.

## Setting up the target repo on GitHub

The fleet relies entirely on GitHub for the "no merge to `main` without
approval" guarantee. Configure these once per repo you want the fleet
to work on.

1. **Branch ruleset on `main`** (Settings → Rules → Rulesets):
   - Require a pull request before merging
   - Require **1 approving review**
   - **Dismiss stale pull request approvals when new commits are pushed**
     so the agent can't sneak commits past your approval
   - Require status checks to pass before merging — list whatever the
     repo runs (lint, typecheck, test, build)
   - Require linear history (optional, but produces a cleaner timeline)
   - Block force pushes
2. **CODEOWNERS** at `.github/CODEOWNERS`:
   ```
   /.github/      @your-username
   /CODEOWNERS    @your-username
   ```
   This pulls you in as a required reviewer on any change the agent
   tries to make to CI or CODEOWNERS itself.
3. **Auto-merge enabled** at the repo level (Settings → General →
   "Allow auto-merge"). Once you approve and checks pass, GitHub merges
   without you clicking a second button.
4. **Dedicated GitHub identity** (recommended): create a GitHub
   machine user (or App) for the fleet so its commits and PRs are
   clearly attributable. The setup below lets the bot and your
   personal account coexist on the same machine — the worker process
   uses the bot, your manual terminals keep using you.

   **a. Create the bot account** at github.com (different email — a
   `you+fleet@gmail.com` alias works), enable 2FA, and add a small
   avatar so it's visually distinct.

   **b. Invite the bot to the target repo** as a **Write**
   collaborator (Settings → Collaborators → Add people). Accept the
   invite from the bot account.

   **c. Generate a Personal Access Token.** Type matters:

   - **If the target repo is owned by a personal account** and the
     bot is a collaborator, use a **classic PAT** with the `repo`
     scope (or `public_repo` for public repos). Fine-grained PATs
     only grant access to repos the *resource owner* owns — a
     collaborator can't generate a fine-grained PAT for someone
     else's personal repo.
   - **If the target lives in a GitHub Organization**, prefer a
     **fine-grained PAT**: scope `Repository access` to just that
     repo, grant `Contents: read/write` and
     `Pull requests: read/write`, and leave `Workflows` off so the
     bot can never modify CI.

   **d. Wire the token to the *worker process only*.** Put it in
   your fleet `.env` as `GH_TOKEN=ghp_...`. The worker loads `.env`
   via dotenv and inherits it into every `git` and `gh` subprocess —
   `git push` (via `gh`'s credential helper) and `gh pr create` both
   pick it up. Your manual terminals don't load `.env`, so they
   continue to use whichever account `gh auth` has active. Keep your
   personal account active globally:

   ```bash
   gh auth login                  # log in as the bot too (kept stored)
   gh auth switch -u <you>        # but make personal the active one
   gh auth status                 # confirm both listed, you're active
   ```

   **e. Bot identity in agent commits.** Set `BOT_GIT_NAME` and
   `BOT_GIT_EMAIL` in `.env`. The worktree manager applies these
   per-worktree on creation, so every agent commit shows up under the
   bot's name and email in `git log` — making it easy to filter and
   monitor bot activity:

   ```
   BOT_GIT_NAME=Fleet Bot
   BOT_GIT_EMAIL=123456+smith-909@users.noreply.github.com
   ```

   Use the bot's GitHub noreply address (Settings → Emails on the bot
   account, after toggling "Keep my email addresses private"). That
   way commits link to the bot's profile and the bot's real email
   never lands in git history. Per-worktree config beats per-repo and
   global, so your manual commits in the cloud main checkout still
   show your personal identity. The worktree manager also disables
   commit signing inside the worktree so the agent doesn't try to
   sign with a key it doesn't have.

   **f. Verify the split:**

   ```bash
   # Personal terminal
   gh api user -q .login                         # → your username

   # What the worker sees
   GH_TOKEN=ghp_<bot-pat> gh api user -q .login  # → bot's username
   ```

   After a fleet run, `git log <branch>` in the worktree should show
   the bot as the commit author. `git log --author='Fleet Bot'` is a
   cheap way to filter for bot work across the repo.
5. **Local clone** at `REPO_PATH` (e.g. `~/fleet-repos/myrepo`).
   The fleet creates two sibling directories next to it:
   - `~/fleet-repos/myrepo-worktrees/<task-id>/` — per-task git
     worktree, torn down on success
   - `~/fleet-repos/myrepo-fleet/<branch>/` — per-task audit
     directory holding `plan.md`, `progress.md`, `overview.md`;
     **kept indefinitely** for auditing
   Both paths must be writable. Neither is in the repo, so they
   cannot be committed.

## Setting up Linear

1. **Create a label** named `agent-ready` (or whatever you set
   `LINEAR_TRIGGER_LABEL` to) in your workspace.

2. **Webhook** (Settings → API → Webhooks → New webhook):
   - **URL:** `https://<tunnel>/linear/webhook`
   - **Resource types / Data change events:** enable **Issues**
     **only**. Leave the rest off — the fleet ignores them
     (`src/webhook/server.ts` filters `payload.type === "Issue"` and
     `payload.action` ∈ `create | update`). Subscribing to extra
     resources just generates ignored deliveries you'll have to
     scroll past in the Deliveries tab.
   - **Team scope:** workspace-scoped or team-scoped both work — the
     fleet routes off the `agent-ready` label, not the team. Pick
     team-scoped if you want a smaller blast radius (only that team's
     issues can trigger runs); pick workspace-scoped if you want one
     webhook to cover everywhere.
   - Copy the **signing secret** into `LINEAR_WEBHOOK_SECRET`.

3. **API key** (Settings → API → Personal API keys → Create API key):
   - **Key name:** anything (e.g. `Fleet`).
   - **Permissions → Only select permissions:** check
     **Create comments** *only*. Leave Read, Write, Create issues,
     and Admin off. The fleet's single Linear write operation is the
     `commentCreate` GraphQL mutation
     (`src/linear/webhookAdapter.ts:13`); it never reads, lists, or
     edits issues. (If you hit a permission error on first run,
     adding **Read** is the obvious fallback — but you shouldn't
     need it.)
   - **Team access → Only select teams:** pick the team(s) whose
     issues you'll label `agent-ready`. Don't pick "All teams you
     have access to" unless you actually want the fleet reachable
     from every team — minimum-privilege keeps blast radius small.
   - Copy the generated key into `LINEAR_API_KEY` in `.env`.
   - **Identity:** comments are attributed to the user who created
     the key. If you'd rather the fleet post as a dedicated bot
     identity, create a Linear service user, add it to the relevant
     teams, and generate the key from that account instead.
   - **Dry-run mode:** if you leave `LINEAR_API_KEY` empty, the
     adapter logs comments to stdout instead of posting them
     (`src/linear/webhookAdapter.ts:47`). Useful for first-run
     testing without hitting Linear.

To kick off a run, file a ticket and add the `agent-ready` label. The
fleet only triggers on `Issue` `create`/`update` events that include
the label, so you can edit a ticket freely without re-triggering, as
long as you don't toggle the label off and back on.

**Labelling a chain of dependent tickets:** if the labelled ticket has
Linear `blocks` / `blocked-by` relations, the receiver walks the
connected component and enqueues every reachable ticket in one shot.
Each dependent task only becomes claimable once every one of its
recorded blockers has reached `done` (PR merged + closed by the fleet
orchestrator). So you can label only the highest-order ticket and let
the chain drain in order, instead of hand-labelling each one as the
previous PR merges. Requires `LINEAR_API_KEY` to be set; without it
the chain walk is skipped and only the labelled ticket is enqueued.

## Running it

Two long-running processes:

```bash
pnpm serve     # HTTP receiver, port 8787
pnpm worker    # claims tasks and runs agents
```

In production, supervise both with `pm2`, `systemd`, or `launchd` so
they restart on crash. The worker is safe to restart at any time —
heartbeats let another worker recover any task whose claim has gone
stale (5 minutes by default).

The worker handles signals gracefully:

- **First `SIGTERM` / `SIGINT`**: drain. Workers stop claiming new
  tasks; in-flight tasks run to completion.
- **Second signal**: abort in-flight tasks too.

## Day-to-day operations

```bash
pnpm admin list              # recent tasks, with cost
pnpm admin list failed       # filter by status
pnpm admin logs <task-id>    # pretty event timeline (one line per event)
pnpm admin show <task-id>    # full task row + raw events as JSON
pnpm admin stats             # counts by status, 24h spend, last 7 days
pnpm admin cancel <task-id>  # mark a task cancelled
pnpm admin retry <task-id>   # re-queue a failed/cancelled task
```

Task IDs are UUIDs, but you can usually find a task by its Linear
identifier in `admin list`. The full task ID is shown in every Linear
comment the fleet posts.

When a task fails, the Linear comment includes:

- The error message
- The agent's last assistant message (often "I tried X but the test
  was wrong, then I tried Y…")
- The last 5 tool calls with success/failure marks
- The task ID and the branch left behind for inspection

That's usually enough to triage without opening the admin CLI.

### Auditing past runs

Every task gets a directory at
`<REPO_PATH>-fleet/<branch>/` containing:

- `plan.md` — the plan the agent wrote before starting
- `progress.md` — the checklist as the agent ticked it off
- `overview.md` — the non-technical summary that was used as the
  PR description

These persist after the task completes (the worktree is removed; the
audit dir is not). Browse them with any editor; they're plain
markdown.

## Configuration reference

All configuration is via environment variables. `.env.example` is the
authoritative list; this table summarizes the load-bearing ones.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres@localhost:5432/fleet` | Postgres connection string |
| `PORT` | `8787` | Webhook receiver port |
| `LINEAR_WEBHOOK_SECRET` | — | HMAC signing secret. **Required** unless `FLEET_ALLOW_UNSIGNED_WEBHOOKS=1` |
| `LINEAR_API_KEY` | — | Posts comments back via GraphQL. If unset, comments are logged to stdout instead (dry-run mode) |
| `LINEAR_TRIGGER_LABEL` | `agent-ready` | Only issues with this label trigger a run |
| `LINEAR_STATE_IN_PROGRESS` | `In Progress` | Workflow state set on the issue when the worker picks it up. Matched case-insensitively against the issue's team states; empty disables. Requires `LINEAR_API_KEY` |
| `LINEAR_STATE_IN_REVIEW` | `In Review` | Workflow state set on the issue once the PR is opened. Same matching rules; empty disables |
| `GITHUB_DEFAULT_REPO` | — | `owner/name` — required for v1 single-repo setup |
| `REPO_PATH` | — | Absolute path to the local clone of the target repo |
| `DEFAULT_BRANCH` | `main` | Branch to base PRs against |
| `BOT_GIT_NAME` | — | Git author name applied per-worktree. When set with `BOT_GIT_EMAIL`, agent commits are attributed to the bot; the operator's normal identity continues to apply outside worktrees |
| `BOT_GIT_EMAIL` | — | Git author email applied per-worktree (paired with `BOT_GIT_NAME`). Use the bot's `…@users.noreply.github.com` so commits link to the bot's GitHub profile |
| `GH_TOKEN` | — | Bot's classic PAT. The worker loads `.env`, so its `git push` / `gh pr create` subprocesses use this; manual terminals don't load `.env` and keep using whichever account `gh auth` has active |
| `ANTHROPIC_API_KEY` | — | Required by the Claude Agent SDK |
| `AGENT_MODEL` | `claude-sonnet-4-6` | Model the agent uses |
| `AGENT_MAX_TURNS` | `80` | Hard cap on conversation turns per task |
| `AGENT_MAX_USD` | `5` | Hard USD cap per task |
| `WORKER_CONCURRENCY` | `2` | Parallel tasks per worker process |
| `WORKER_ID` | `local-<pid>` | Identifier shown in heartbeats and logs |
| `TASK_TOKEN_BUDGET` | `2000000` | Per-task token budget (informational) |
| `TASK_WALLCLOCK_SECONDS` | `1800` | Per-task wallclock cap, enforced via `AbortController` |
| `FLEET_DAILY_USD_CAP` | `50` | Rolling 24h spend cap across the entire fleet. `0` disables |
| `WORKER_SHARE_NODE_MODULES` | `1` | CoW-clone `node_modules` from the source repo into each fresh worktree (APFS clonefile / Linux reflink). Saves ~5 turns and 30-60s per task. `0` disables |
| `FLEET_ALLOW_UNSIGNED_WEBHOOKS` | `0` | Set to `1` to skip signature checks (local dev only) |

## Safety model

The fleet is built around the idea that **the production guarantees
live on the GitHub side**. The orchestrator is a coordinator; if its
defenses fail, branch protection still keeps `main` safe.

Layered defenses, in order of how much they matter:

1. **GitHub branch protection** on `main` is the only thing that
   stops a bad PR from landing. Set it up before running anything.
2. **CODEOWNERS** keeps the agent away from `.github/` and other paths
   you don't want it to touch.
3. **Bash allowlist** (`src/agent/bashAllowlist.ts`): every Bash
   invocation goes through `inspectBashCommand`. It enforces a small
   program allowlist (`git`, `gh`, `pnpm`, `npm`, `bun`, `node`,
   `tsx`, lint/test runners, harmless inspection commands), blocks
   `curl`/`wget`, command substitution, redirects to `/etc`/`/usr`,
   and `git push origin main`. It runs as a `canUseTool` callback in
   the SDK.
4. **System prompt** (`src/agent/systemPrompt.ts`) tells the agent the
   fleet rules — don't touch `.github/`, don't change dependencies
   unprompted, don't push to `main`, run tests before pushing.
5. **Per-task budgets**: wallclock (`AbortController`), USD
   (`maxBudgetUsd`), turns (`maxTurns`).
6. **Per-fleet daily spend cap**: `checkDailyBudget` pauses claims
   when the rolling 24h total exceeds `FLEET_DAILY_USD_CAP`.
7. **Webhook signature**: HMAC-SHA-256 verification of every Linear
   delivery. Receiver refuses to start without a secret unless you
   opt in to unsigned mode.
8. **Idempotent enqueue**: `linear_issue_id` is unique. Webhook
   redeliveries don't double-run a task.
9. **Stale-claim recovery**: if a worker dies, another worker
   re-claims the task after `WORKER_STALE_CLAIM_SECONDS` of missed
   heartbeats.
10. **Worktree isolation**: agents work in a fresh git worktree per
    task. On failure the worktree is left for inspection; on success
    it's torn down.

## Troubleshooting

**Webhook returns 401 `bad signature`.**
The body Linear sent doesn't match `LINEAR_WEBHOOK_SECRET`. Make sure
you're using the secret from the same webhook configuration the request
was sent through (Linear shows different secrets per webhook).

**Webhook returns `{ "ignored": true }`.**
Either the event isn't an `Issue` `create`/`update`, or the issue
doesn't carry the `agent-ready` label. Both are intentional.

**Task stays in `pending` forever.**
The worker isn't running, or the daily budget cap has paused it. Run
`pnpm admin stats` to see the rolling 24h spend.

**Task ends in `failed` with "agent produced no commits".**
The agent finished without committing — usually means it decided the
ticket was unactionable and gave up. Check `pnpm admin logs <id>` for
the agent's final message and the worktree for any unstaged changes.

**Task ends in `failed` with "agent finished but branch was not pushed".**
The agent committed but didn't push (or auth failed during push).
Check that `gh auth status` works and that the active GitHub identity
has push rights to the repo.

**Task ends in `failed` with "agent did not write overview.md".**
The agent left `overview.md` as the unmodified template (or wrote
something under 20 characters / containing the literal placeholder
text). The fleet refuses to open a PR without an overview to put in
the body. Check the agent's transcript with `pnpm admin logs <id>`;
the overview file is at `<REPO_PATH>-fleet/<branch>/overview.md`
if you want to fill it in manually before retrying.

**`gh pr create` fails with "no commits between main and ...".**
The agent committed something git considered identical to `main` (e.g.
re-applied an existing patch). The runTask check
(`hasNewCommits`) catches this earlier in most cases; if it slips
through, the diff is genuinely empty.

**`fatal: '<branch>' is already checked out at '<path>'`.**
A previous worktree at the same path wasn't cleaned up. The worktree
manager handles this on the next attempt by `git worktree remove
--force` first; if you hit this from the outside, run that manually
or delete the stale path.

**The agent edited a file you didn't want it to.**
Add the path to `.github/CODEOWNERS` so future edits require your
review. Update the system prompt
(`src/agent/systemPrompt.ts`) if the rule should be enforced fleet-wide.

## Project layout

```
src/
  bin/                       # entrypoints
    serve.ts                 # webhook receiver
    worker.ts                # worker pool
    migrate.ts               # apply SQL migrations
    admin.ts                 # CLI for ops
  config.ts                  # env loading
  webhook/
    server.ts                # Hono receiver, label gating
    verify.ts                # Linear HMAC verification
  queue/
    db.ts                    # pg pool, Task type, logEvent
    migrate.ts               # migration runner
    claim.ts                 # SKIP LOCKED claim, heartbeats, status mutators
    budget.ts                # 24h spend, daily cap check
    diagnostics.ts           # event-stream → failure context
  worker/
    pool.ts                  # N concurrent workers, drain semantics
    runTask.ts               # one task end-to-end
  worktree/
    manager.ts               # git worktree create/remove, branch naming
  agent/
    runner.ts                # Claude Agent SDK invocation
    systemPrompt.ts          # fleet rules + repo CLAUDE.md loader
    bashAllowlist.ts         # canUseTool defense
  taskRecords/
    manager.ts               # plan/progress/overview templates + read
  github/
    pr.ts                    # gh pr create wrapper (annotates body w/ overview)
  linear/
    adapter.ts               # interface
    webhookAdapter.ts        # v1: GraphQL commentCreate
    agentApiAdapter.ts       # v2 stub (Linear Agent API)
  repos/
    registry.ts              # repos table, resolveRepo()
migrations/
  0001_init.sql              # tasks, task_events, repos, triggers
  0002_cost.sql              # cost_usd column + index
```

## Roadmap

Not built yet, but the codebase is shaped for these:

- **Linear Agent API** — `src/linear/agentApiAdapter.ts` is a stub.
  Swapping `webhookAdapter` for `agentApiAdapter` gives native
  @mention triggers and a live `AgentActivity` stream in the Linear
  UI without touching the orchestrator.
- **Multi-repo** — the `repos` table and `resolveRepo()` already
  support multiple repos. Adding repo #2 means wiring the trigger
  ("which repo does this ticket target?") to populate `tasks.repo`,
  e.g. via Linear label prefix `repo:foo` or a Linear custom field.
- **PR review iteration** — when you leave review comments, a
  `pull_request_review` webhook could re-open the task with the
  review thread as context.
- **Cross-task memory** — agents currently rely on the repo's
  `CLAUDE.md` for conventions. A post-task memory file the agent can
  edit would let learnings carry across runs.

See `docs/PROJECT_BRIEF.md` for a denser architecture summary.

## License & dependencies

The orchestrator code in this repository is released under the MIT
License — see [`LICENSE`](LICENSE).

The fleet depends on the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`), which is **not** open source.
Anthropic publishes it under their own terms — see
[code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance).
You will need your own Anthropic API key to run the fleet, and your
use of that key (and of the SDK) is governed by Anthropic's
agreements, not by this repository's MIT license.

Other runtime dependencies (`hono`, `pg`, `dotenv`, etc.) are MIT or
similarly permissive — see `package.json` and the package metadata in
`pnpm-lock.yaml` for the full list.
