-- 0008_teacher_credentials.sql
--
-- Per-teacher sign-in, maintained and disabled by the super admin.
--
-- Design:
--   * Every teacher is their own account. No shared staff login.
--   * An admin creates the account and issues a one-time activation link; the
--     teacher sets their own password, so the admin never sees or stores it.
--   * Credentials live in their own table, separate from `profiles`, so that
--     reading a person for display purposes never means reading a secret.
--   * Disabling is enforced in the database and in the session lookup, so a
--     disabled teacher is refused immediately rather than at next login.

-- ---------------------------------------------------------------------------
-- Password credentials
-- ---------------------------------------------------------------------------
-- scrypt, from Node's crypto module. Parameters are stored per row so they can
-- be raised later without invalidating existing hashes: an old hash keeps its
-- original cost and can be re-hashed on the owner's next successful sign-in.
create table auth_credentials (
  user_id           uuid primary key references profiles (id) on delete cascade,
  password_hash     text        not null,
  password_salt     text        not null,
  -- scrypt cost parameters (N, r, p)
  hash_n            int         not null default 16384,
  hash_r            int         not null default 8,
  hash_p            int         not null default 1,
  -- Bumped on every successful sign-in, invalidating sessions issued earlier.
  credential_version int        not null default 1,
  must_change_password boolean  not null default false,
  last_sign_in_at    timestamptz,
  failed_attempts    int         not null default 0,
  locked_until       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (hash_n >= 1024 and hash_r >= 1 and hash_p >= 1)
);

comment on table auth_credentials is
  'Never joined into a display query. Stores only scrypt hashes; plaintext passwords are never persisted.';

-- ---------------------------------------------------------------------------
-- Activation invitations
-- ---------------------------------------------------------------------------
-- A teacher cannot sign in until they have redeemed one of these. Like
-- assessment links, the token is stored only as a SHA-256 hash, so a database
-- leak yields no usable invite.
create table auth_invites (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references profiles (id) on delete cascade,
  token_hash  text        not null unique,
  token_hint  text        not null,
  status      text        not null default 'pending' check (status in ('pending','redeemed','revoked','expired')),
  expires_at  timestamptz not null default (now() + interval '48 hours'),
  redeemed_at timestamptz,
  created_by  uuid        references profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  -- Redemption is terminal: a spent or withdrawn link cannot be replayed.
  redeemed_by_session text
);

create index auth_invites_user_idx   on auth_invites (user_id, status);
create index auth_invites_pending_idx on auth_invites (expires_at) where status = 'pending';

-- Only one live invitation per account, so a reissued link invalidates the old.
create unique index auth_invites_one_pending_idx
  on auth_invites (user_id) where status = 'pending';

create trigger auth_credentials_touch
  before update on auth_credentials
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Enforcement: a disabled account must not hold a usable session
-- ---------------------------------------------------------------------------
-- `resolveActor` already refuses inactive profiles. This trigger closes the
-- other half: revoking a credential invalidates any session cookie already
-- issued, because the session carries a credential_version and a session whose
-- version no longer matches is rejected.
--
-- Disabling a teacher goes through app.set_teacher_enabled, which bumps
-- credential_version so live sessions die immediately.
create or replace function app.set_teacher_enabled(p_user_id uuid, p_enabled boolean)
returns void
language plpgsql
as $$
begin
  update profiles set is_active = p_enabled where id = p_user_id and role = 'teacher';
  if not found then
    raise exception 'no teacher account with id %', p_user_id using errcode = 'no_data_found';
  end if;

  -- Bumping the version invalidates every session cookie already issued.
  update auth_credentials
     set credential_version = credential_version + 1,
         failed_attempts = 0,
         locked_until = null
   where user_id = p_user_id;

  -- A disabled account must not be able to activate through an outstanding link.
  if not p_enabled then
    update auth_invites set status = 'revoked'
     where user_id = p_user_id and status = 'pending';
  end if;
end;
$$;

comment on function app.set_teacher_enabled(uuid, boolean) is
  'Enables or disables a teacher account and invalidates live sessions in one step.';
