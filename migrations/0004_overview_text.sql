-- Persist the agent's overview.md text on the task row at PR-open
-- time. Read by getBlockerContext when a dependent task starts, so
-- the agent for ticket B can see what ticket A said it shipped.
-- Pre-existing tasks stay NULL (their dependents won't have an
-- overview to read; that's expected).
alter table tasks
  add column if not exists overview_text text;
