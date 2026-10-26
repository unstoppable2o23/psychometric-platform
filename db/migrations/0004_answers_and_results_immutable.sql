-- 0004_answers_and_results_immutable.sql
-- Locks down the rows that back an already-issued report.
--
-- A guard trigger alone is not enough: dimension_scores and career_match_results
-- have one row per session and need to be corrected occasionally when a scoring
-- bug is fixed. Those corrections are done by an explicit admin re-score, which
-- deletes and re-derives the attempt rather than mutating in place. So for those
-- tables we block UPDATE and DELETE; responses need the same guarantee once the
-- parent attempt is closed, which the trigger below checks per-row.

-- Responses are writable only while the owning attempt is still running.
--
-- The three operations are resolved explicitly. A BEFORE trigger that falls
-- through to `return old` on an INSERT silently discards the row rather than
-- raising, which is how an earlier version of this function made it impossible
-- to save a single answer.
create or replace function app.guard_responses()
returns trigger
language plpgsql
as $$
declare
  v_status app.session_status;
begin
  if tg_op = 'INSERT' then
    select status into v_status from assessment_sessions where id = new.session_id;
    if v_status is null then
      raise exception 'responses must reference an existing attempt' using errcode = 'foreign_key_violation';
    end if;
    if v_status <> 'in_progress' then
      raise exception 'cannot add answers to a % attempt', v_status using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    select status into v_status from assessment_sessions where id = new.session_id;
    if v_status is null then
      raise exception 'responses must reference an existing attempt' using errcode = 'foreign_key_violation';
    end if;
    if v_status <> 'in_progress' then
      raise exception 'attempt % is closed; responses are frozen', v_status using errcode = 'restrict_violation';
    end if;
    -- Re-homing an answer onto a different attempt would let a caller shift
    -- credit between sessions, so the parent is fixed once written.
    if new.session_id is distinct from old.session_id then
      raise exception 'a response cannot be moved to a different attempt' using errcode = 'restrict_violation';
    end if;
    if new.question_id is distinct from old.question_id then
      raise exception 'a response cannot be reassigned to a different question' using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  select status into v_status from assessment_sessions where id = old.session_id;
  if v_status is not null and v_status <> 'in_progress' then
    raise exception 'cannot delete answers from a % attempt', v_status using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

create or replace function app.guard_session_transition()
returns trigger
language plpgsql
as $$
begin
  -- Only these fields may change after an attempt is created. Everything else is
  -- fixed at start time so the countdown and the audit trail cannot be rewritten.
  if old.status <> 'in_progress' and (
       new.assignment_id         is distinct from old.assignment_id or
       new.student_id            is distinct from old.student_id or
       new.organization_id       is distinct from old.organization_id or
       new.assessment_version_id is distinct from old.assessment_version_id or
       new.scoring_rule_id       is distinct from old.scoring_rule_id or
       new.attempt_number        is distinct from old.attempt_number or
       new.started_at            is distinct from old.started_at or
       new.expires_at            is distinct from old.expires_at or
       new.duration_seconds      is distinct from old.duration_seconds
     ) then
    raise exception 'attempt identity fields are immutable once submitted' using errcode = 'restrict_violation';
  end if;

  -- A closed attempt is terminal.
  if old.status <> 'in_progress' and new.status <> old.status then
    raise exception 'attempt is already % and cannot become %', old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

create trigger responses_guard
  before insert or update or delete on responses
  for each row execute function app.guard_responses();

create trigger sessions_guard
  before update on assessment_sessions
  for each row execute function app.guard_session_transition();

-- Computed results are append-only snapshots of one scoring run.
create trigger dimension_scores_immutable
  before update or delete on dimension_scores
  for each row execute function app.reject_mutation();

create trigger career_matches_immutable
  before update or delete on career_match_results
  for each row execute function app.reject_mutation();

-- Published versions and their question bank are frozen. Corrections go in a new
-- version, which is what keeps historical reports reproducible.
create or replace function app.guard_published_version()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'published' then
    raise exception 'published version % is immutable; create a new version instead', old.version
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create or replace function app.guard_published_questions()
returns trigger
language plpgsql
as $$
declare
  v_status app.version_status;
  v_version_id uuid;
begin
  -- options hang off questions, so the owning version is one hop further up.
  if tg_table_name = 'question_options' then
    select q.assessment_version_id into v_version_id
      from questions q
     where q.id = case when tg_op = 'DELETE' then old.question_id else new.question_id end;
  else
    v_version_id := case when tg_op = 'DELETE' then old.assessment_version_id else new.assessment_version_id end;
  end if;

  select status into v_status from assessment_versions where id = v_version_id;

  if v_status = 'published' then
    raise exception 'cannot % items in a published version', tg_op
      using errcode = 'restrict_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger assessment_versions_guard
  before update on assessment_versions
  for each row execute function app.guard_published_version();

create trigger questions_guard
  before insert or update or delete on questions
  for each row execute function app.guard_published_questions();

create trigger question_options_guard
  before insert or update or delete on question_options
  for each row execute function app.guard_published_questions();
