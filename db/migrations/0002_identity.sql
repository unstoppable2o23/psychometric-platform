-- 0002_identity.sql
-- Organizations, profiles, classes, students.
--
-- `profiles.id` references auth.users(id) on Supabase. Local PGlite runs apply
-- db/dev/auth-shim.sql first, which provides a stand-in auth.users.

create table organizations (
  id              uuid primary key default gen_random_uuid(),
  name            text        not null,
  slug            text        not null unique,
  kind            app.org_kind not null default 'school',
  contact_email   text,
  contact_phone   text,
  city            text,
  state           text,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table organizations is 'A school or individual customer. Owns students, credits, and assignments.';

create table profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  role            app.user_role not null,
  display_name    text,
  email           text,
  organization_id uuid references organizations (id) on delete set null,
  grade           int check (grade between 1 and 12),
  phone           text,
  is_active       boolean     not null default true,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index profiles_org_idx on profiles (organization_id);
create index profiles_role_idx on profiles (role) where is_active;

-- Explicit membership table for staff, so one person can sit in more than one
-- org and carry different permissions in each.
create table organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations (id) on delete cascade,
  user_id         uuid        not null references profiles (id) on delete cascade,
  role_in_org     app.org_member_role not null default 'teacher',
  created_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index organization_members_user_idx on organization_members (user_id);

create table classes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations (id) on delete cascade,
  name            text        not null,
  grade           int check (grade between 1 and 12),
  academic_year   text,
  created_at      timestamptz not null default now(),
  unique (organization_id, name)
);

create index classes_org_idx on classes (organization_id);

-- A student record is created at purchase/assignment time and does NOT require a
-- login. `user_id` is filled in later if the student claims their account through
-- the emailed link. Keeping the two separate lets a school assign assessments
-- before students have ever visited the site.
create table students (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references organizations (id) on delete cascade,
  class_id        uuid        references classes (id) on delete set null,
  user_id         uuid        references profiles (id) on delete set null,
  display_name    text        not null,
  grade           int check (grade between 1 and 12),
  external_ref    text,
  guardian_email  text,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, external_ref)
);

create index students_org_idx on students (organization_id) where is_active;
create index students_user_idx on students (user_id) where user_id is not null;
create index students_class_idx on students (class_id);

create trigger profiles_touch      before update on profiles      for each row execute function app.touch_updated_at();
create trigger organizations_touch before update on organizations for each row execute function app.touch_updated_at();
create trigger students_touch      before update on students      for each row execute function app.touch_updated_at();
