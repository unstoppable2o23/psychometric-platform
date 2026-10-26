-- 0001_foundation.sql
-- Shared types, helpers, and trigger plumbing.
-- Targets Supabase Postgres. Runs unmodified against PGlite (PG 17) for local dev.

create schema if not exists app;

-- gen_random_uuid() is core from PG13 onward, so no extension is required.
-- This matters: PGlite does not ship pgcrypto, and requiring it would mean the
-- migrations were never actually verified against a real Postgres.

-- ---------------------------------------------------------------------------
-- Enumerations. Kept as native enums so invalid states are impossible.
-- ---------------------------------------------------------------------------
create type app.user_role          as enum ('student', 'teacher', 'admin');
create type app.org_kind           as enum ('school', 'individual');
create type app.org_member_role    as enum ('owner', 'admin', 'teacher');
create type app.version_status     as enum ('draft', 'published', 'retired');
create type app.dimension_kind     as enum ('aptitude', 'interest');
create type app.question_type      as enum ('likert', 'single_choice', 'multi_select');
create type app.session_status     as enum ('in_progress', 'submitted', 'expired');
create type app.assignment_status  as enum ('assigned', 'in_progress', 'completed', 'expired', 'revoked');
create type app.report_status      as enum ('pending', 'generating', 'ready', 'failed');
create type app.order_status       as enum ('created', 'paid', 'failed', 'refunded');
create type app.payment_status     as enum ('created', 'authorized', 'captured', 'failed', 'refunded');
create type app.discount_kind      as enum ('percent', 'fixed');
create type app.profile_kind       as enum ('stream', 'branch', 'career');

-- ---------------------------------------------------------------------------
-- Generic updated_at trigger.
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Immutable-row guard.
--
-- Answers, computed scores, and version definitions must never change after a
-- student has seen them, otherwise a report could be re-derived from different
-- inputs than the ones the student was shown. This trigger enforces that at the
-- database level rather than trusting application code.
-- ---------------------------------------------------------------------------
create or replace function app.reject_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'row in %.% is immutable and cannot be updated', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

create or replace function app.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'row in %.% is immutable: % is not permitted', tg_table_schema, tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- ---------------------------------------------------------------------------
-- Request-scoped settings.
--
-- The application pool sets these per transaction before touching RLS-protected
-- tables, so policies can reason about "who is asking" even when the connection
-- itself is a pooled service connection.
-- ---------------------------------------------------------------------------
create or replace function app.set_request_context(
  p_user_id  uuid,
  p_role     app.user_role,
  p_org_id   uuid
)
returns void
language sql
as $$
  select set_config('app.user_id', coalesce(p_user_id::text, ''), true),
         set_config('app.role',    coalesce(p_role::text, ''),    true),
         set_config('app.org_id',  coalesce(p_org_id::text, ''),  true);
$$;

create or replace function app.current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

create or replace function app.current_role()
returns app.user_role
language sql
stable
as $$
  select nullif(current_setting('app.role', true), '')::app.user_role;
$$;

create or replace function app.current_org_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.org_id', true), '')::uuid;
$$;

create or replace function app.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(app.current_role() = 'admin', false);
$$;

create or replace function app.in_org(p_org_id uuid)
returns boolean
language sql
stable
as $$
  select p_org_id is not null and p_org_id = app.current_org_id();
$$;
