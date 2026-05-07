create table if not exists task_dependencies (
  task_id          uuid not null references tasks(id) on delete cascade,
  blocker_task_id  uuid not null references tasks(id) on delete cascade,
  created_at       timestamptz not null default now(),
  primary key (task_id, blocker_task_id),
  check (task_id <> blocker_task_id)
);

create index if not exists task_dependencies_blocker_idx
  on task_dependencies (blocker_task_id);
