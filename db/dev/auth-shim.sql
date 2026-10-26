-- LOCAL DEV ONLY. Not part of the production migration set.
--
-- PGlite has no Supabase Auth service, so this provides a minimal stand-in for
-- the `auth` schema that 0002_identity.sql references. It lets the real
-- migration files run unmodified on a developer's machine, which is the point:
-- if a migration only works against PGlite it is not actually verified.
--
-- On Supabase this file must never be applied -- auth.users already exists and
-- is owned by GoTrue.

create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  created_at         timestamptz not null default now(),
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- GoTrue-compatible helper, so policies written for Supabase keep working.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
