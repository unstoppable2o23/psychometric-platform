/**
 * Development seed.
 *
 * Idempotent: every insert is keyed on a natural column and updated on conflict,
 * so running it twice does not duplicate the catalogue or the question bank.
 *
 * It creates one of everything the vertical slice needs, plus a known
 * development assignment link. That link is printed on every run so the flow can
 * be walked end to end without a UI.
 */
import { createHash } from 'node:crypto';
import { getDb } from './client';
import {
  buildStreamSelectorQuestions,
  assertBankIntegrity,
  EXPECTED_QUESTION_COUNT,
} from '../content/stream-selector-questions';
import {
  DIMENSIONS,
  STREAM_CONTENT,
  STREAM_PROFILES,
  STREAM_SELECTOR_SLUG,
} from '../content/stream-selector';
import { generateAssessmentToken, hashToken, tokenHint } from '../auth/tokens';
import { generateInviteToken, hashInviteToken, hashPassword, inviteHint } from '../auth/passwords';
import { appUrl } from '../env';

const baseUrl = (): string => appUrl();

/** Known password for the one seeded teacher who has already activated. */
export const DEV_TEACHER_PASSWORD = 'Greenfield#2026';

/** Known password for the seeded super admin, who manages teacher access. */
export const DEV_ADMIN_PASSWORD = 'Beacon#Admin2026';

/** Deterministic UUID so re-seeding does not orphan stored response values. */
function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

const DURATION_SECONDS = 45 * 60;

const DEMO_TOKEN = process.env.SEED_ASSIGNMENT_TOKEN ?? generateAssessmentToken();

