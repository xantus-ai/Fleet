create extension if not exists "pgcrypto";

create table if not exists repos (
  slug              text primary key,
  github_full_name  text not null,
  default_branch    text not null default 'main',
  workdir           text not null,
  config            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create table if not exists tasks (
  id                       uuid primary key default gen_random_uuid(),
  linear_issue_id          text not null unique,
  linear_issue_identifier  text,
  title                    text not null,
  body                     text,
  repo                     text references repos(slug),
  branch_name              text,
  status                   text not null default 'pending'
                           check (status in ('pending','claimed','running','pr_open','done','failed','cancelled')),
  claimed_by               text,
  claimed_at               timestamptz,
  heartbeat_at             timestamptz,
  pr_url                   text,
  error                    text,
  attempt_count            int not null default 0,
  budget_tokens_remaining  bigint,
  budget_seconds_remaining int,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists tasks_status_created_at_idx
  on tasks (status, created_at)
  where status in ('pending','claimed');

create table if not exists task_events (
  id          bigserial primary key,
  task_id     uuid not null references tasks(id) on delete cascade,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists task_events_task_id_id_idx
  on task_events (task_id, id);

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_set_updated_at on tasks;
create trigger tasks_set_updated_at
before update on tasks
for each row execute function set_updated_at();
