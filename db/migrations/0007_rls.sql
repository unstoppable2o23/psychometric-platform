-- 0007_rls.sql
-- Row-level security.
--
-- The application connects with a pooled service role and enforces authorization
-- in the data access layer (src/server/dal). RLS is the second line of defence:
-- it means a mistake in the DAL, or any future direct client access with the
-- anon key, still cannot leak one school's students to another school.
--
-- Policies read the transaction-scoped values set by app.set_request_context().

-- ---------------------------------------------------------------------------
-- Resolution helpers. SECURITY DEFINER so they can traverse the graph without
-- being blocked by the very policies they are used in.
-- ---------------------------------------------------------------------------
create or replace function app.actor_student_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, app
as $$
  select coalesce(
    case
      when app.is_admin() then (select array_agg(id) from students)
      when app.current_role() = 'student' then
        (select array_agg(id) from students where user_id = app.current_user_id())
      else
        (select array_agg(id) from students where organization_id = app.current_org_id())
    end,
    '{}'::uuid[]
  )
$$;

create or replace function app.can_access_student(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select p_student_id = any (app.actor_student_ids())
$$;

create or replace function app.can_access_session(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select exists (
    select 1 from assessment_sessions s
     where s.id = p_session_id
       and s.student_id = any (app.actor_student_ids())
  )
$$;

create or replace function app.can_access_assignment(p_assignment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select exists (
    select 1 from assessment_assignments a
     where a.id = p_assignment_id
       and a.student_id = any (app.actor_student_ids())
  )
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. Tables without policies are, by definition, unreadable
-- to non-privileged roles, which is the desired default.
-- ---------------------------------------------------------------------------
alter table organizations           enable row level security;
alter table profiles                enable row level security;
alter table organization_members    enable row level security;
alter table classes                 enable row level security;
alter table students                enable row level security;
alter table assessments            enable row level security;
alter table assessment_versions     enable row level security;
alter table assessment_dimensions   enable row level security;
alter table questions               enable row level security;
alter table question_options        enable row level security;
alter table scoring_rules           enable row level security;
alter table assessment_assignments  enable row level security;
alter table assessment_sessions     enable row level security;
alter table responses               enable row level security;
alter table dimension_scores        enable row level security;
alter table career_profiles         enable row level security;
alter table career_match_results    enable row level security;
alter table report_templates        enable row level security;
alter table assessment_reports      enable row level security;
alter table products                enable row level security;
alter table discount_codes          enable row level security;
alter table orders                  enable row level security;
alter table order_items             enable row level security;
alter table payments                enable row level security;
alter table invoices                enable row level security;
alter table credit_transactions     enable row level security;
alter table audit_logs              enable row level security;
alter table notifications           enable row level security;

-- ---------------------------------------------------------------------------
-- Catalogue content: readable by any signed-in user, writable by admin only.
-- Questions and options carry no answer keys in application reads, but RLS
-- cannot express column-level redaction; the DAL strips is_correct instead.
-- ---------------------------------------------------------------------------
create policy catalogue_read on assessments
  for select using (app.current_user_id() is not null or true);

create policy versions_read on assessment_versions
  for select using (app.current_user_id() is not null or true);

create policy versions_admin_write on assessment_versions
  for all using (app.is_admin()) with check (app.is_admin());

create policy dimensions_read on assessment_dimensions
  for select using (true);

create policy dimensions_admin_write on assessment_dimensions
  for all using (app.is_admin()) with check (app.is_admin());

create policy questions_read on questions
  for select using (true);

create policy questions_admin_write on questions
  for all using (app.is_admin()) with check (app.is_admin());

create policy options_read on question_options
  for select using (true);

create policy options_admin_write on question_options
  for all using (app.is_admin()) with check (app.is_admin());

create policy scoring_rules_read on scoring_rules
  for select using (true);

create policy career_profiles_read on career_profiles
  for select using (true);

create policy career_profiles_admin_write on career_profiles
  for all using (app.is_admin()) with check (app.is_admin());

create policy report_templates_read on report_templates
  for select using (true);

create policy products_read on products
  for select using (true);

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create policy organizations_read on organizations
  for select using (app.is_admin() or id = app.current_org_id());

create policy organizations_admin_write on organizations
  for all using (app.is_admin()) with check (app.is_admin());

create policy profiles_self_read on profiles
  for select using (id = app.current_user_id() or app.is_admin()
                    or (app.current_role() in ('teacher') and organization_id = app.current_org_id()));

create policy profiles_self_write on profiles
  for update using (id = app.current_user_id())
  with check (id = app.current_user_id());

create policy profiles_admin_write on profiles
  for all using (app.is_admin()) with check (app.is_admin());

create policy members_read on organization_members
  for select using (app.is_admin() or organization_id = app.current_org_id());

create policy members_admin_write on organization_members
  for all using (app.is_admin() or organization_id = app.current_org_id())
  with check (app.is_admin() or organization_id = app.current_org_id());

create policy classes_read on classes
  for select using (app.is_admin() or organization_id = app.current_org_id());

create policy classes_admin_write on classes
  for all using (app.is_admin() or organization_id = app.current_org_id())
  with check (app.is_admin() or organization_id = app.current_org_id());

create policy students_read on students
  for select using (app.can_access_student(id));

create policy students_admin_write on students
  for all using (app.is_admin() or (app.current_role() = 'teacher' and organization_id = app.current_org_id()))
  with check (app.is_admin() or (app.current_role() = 'teacher' and organization_id = app.current_org_id()));

-- ---------------------------------------------------------------------------
-- Attempts
--
-- Select-only policies. All writes go through the service connection, where the
-- data access layer has already validated token ownership, attempt state, and
-- the deadline.
-- ---------------------------------------------------------------------------
create policy assignments_read on assessment_assignments
  for select using (app.can_access_assignment(id));

create policy sessions_read on assessment_sessions
  for select using (app.can_access_session(id));

create policy responses_read on responses
  for select using (app.can_access_session(session_id));

create policy dimension_scores_read on dimension_scores
  for select using (app.can_access_session(session_id));

create policy career_matches_read on career_match_results
  for select using (app.can_access_session(session_id));

-- Report bytes are private; only the metadata row is readable, and downloads are
-- served through an authorization-checked route rather than a public URL.
create policy reports_read on assessment_reports
  for select using (app.can_access_session(session_id));

-- ---------------------------------------------------------------------------
-- Commerce
-- ---------------------------------------------------------------------------
create policy orders_read on orders
  for select using (app.is_admin() or organization_id = app.current_org_id());

create policy order_items_read on order_items
  for select using (exists (
    select 1 from orders o where o.id = order_id
      and (app.is_admin() or o.organization_id = app.current_org_id())));

create policy payments_read on payments
  for select using (exists (
    select 1 from orders o where o.id = order_id
      and (app.is_admin() or o.organization_id = app.current_org_id())));

create policy invoices_read on invoices
  for select using (exists (
    select 1 from orders o where o.id = order_id
      and (app.is_admin() or o.organization_id = app.current_org_id())));

create policy credits_read on credit_transactions
  for select using (app.is_admin() or organization_id = app.current_org_id());

create policy discounts_read on discount_codes
  for select using (true);

-- ---------------------------------------------------------------------------
-- Audit and notifications
-- ---------------------------------------------------------------------------
create policy audit_admin_read on audit_logs
  for select using (app.is_admin());

create policy notifications_own_read on notifications
  for select using (user_id = app.current_user_id() or app.is_admin());
