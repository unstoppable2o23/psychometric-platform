-- 0006_audit_and_notifications.sql

create table audit_logs (
  id          bigserial primary key,
  actor_id    uuid references profiles (id) on delete set null,
  actor_role  app.user_role,
  action      text        not null,
  entity_type text        not null,
  entity_id   text,
  metadata    jsonb       not null default '{}'::jsonb,
  ip          inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);

comment on table audit_logs is
  'Append-only record of privileged actions. actor_id is null for system actions.';

create index audit_logs_created_idx on audit_logs (created_at desc);
create index audit_logs_entity_idx  on audit_logs (entity_type, entity_id);
create index audit_logs_actor_idx   on audit_logs (actor_id, created_at desc);

-- Audit rows must never be edited or removed, including by a direct SQL session.
create trigger audit_logs_immutable
  before update or delete on audit_logs
  for each row execute function app.reject_mutation();

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references profiles (id) on delete cascade,
  channel     text        not null default 'email',
  subject     text        not null,
  body        text        not null,
  status      text        not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts    int         not null default 0,
  error       text,
  scheduled_at timestamptz not null default now(),
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index notifications_queue_idx on notifications (status, scheduled_at) where status = 'queued';
create index notifications_user_idx  on notifications (user_id, created_at desc);
