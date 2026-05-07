# Cross-task context for chained tickets

Status: **shipped** 2026-05-06 (originally drafted as a plan in this
same file; updated in place to serve as the canonical reference).

## What this is

When a Linear ticket is split into a chain of `agent-ready` tickets
linked by `blocks` / `blocked-by` relations, every dependent ticket's
agent run now sees the **merged context of its blockers** in the user
prompt — not just its own ticket body.

For each `done` blocker recorded in `task_dependencies`, the
dependent task's prompt includes:

- The blocker's Linear identifier + title.
- The blocker's PR URL.
- The blocker's `overview.md` text (the human-readable PR description
  the blocker's run produced).
- The blocker's original ticket body, truncated at 4000 chars if
  longer.

This means a ticket author can stop manually inlining "what ticket A
did" into ticket C's body — the fleet attaches it automatically.

## Why this exists

Before this feature, each agent run was a fresh SDK session with a
prompt built from the current ticket's title and body alone. Cross-
ticket context relied on the human ticket author duplicating it into
every dependent body (see `docs/AGENT_TICKET_GUIDE.md`'s
recommendations). That worked but was brittle: one forgotten paste
broke the chain, the author's manual restatement drifted from the
real merged artefact, and ticket bodies grew long enough to fight
the 80-turn budget the same guide enforces.

`docs/AGENT_TICKET_GUIDE.md` now directs ticket authors **not** to
inline blocker content; the fleet handles it.

## What the agent sees

When `blockers.length > 0`, `buildUserPrompt`
(`src/agent/systemPrompt.ts`) prepends a section ahead of the audit-
files block:

```
# B-IDENT: B title

…B body…

---

## Related context (already merged)

These tickets are already merged. The current code on `main` reflects
their decisions — use them to understand the **why**; verify any
specifics by reading the actual files.

### A-IDENT: A title
PR: https://github.com/owner/repo/pull/123

…A's overview.md text…

<details>
<summary>Original ticket body</summary>

…A body (possibly truncated)…

</details>

---

Your branch is `agent/...`. …(rest unchanged)
```

