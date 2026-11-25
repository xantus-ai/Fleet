# Fleet backlog

Open items for the orchestrator itself (this repo). Linear is for
target-repo tickets that the fleet *executes*; this file is for
fleet-the-tool work that the operator does. Order is not strict
priority — pick whatever moves the needle.

---

## Cost-optimization follow-ups

These were surfaced after wiring up prompt caching in `src/agent/runner.ts`.
Caching is the biggest lever and is already in; these are progressively
smaller wins.

### 1. Lower `AGENT_MAX_TURNS` default

- **Current:** 80 turns (`src/config.ts:53`).
- **Why:** Most tasks finish in 20–40 turns; 80 is a runaway safety cap,
  not a typical budget. Lowering to ~50 tightens the worst-case bill
  without affecting healthy runs. Trivially reverted via env var if a
  single ticket needs more headroom.
- **Scope:** one-line change in `src/config.ts`; update `.env.example`
  and the README's configuration table to reflect the new default.

### 2. Lower per-task `AGENT_MAX_USD` default

- **Current:** $5 (`src/config.ts:54`).
- **Why:** Combined with caching, $2–3 is enough for the typical Sonnet
  4.6 task. The cap is per-task, not per-fleet — `FLEET_DAILY_USD_CAP`
  is the fleet-wide ceiling. Cheap belt-and-suspenders against a single
  task that loops on a flaky test.
- **Scope:** one-line change + docs.

### 3. Per-ticket model override (route simple tasks to Haiku)

- **Why:** Schema migrations and pure refactors (e.g. adding a column, renaming a helper)
  don't need Sonnet. Haiku 4.5 is roughly 5× cheaper. Routing tickets
  to a smaller model when the work is mechanical would cut average
  cost meaningfully.
- **Shape:** add a `model` column to `tasks`, default null. The webhook
  reads a Linear label like `model:haiku` (or a per-team config) and
  populates it. `runner.ts` uses `task.model ?? config.agent.model`.
- **Risk:** Haiku doesn't reliably handle complex code edits — picking
  the wrong tier wastes a turn budget worse than just running Sonnet.
  Start with an explicit opt-in label, not auto-classification.
- **Scope:** ~2 hours. New migration, webhook label parsing, runner
  plumbing, admin CLI flag for retries with a different model.

### 4. Tool-result truncation review

- **Why:** Bash output (`pnpm test`, `tsc --noEmit`) can be 10KB+ per
  invocation, multiplied across turns. The SDK already truncates, but
  worth confirming what it does and whether tightening helps without
  starving the agent of debugging signal.
- **Scope:** investigation first. Inspect `task_events` rows of type
  `tool_result` for the largest summaries. If a tool routinely returns
  multi-KB output that the agent only needs the tail of, consider a
  pre-summarization step before the result enters the conversation.
- **Risk:** truncating too aggressively breaks the agent's ability to
  diagnose test failures.
- **Scope:** ~1 hour for the audit, more if a fix is warranted.

---

## How to use this file

- Add items as they come up; remove or strike through when done.
- Keep entries terse: title, *why*, *scope/risk*. The codebase
  documents the *what*.
- Don't migrate this to Linear — Linear is for target-repo work that
  fleet agents pick up. Fleet-on-fleet work happens in the operator's
  own editor.
