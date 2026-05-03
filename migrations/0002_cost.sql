alter table tasks
  add column if not exists cost_usd numeric(10,4) not null default 0;

create index if not exists tasks_done_created_at_idx
  on tasks (created_at)
  where status in ('pr_open','done','failed');