export async function seed(): Promise<void> {
  const db = await getDb();

  assertBankIntegrity();
  const questions = buildStreamSelectorQuestions();

  // Declared outside the transaction so the summary can report the links.
  const pendingActivations: { name: string; email: string; url: string }[] = [];

  await db.tx(async (tx) => {
    /* ---------------- organisation and people ---------------- */

    const org = (
      await tx.query<{ id: string }>(
        `insert into organizations (name, slug, kind, contact_email, city, state)
         values ('Greenfield Vidyalaya', 'greenfield-vidyalaya', 'school', 'office@greenfield.example', 'Pune', 'Maharashtra')
         on conflict (slug) do update set name = excluded.name
         returning id`,
      )
    ).rows[0];

    const people = [
      { email: 'admin@psychometric.local', role: 'admin', name: 'Platform Admin', grade: null },
      { email: 'student@psychometric.local', role: 'student', name: 'Aarav Sharma', grade: 9 },
    ] as const;

    const userIds: Record<string, string> = {};

    for (const person of people) {
      const uid = stableUuid(`user:${person.email}`);
      userIds[person.email] = uid;

      await tx.query(
        `insert into auth.users (id, email, email_confirmed_at)
         values ($1, $2, now())
         on conflict (id) do update set email = excluded.email`,
        [uid, person.email],
      );

      await tx.query(
        `insert into profiles (id, role, display_name, email, organization_id, grade)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (id) do update
           set display_name = excluded.display_name, grade = excluded.grade`,
        [uid, person.role, person.name, person.email, org.id, person.grade],
      );
    }

    const studentUserId = userIds['student@psychometric.local'];
    const adminUserId = userIds['admin@psychometric.local'];

    /* ---------------- teachers: one account each ---------------- */

    const teacherSpecs = [
      { email: 'meera.iyer@greenfield.example', name: 'Meera Iyer', role: 'owner', activated: true },
      { email: 'anil.kulkarni@greenfield.example', name: 'Anil Kulkarni', role: 'teacher', activated: false },
      { email: 'sara.desai@greenfield.example', name: 'Sara Desai', role: 'teacher', activated: false },
    ] as const;

    const teacherIds: Record<string, string> = {};

    for (const spec of teacherSpecs) {
      const uid = stableUuid(`user:${spec.email}`);
      teacherIds[spec.email] = uid;

      await tx.query(
        `insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())
         on conflict (id) do update set email = excluded.email`,
        [uid, spec.email],
      );

      await tx.query(
        `insert into profiles (id, role, display_name, email, organization_id)
         values ($1, 'teacher', $2, $3, $4)
         on conflict (id) do update
           set display_name = excluded.display_name, organization_id = excluded.organization_id`,
        [uid, spec.name, spec.email, org.id],
      );

      await tx.query(
        `insert into organization_members (organization_id, user_id, role_in_org)
         values ($1, $2, $3)
         on conflict (organization_id, user_id) do update set role_in_org = excluded.role_in_org`,
        [org.id, uid, spec.role],
      );

      if (spec.activated) {
        // Give the first teacher a real password so the sign-in flow can be walked.
        const hashed = await hashPassword(DEV_TEACHER_PASSWORD);
        await tx.query(
          `insert into auth_credentials (user_id, password_hash, password_salt, hash_n, hash_r, hash_p, last_sign_in_at)
           values ($1, $2, $3, $4, $5, $6, now())
           on conflict (user_id) do update
             set password_hash = excluded.password_hash, password_salt = excluded.password_salt`,
          [uid, hashed.hash, hashed.salt, hashed.n, hashed.r, hashed.p],
        );
      } else {
        const token = generateInviteToken();
        await tx.query(
          `update auth_invites set status = 'revoked' where user_id = $1 and status = 'pending'`,
          [uid],
        );
        await tx.query(
          `insert into auth_invites (user_id, token_hash, token_hint, created_by)
           values ($1, $2, $3, $4)`,
          [uid, hashInviteToken(token), inviteHint(token), adminUserId],
        );
        pendingActivations.push({
          name: spec.name,
          email: spec.email,
          url: `${baseUrl()}/teacher/activate/${token}`,
        });
      }
    }

    /* ---------------- super admin: a password, so /admin is reachable ---- */

    {
      const adminHashed = await hashPassword(DEV_ADMIN_PASSWORD);
      await tx.query(
        `insert into auth_credentials (user_id, password_hash, password_salt, hash_n, hash_r, hash_p, last_sign_in_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (user_id) do update
           set password_hash = excluded.password_hash, password_salt = excluded.password_salt`,
        [adminUserId, adminHashed.hash, adminHashed.salt, adminHashed.n, adminHashed.r, adminHashed.p],
      );
    }

    const teacherUserId = teacherIds['meera.iyer@greenfield.example'];
    await tx.query(
      `insert into organization_members (organization_id, user_id, role_in_org)
       values ($1, $2, 'owner')
       on conflict (organization_id, user_id) do update set role_in_org = excluded.role_in_org`,
      [org.id, teacherUserId],
    );

    const klass = (
      await tx.query<{ id: string }>(
        `insert into classes (organization_id, name, grade, academic_year)
         values ($1, 'Grade 9 - A', 9, '2026-27')
         on conflict (organization_id, name) do update set grade = excluded.grade
         returning id`,
        [org.id],
      )
    ).rows[0];

    const student = (
      await tx.query<{ id: string }>(
        `insert into students (organization_id, class_id, user_id, display_name, grade, external_ref, guardian_email)
         values ($1, $2, $3, 'Aarav Sharma', 9, 'GFV-9-001', 'parent@greenfield.example')
         on conflict (organization_id, external_ref) do update
           set class_id = excluded.class_id, user_id = excluded.user_id
         returning id`,
        [org.id, klass.id, studentUserId],
      )
    ).rows[0];

    /* ---------------- assessment catalogue ---------------- */

    const assessment = (
      await tx.query<{ id: string }>(
        `insert into assessments (slug, title, summary, grade_min, grade_max, category)
         values ($1, 'Stream Selector Test',
                 'Explores which academic stream after Grade 10 may suit your measured aptitude and your stated interests.',
                 8, 10, 'Stream Guidance')
         on conflict (slug) do update set title = excluded.title, summary = excluded.summary
         returning id`,
        [STREAM_SELECTOR_SLUG],
      )
    ).rows[0];

    const instructions = [
      'This assessment has 150 questions and a time limit. The countdown starts as soon as you begin and does not stop if you close the page.',
      'There are two kinds of question. Some are reasoning and aptitude items with a correct answer. The rest ask how much something is like you, answered on a five-point scale. Answer both kinds honestly: there is no benefit to performing on one and not the other.',
      'Your answers save automatically as you go. You can move backwards and change any answer before you submit.',
      'You must answer at least 90% of the questions to submit. If time runs out, whatever you have answered is what gets scored.',
      'You will see your score as soon as you submit. Nobody else sees your individual answers.',
    ].join('\n\n');

    // A published version is frozen by the database, so re-seeding must not try
    // to edit one. If a usable published version already exists, reuse it and
    // leave the catalogue alone. Changing the question bank means publishing
    // version 2 (or resetting the dev database), not mutating version 1.
    const existingPublished = (
      await tx.query<{ id: string; question_count: number }>(
        `select id, question_count from assessment_versions
          where assessment_id = $1 and status = 'published'`,
        [assessment.id],
      )
    ).rows[0];

    const reusable =
      existingPublished !== undefined && existingPublished.question_count === questions.length;

    const version = reusable
      ? existingPublished
      : (
          await tx.query<{ id: string }>(
            `insert into assessment_versions
               (assessment_id, version, status, instructions, duration_seconds, question_count,
                min_completion_ratio, randomize_question_order, allow_flagging, allow_resume, scoring_config)
             values ($1,
                     (select coalesce(max(version), 0) + 1 from assessment_versions where assessment_id = $1),
                     'draft', $2, $3, $4, 0.9, true, true, true,
                     '{"models":["correct_answer","likert_5pt","dimension_weighted_stream_match"],"rule_version":1}')
             returning id`,
            [assessment.id, instructions, DURATION_SECONDS, EXPECTED_QUESTION_COUNT],
          )
        ).rows[0];

    if (!reusable) {
    for (const [index, dimension] of DIMENSIONS.entries()) {
      await tx.query(
        `insert into assessment_dimensions (assessment_version_id, key, label, kind, description, weight, display_order)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (assessment_version_id, key) do update
           set label = excluded.label, description = excluded.description`,
        [
          version.id,
          dimension.key,
          dimension.label,
          dimension.kind,
          dimension.description,
          dimension.weight,
          index,
        ],
      );
    }

    for (const [index, question] of questions.entries()) {
      const qid = stableUuid(`q:${version.id}:${question.key}`);

      await tx.query(
        `insert into questions
           (id, assessment_version_id, external_key, dimension_key, type, prompt, help_text,
            reverse_scored, scale_labels, display_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (assessment_version_id, external_key) do update
           set prompt = excluded.prompt, help_text = excluded.help_text,
               reverse_scored = excluded.reverse_scored, display_order = excluded.display_order`,
        [
          qid,
          version.id,
          question.key,
          question.dimension,
          question.type,
          question.prompt,
          question.helpText,
          question.reverseScored,
          question.type === 'likert' ? JSON.stringify([1, 2, 3, 4, 5]) : null,
          index,
        ],
      );

      if (question.options.length === 0) continue;

      for (const [optionIndex, label] of question.options.entries()) {
        const oid = stableUuid(`o:${question.key}:${optionIndex}`);
        const isCorrect = question.correct.includes(optionIndex);

        await tx.query(
          `insert into question_options (id, question_id, label, value, is_correct, display_order)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (question_id, label) do update
             set is_correct = excluded.is_correct, display_order = excluded.display_order`,
          [
            oid,
            qid,
            label,
            question.type === 'likert' ? String(optionIndex + 1) : null,
            isCorrect,
            optionIndex,
          ],
        );
      }
    }

    await tx.query(
      `insert into scoring_rules (assessment_version_id, rule_version, definition)
       values ($1, 1, $2)
       on conflict (assessment_version_id, rule_version) do update set definition = excluded.definition`,
      [
        version.id,
        JSON.stringify({
          model: 'stream-selector-v1',
          aptitude: 'fraction-of-items-correct',
          interest: 'likert-1-to-5-normalised',
          reverse_scored_items: questions.filter((q) => q.reverseScored).map((q) => q.key),
          stream_match: 'weighted-mean-of-normalised-dimension-scores',
          norms: null,
          note: 'No population norms exist for this instrument. Norm-based and percentile output is deliberately not produced.',
        }),
      ],
    );
    } // end of `if (!reusable)` catalogue build

    /* ---------------- stream profiles ---------------- */

    for (const [index, profile] of STREAM_PROFILES.entries()) {
      const content = STREAM_CONTENT[profile.key];
      await tx.query(
        `insert into career_profiles
           (key, label, kind, summary, dimension_weights, subjects, activities, pathways, display_order)
         values ($1, $2, 'stream', $3, $4, $5, $6, $7, $8)
         on conflict (key) do update
           set label = excluded.label, dimension_weights = excluded.dimension_weights,
               subjects = excluded.subjects, activities = excluded.activities,
               pathways = excluded.pathways`,
        [
          profile.key,
          profile.label,
          `${profile.label} is one of the stream options available after Grade 10. The subjects, activities and pathways listed here describe the route rather than a guaranteed outcome.`,
          JSON.stringify(profile.dimensionWeights),
          JSON.stringify(content.subjects),
          JSON.stringify(content.activities),
          JSON.stringify(content.pathways),
          index,
        ],
      );
    }

    /* ---------------- product and credits ---------------- */

    const product = (
      await tx.query<{ id: string }>(
        `insert into products (assessment_id, name, description, price_in_paise)
         values ($1, 'Stream Selector Test', 'Single assessment, includes the full PDF report.', 96000)
         on conflict (assessment_id) do update set price_in_paise = excluded.price_in_paise
         returning id`,
        [assessment.id],
      )
    ).rows[0];

    const existing = await tx.query<{ n: number }>(
      `select count(*)::int as n from credit_transactions where organization_id = $1 and product_id = $2`,
      [org.id, product.id],
    );
    if ((existing.rows[0]?.n ?? 0) === 0) {
      await tx.query(
        `insert into credit_transactions (organization_id, product_id, delta, reason)
         values ($1, $2, 25, 'seed: development credit grant')`,
        [org.id, product.id],
      );
    }

    /* ---------------- report template ---------------- */

    await tx.query(
      `insert into report_templates (key, assessment_id, name, template_version, config)
       values ('stream-selector', $1, 'Stream Selector Report', 1, $2)
       on conflict (key, template_version) do update set config = excluded.config`,
      [
        assessment.id,
        JSON.stringify({
          pageSize: 'A4',
          pages: ['summary', 'scores', 'interpretation', 'recommendations', 'action-plan'],
          includeRadar: true,
          includeBarChart: true,
        }),
      ],
    );

    /* ---------------- publish ---------------- */

    if (!reusable) {
      await tx.query(`update assessment_versions set status = 'published', published_at = now() where id = $1`, [
        version.id,
      ]);
    }

    /* ---------------- assignment ---------------- */

    // Revoke before issuing a new link. `status` must move off the live values
    // as well as setting revoked_at: the partial unique index that prevents a
    // duplicate live assignment keys on status, not on revoked_at.
    await tx.query(
      `update assessment_assignments
          set revoked_at = now(), status = 'revoked'
        where organization_id = $1 and student_id = $2
          and status in ('assigned', 'in_progress')`,
      [org.id, student.id],
    );

    const tokenHash = hashToken(DEMO_TOKEN);
    await tx.query(
      `insert into assessment_assignments
         (organization_id, student_id, assessment_version_id, token_hash, token_hint,
          max_attempts, expires_at, created_by)
       values ($1, $2, $3, $4, $5, 2, now() + interval '14 days', $6)
       on conflict (token_hash) do update
         set status = 'assigned', revoked_at = null, expires_at = now() + interval '14 days'`,
      [org.id, student.id, version.id, tokenHash, tokenHint(DEMO_TOKEN), teacherUserId],
    );

    /* ---------------- audit ---------------- */

    await tx.query(
      `insert into audit_logs (actor_id, actor_role, action, entity_type, entity_id, metadata)
       values ($1, 'admin', 'seed.run', 'assessment_version', $2, $3)`,
      [userIds['admin@psychometric.local'], version.id, JSON.stringify({ questions: questions.length })],
    );
  });

  reportSummary(questions.length, pendingActivations);
}

function reportSummary(questionCount: number, pending: { name: string; email: string; url: string }[]): void {
  const base = baseUrl();
  process.stdout.write(`
  Seed complete.
    questions          ${questionCount}
    duration           ${DURATION_SECONDS / 60} minutes
    product price      Rs 960.00
    credits granted    25
    teachers           3 (1 activated, ${pending.length} awaiting activation)

  Accounts
    super admin        admin@psychometric.local
      sign in          ${base}/admin/signin
      password         ${DEV_ADMIN_PASSWORD}
    student            student@psychometric.local

  Teacher sign-in (each teacher has their own account)
    ${base}/teacher/signin
    meera.iyer@greenfield.example   password: ${DEV_TEACHER_PASSWORD}
${pending.map((p) => `    ${p.email}   not activated yet, use the link below`).join('\n')}

  Activation links (each single-use, valid 48 hours)
${pending.map((p) => `    ${p.name} <${p.email}>\n      ${p.url}`).join('\n')}

  Assessment link for the seeded student
    ${base}/assessment/${DEMO_TOKEN}

`);
}

const isDirectRun = process.argv[1]?.includes('seed');
if (isDirectRun) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`seed failed: ${(err as Error).stack}\n`);
      process.exit(1);
    });
}
