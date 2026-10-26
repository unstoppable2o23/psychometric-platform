-- 0003_assessment.sql
-- Assessment catalogue, versioned question bank, attempts, and results.

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
create table assessments (
  id          uuid primary key default gen_random_uuid(),
  slug        text        not null unique,
  title       text        not null,
  summary     text        not null default '',
  grade_min   int check (grade_min between 1 and 12),
  grade_max   int check (grade_max between 1 and 12),
  category    text,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (grade_max is null or grade_min is null or grade_max >= grade_min)
);

create table assessment_versions (
  id                    uuid primary key default gen_random_uuid(),
  assessment_id         uuid        not null references assessments (id) on delete cascade,
  version               int         not null check (version > 0),
  status                app.version_status not null default 'draft',
  instructions          text        not null default '',
  duration_seconds      int         not null check (duration_seconds between 60 and 21600),
  question_count        int         not null check (question_count > 0),
  -- Fraction of questions that must be answered before submission is accepted.
  min_completion_ratio  numeric(4,3) not null default 1.0 check (min_completion_ratio > 0 and min_completion_ratio <= 1),
  -- Presentation controls, kept out of scoring so they can change without
  -- invalidating historical attempts.
  randomize_question_order boolean not null default true,
  allow_flagging            boolean not null default true,
  allow_resume             boolean not null default true,
  scoring_config         jsonb       not null default '{}'::jsonb,
  published_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (assessment_id, version)
);

create index assessment_versions_published_idx
  on assessment_versions (assessment_id) where status = 'published';

comment on table assessment_versions is
  'Immutable once published. A new question edit produces version n+1 so completed attempts stay reproducible.';

-- Exactly one published version per assessment.
create unique index assessment_versions_one_published_idx
  on assessment_versions (assessment_id) where status = 'published';

create table assessment_dimensions (
  id                   uuid primary key default gen_random_uuid(),
  assessment_version_id uuid      not null references assessment_versions (id) on delete cascade,
  key                  text      not null,
  label                text      not null,
  kind                 app.dimension_kind not null,
  description          text      not null default '',
  weight               numeric(4,3) not null default 1.0 check (weight > 0),
  display_order        int       not null default 0,
  unique (assessment_version_id, key)
);

create index assessment_dimensions_version_idx on assessment_dimensions (assessment_version_id);

-- ---------------------------------------------------------------------------
-- Question bank
-- ---------------------------------------------------------------------------
create table questions (
  id                    uuid primary key default gen_random_uuid(),
  assessment_version_id uuid        not null references assessment_versions (id) on delete cascade,
  external_key          text        not null,
  dimension_key         text        not null,
  type                  app.question_type not null,
  prompt                text        not null,
  help_text             text,
  -- Items phrased negatively need their contribution flipped before aggregation.
  reverse_scored        boolean     not null default false,
  scale_labels          jsonb,
  display_order         int         not null default 0,
  is_active             boolean     not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (assessment_version_id, external_key),
  foreign key (assessment_version_id, dimension_key)
    references assessment_dimensions (assessment_version_id, key)
    on delete cascade
);

create index questions_version_active_idx on questions (assessment_version_id, display_order) where is_active;
create index questions_dimension_idx      on questions (dimension_key);

create table question_options (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid        not null references questions (id) on delete cascade,
  label        text        not null,
  -- Numeric contribution for likert items; null for choice items.
  value        numeric(6,3),
  is_correct   boolean     not null default false,
  display_order int        not null default 0,
  unique (question_id, label)
);

create index question_options_question_idx on question_options (question_id, display_order);

-- ---------------------------------------------------------------------------
-- Scoring rules
--
-- Snapshotted per version and pinned by every attempt, so a later edit to the
-- engine cannot silently change the meaning of a report that was already issued.
-- ---------------------------------------------------------------------------
create table scoring_rules (
  id                    uuid primary key default gen_random_uuid(),
  assessment_version_id uuid        not null references assessment_versions (id) on delete cascade,
  rule_version          int         not null check (rule_version > 0),
  definition            jsonb       not null,
  created_at            timestamptz not null default now(),
  unique (assessment_version_id, rule_version)
);

-- ---------------------------------------------------------------------------
-- Assignments and attempts
-- ---------------------------------------------------------------------------