The framing line ("the current code on `main` reflects their
decisions") is deliberate. The intent is for the agent to use blocker
context as *background*, not as a live spec — preventing the failure
mode where it re-implements something already merged because the
body said so.

## Data flow

```
Ticket A enqueued ──► agent runs ──► PR opens ──► overview.md text
                                                  saved to
                                                  tasks.overview_text
                                                  ──► markDone
                                                          │
                                                          ▼
Ticket B claimable (claimNext blocker gate satisfied) ──► runTask:
                                                    1. read task_dependencies
                                                       for B
                                                    2. fetch blockers'
                                                       (identifier, title,
                                                        body, pr_url,
                                                        overview_text)
                                                    3. pass as `blockers[]`
                                                       to buildUserPrompt
                                                  ──► agent sees A in prompt
```

## Schema

Migration `migrations/0004_overview_text.sql`:

```sql
alter table tasks
  add column if not exists overview_text text;
```

Nullable. Populated at PR-open time from the agent's `overview.md`
file by `markPrOpen` in `src/queue/claim.ts` (using `coalesce` so a
re-run that doesn't supply text doesn't blank a previously-set value).
Tasks that predate this migration stay `NULL` forever; their
dependents don't get an overview from them, but still get title +
body + PR URL.

## Code map

| File | Role |
|---|---|
| `migrations/0004_overview_text.sql` | adds the column |
| `src/queue/db.ts` | `Task.overviewText` field + row mapping |
| `src/queue/claim.ts` | `markPrOpen(taskId, prUrl, branch, overviewText?)` persists overview text |
| `src/queue/dependencies.ts` | `BlockerContext` type + `getBlockerContext(taskId)` query |
| `src/agent/systemPrompt.ts` | `buildUserPrompt` accepts `blockers[]`, renders the "Related context" section, applies 4000-char truncation |
| `src/agent/runner.ts` | accepts `blockers` arg, forwards to `buildUserPrompt` |
| `src/worker/runTask.ts` | calls `getBlockerContext` after worktree creation, logs a `blocker_context_loaded` event, passes blockers to `runAgent`, passes overview into `markPrOpen` |
| `src/agent/systemPrompt.test.ts` | unit tests for the rendering |

`getBlockerContext` returns blockers in `task_dependencies.created_at`
order (oldest first — matches a reader's catch-up order).

## Token cost

Worst case under current ticket-guide rules (~3-4k chars body, ~500-
char overview, ~100-char header) is roughly 1.5k tokens per blocker.
Chains in practice are 2-4 deep, so ~3-6k extra prompt tokens per
chained run. Negligible against the 80-turn / $5 budget. Revisit
truncation if chains routinely exceed ~5 deep.

## What is and isn't included

| Behaviour | In | Out |
|---|---|---|
| Direct blockers (`task_dependencies` rows) | yes | |
| Transitive blockers (A → B → C: C sees A) | | no — C only sees B |
| Sibling tickets in the chain that don't block | | no |
| Blockers in status `done` | yes | |
| Blockers in `failed`, `cancelled`, `pr_open`, etc. | | no — `getBlockerContext` filters to `done` |
| Read-only injection at prompt build time | yes | |
| Agent-writable cross-task memory (`fleet_memory`) | | no — explicit non-goal in `CLAUDE.md` |
| Live Linear fetches at agent runtime | | no — all data comes from local Postgres |
| Re-triggering dependents when a blocker re-merges | | no — PR-review iteration territory, separate non-goal |

The transitive exclusion is deliberate: A's effect on C is mediated
by B (in the merged code on `main` and in B's own overview), so
including A as well inflates tokens for diminishing return. If real
chains start to suffer from C lacking A's context, revisit.

## Edge cases and behaviour

1. **Blocker has no `overview_text`.** Pre-existing tasks (predating
   migration 0004) and any task that failed before `markPrOpen` will
   be `NULL`. The blocker section renders with body only; the overview
   sub-block is omitted. No error.
2. **Blocker has no body either.** Section renders with just header
   and PR URL. The `<details>` body block is omitted entirely.
3. **Blocker has no Linear identifier.** Heading falls back to just
   the title (`### Title`).
4. **Cycle in `task_dependencies`.** Schema check on the dependency
   row prevents self-loops; multi-hop cycles aren't enforced. The
   single-hop walk in `getBlockerContext` is cycle-safe by
   construction (no recursion). If a cycle exists, `claimNext` will
   never satisfy any of those tasks' gates — they sit pending.
5. **Stale-claim retry of a chained task.** Heartbeat-based recovery
   re-runs the task in a fresh worktree. Blocker context is loaded
   fresh from the DB each run, so the retry sees the same (or newer,
   if a blocker was re-run) context.
6. **Body truncation.** Cut at 4000 chars (~1k tokens), append
   `…(truncated; see PR description for full context)`. The PR URL
   is right above so the agent can navigate the diff if it needs more.
7. **`markPrOpen` called without overview text** (e.g. during retry
   logic that doesn't re-read the file): `coalesce` preserves the
   previously-set value rather than blanking it.

## Verification

After a chained ticket runs, confirm wiring with:

- `pnpm admin show <dependent-task-id>` — the `agent_message` row of
  `kind: user_prompt` should contain the "Related context (already
  merged)" section with each blocker's identifier, PR URL, and
  overview.
- Look for the `blocker_context_loaded` event in the same task's
  event stream — it logs `count` and the blocker identifiers.
- Query the blocker's `tasks` row directly: `overview_text` should
  be non-null.

If any of those is missing, the wiring is wrong; do not assume it's
working just because the run completed.

## How to extend

A few likely next steps and where they'd land:

- **Transitive blocker context** (A → B → C: include A in C's
  prompt). Change `getBlockerContext` to do a recursive CTE walk;
  add a depth cap to bound tokens. Update the truncation strategy so
  deeper blockers get shorter excerpts.
- **Sibling context** (loosely-related tickets that don't block).
  Requires a new edge type (`task_dependencies` is strictly
  blocker→blocked) — add a `task_relations` table or a `kind` column.
- **Agent-writable cross-task memory** (`fleet_memory`). The
  long-deferred non-goal. Add a custom MCP tool wired in
  `src/agent/runner.ts` and a new table; expose at prompt build time
  alongside blocker context.
- **Per-blocker truncation tuning.** Currently a single
  `BLOCKER_BODY_MAX_CHARS = 4000` constant in `systemPrompt.ts`.
  Promote to config if chain depth makes it worth tuning.

## Related docs

- `docs/AGENT_TICKET_GUIDE.md` — the ticket-author guide that this
  feature changes the recommendations of (don't inline blocker
  content; link in Linear and trust the fleet).
- `CLAUDE.md` — the orchestrator's project instructions; the "Chained
  tasks see each other's merged context" note describes this feature
  in one paragraph.
- `docs/PROJECT_BRIEF.md` — non-goals list (cross-task **write-side**
  memory is still a non-goal; this feature is read-side only).