-- Links are bearer credentials. Only the SHA-256 of the token is stored, so a
-- database leak does not hand out working assessment URLs. token_hint is the
-- last 4 characters and is safe to show to teachers for support purposes.
create table assessment_assignments (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid        not null references organizations (id) on delete cascade,
  student_id            uuid        not null references students (id) on delete cascade,
  assessment_version_id uuid        not null references assessment_versions (id) on delete restrict,
  token_hash            text        not null unique,
  token_hint            text        not null,
  status                app.assignment_status not null default 'assigned',
  max_attempts          int         not null default 1 check (max_attempts between 1 and 10),
  expires_at            timestamptz,
  revoked_at            timestamptz,
  created_by            uuid        references profiles (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index assignments_org_idx     on assessment_assignments (organization_id, status);
create index assignments_student_idx on assessment_assignments (student_id, status);
create unique index assignments_active_unique
  on assessment_assignments (student_id, assessment_version_id)
  where status in ('assigned', 'in_progress');

comment on index assignments_active_unique is
  'Blocks duplicate live assignments of the same test to the same student; retakes require revoking first.';

-- started_at is written once by the server and is the sole authority for the
-- countdown. expires_at is a materialised deadline so expiry can be indexed and
-- enforced with a plain comparison rather than recomputed in application code.
create table assessment_sessions (
  id                    uuid primary key default gen_random_uuid(),
  assignment_id         uuid        not null references assessment_assignments (id) on delete cascade,
  student_id            uuid        not null references students (id) on delete cascade,
  organization_id       uuid        not null references organizations (id) on delete cascade,
  assessment_version_id uuid        not null references assessment_versions (id) on delete restrict,
  scoring_rule_id       uuid        not null references scoring_rules (id) on delete restrict,
  attempt_number        int         not null check (attempt_number > 0),
  status                app.session_status not null default 'in_progress',
  started_at            timestamptz not null default now(),
  expires_at            timestamptz not null,
  duration_seconds      int         not null check (duration_seconds > 0),
  submitted_at          timestamptz,
  submit_reason         text,
  answered_count        int         not null default 0,
  flagged_count         int         not null default 0,
  last_saved_at         timestamptz,
  created_ip            inet,
  created_ua            text,
  unique (assignment_id, attempt_number)
);

create index sessions_open_idx  on assessment_sessions (student_id, status);
create index sessions_exp_idx   on assessment_sessions (expires_at) where status = 'in_progress';
create index sessions_assign_idx on assessment_sessions (assignment_id);

-- Responses are mutable only while the parent attempt is in progress. Once the
-- attempt closes, the guard trigger below makes them append-only.
create table responses (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid        not null references assessment_sessions (id) on delete cascade,
  question_id  uuid        not null references questions (id) on delete cascade,
  -- likert -> 1..5, single_choice/multi_select -> comma-joined option ids
  value        text        not null,
  is_flagged   boolean     not null default false,
  answered_at  timestamptz not null default now(),
  unique (session_id, question_id)
);

create index responses_session_idx on responses (session_id);

create table dimension_scores (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid        not null references assessment_sessions (id) on delete cascade,
  dimension_key    text        not null,
  kind             app.dimension_kind not null,
  raw_score        numeric(9,3) not null,
  max_raw_score    numeric(9,3) not null,
  normalized_score numeric(5,2) not null check (normalized_score between 0 and 100),
  items_answered   int         not null,
  items_total      int         not null,
  rank             int         not null,
  computed_at      timestamptz not null default now(),
  -- One row per dimension per attempt, not one row per attempt.
  unique (session_id, dimension_key)
);

create index dimension_scores_session_idx on dimension_scores (session_id);

-- ---------------------------------------------------------------------------
-- Match profiles (streams, branches, careers share one table)
-- ---------------------------------------------------------------------------
create table career_profiles (
  id            uuid primary key default gen_random_uuid(),
  key           text           not null unique,
  label         text           not null,
  kind          app.profile_kind not null default 'stream',
  summary       text           not null default '',
  -- Dimension key -> contribution weight for this profile.
  dimension_weights jsonb      not null default '{}'::jsonb,
  subjects      jsonb          not null default '[]'::jsonb,
  activities    jsonb          not null default '[]'::jsonb,
  pathways      jsonb          not null default '[]'::jsonb,
  display_order int            not null default 0,
  is_active     boolean        not null default true,
  created_at    timestamptz    not null default now(),
  updated_at    timestamptz    not null default now()
);

create table career_match_results (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid        not null references assessment_sessions (id) on delete cascade,
  profile_id     uuid        not null references career_profiles (id) on delete cascade,
  match_score    numeric(5,2) not null check (match_score between 0 and 100),
  band           smallint    not null check (band between 1 and 3),
  rank           int         not null,
  rationale      jsonb       not null default '[]'::jsonb,
  unique (session_id, profile_id)
);

create index career_matches_session_idx on career_match_results (session_id, rank);

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
create table report_templates (
  id             uuid primary key default gen_random_uuid(),
  key            text        not null,
  assessment_id  uuid        not null references assessments (id) on delete cascade,
  name           text        not null,
  template_version int       not null default 1,
  config         jsonb       not null default '{}'::jsonb,
  is_active      boolean     not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (key, template_version)
);

create table assessment_reports (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid        not null unique references assessment_sessions (id) on delete cascade,
  organization_id uuid      not null references organizations (id) on delete cascade,
  student_id    uuid        not null references students (id) on delete cascade,
  reference     text        not null unique,
  template_key  text        not null,
  status        app.report_status not null default 'pending',
  storage_path  text,
  byte_size     bigint check (byte_size is null or byte_size > 0),
  attempt_count int         not null default 1,
  error         text,
  generated_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index reports_student_idx on assessment_reports (student_id, created_at desc);
create index reports_status_idx  on assessment_reports (status) where status in ('pending', 'generating', 'failed');
create index reports_org_idx     on assessment_reports (organization_id, created_at desc);

create trigger assessments_touch          before update on assessments          for each row execute function app.touch_updated_at();
create trigger assessment_versions_touch  before update on assessment_versions  for each row execute function app.touch_updated_at();
create trigger questions_touch            before update on questions            for each row execute function app.touch_updated_at();
create trigger assignments_touch          before update on assessment_assignments for each row execute function app.touch_updated_at();
create trigger reports_touch              before update on assessment_reports    for each row execute function app.touch_updated_at();
create trigger career_profiles_touch      before update on career_profiles       for each row execute function app.touch_updated_at();
