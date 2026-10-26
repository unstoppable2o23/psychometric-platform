/**
 * Attempt lifecycle: resolving a link, starting or resuming an attempt, saving
 * answers, and closing an attempt with scoring.
 *
 * The countdown is server-authoritative. `started_at` is written once and never
 * changed, `expires_at` is derived from it, and every read re-checks the
 * deadline. A student who closes the laptop and comes back tomorrow finds the
 * attempt already closed, which is the behaviour a timed assessment requires.
 */
import 'server-only';
import type { Db } from '../db/client';
import { getDb, query } from '../db/client';
import { hashToken, newReference } from '../auth/tokens';
import {
  coverageFor,
  matchProfiles,
  normaliseStoredValue,
  RESPONSE_SEPARATOR,
  scoreDimensions,
  type ScoredItem,
} from '@/lib/scoring/engine';
import { buildInterpretation } from '@/lib/scoring/interpret';
import {
  DIMENSIONS as STREAM_DIMENSIONS,
  STREAM_CONTENT,
  STREAM_PROFILES,
} from '../content/stream-selector';
import {
  LIKERT_LABELS,
  type ActiveSession,
  type Dimension,
  type Question,
  type QuestionOption,
  type SavedAnswer,
  type SessionClock,
  type SessionStatus,
} from '@/lib/domain/types';
import {
  assertMayAccessStudent,
  assertSameOrganization,
  AuthorizationError,
  type Actor,
} from './actor';

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                  */
/* -------------------------------------------------------------------------- */

type AssignmentRow = {
  id: string;
  student_id: string;
  organization_id: string;
  assessment_version_id: string;
  status: string;
  max_attempts: number;
  expires_at: Date | null;
  revoked_at: Date | null;
  student_name: string;
  grade: number | null;
  scoring_rule_id: string | null;
};

type SessionRow = {
  id: string;
  assignment_id: string;
  student_id: string;
  attempt_number: number;
  status: SessionStatus;
  started_at: Date;
  expires_at: Date;
  duration_seconds: number;
  answered_count: number;
};

type VersionRow = {
  id: string;
  version: number;
  title: string;
  description: string;
  duration_seconds: number;
  question_count: number;
  instructions: string;
  min_completion_ratio: string;
  min_completion_ratio_num: number;
  allow_resume: boolean;
};

/* -------------------------------------------------------------------------- */
/* Link resolution                                                             */
/* -------------------------------------------------------------------------- */

export type LinkResolution =
  | { ok: true; assignment: AssignmentRow }
  | { ok: false; reason: 'not_found' | 'revoked' | 'expired' | 'used_up' };

/**
 * Lookup is by SHA-256 hash. An unknown token and a revoked token are reported
 * identically so a caller cannot enumerate which links ever existed.
 */
export async function resolveLink(rawToken: string): Promise<LinkResolution> {
  if (!rawToken || rawToken.length < 16) return { ok: false, reason: 'not_found' };

  const rows = await query<AssignmentRow>(
    `select a.id, a.student_id, a.organization_id, a.assessment_version_id, a.status,
            a.max_attempts, a.expires_at, a.revoked_at,
            s.display_name as student_name, s.grade,
            (select sr.scoring_rule_id from assessment_sessions sr
              where sr.assignment_id = a.id order by sr.attempt_number desc limit 1) as scoring_rule_id
       from assessment_assignments a
       join students s on s.id = a.student_id
      where a.token_hash = $1`,
    [hashToken(rawToken)],
  );

  const assignment = rows[0];
  if (!assignment) return { ok: false, reason: 'not_found' };
  // Both signals are checked because they can drift: status is what the
  // duplicate-assignment index keys on, revoked_at is what an admin sets.
  if (assignment.revoked_at || assignment.status === 'revoked') {
    return { ok: false, reason: 'revoked' };
  }
  if (assignment.expires_at && assignment.expires_at.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (assignment.status === 'completed' || assignment.status === 'expired') {
    return { ok: false, reason: 'used_up' };
  }

  return { ok: true, assignment };
}

/* -------------------------------------------------------------------------- */
/* Question assembly (answer keys stripped)                                    */
/* -------------------------------------------------------------------------- */

type QuestionRow = {
  id: string;
  dimension_key: string;
  type: Question['type'];
  prompt: string;
  help_text: string | null;
  reverse_scored: boolean;
  scale_labels: string[] | null;
};

type OptionRow = {
  id: string;
  question_id: string;
  label: string;
  value: string | null;
  is_correct: boolean;
  display_order: number;
};

/**
 * Strips `isCorrect` before anything is serialised towards the browser. The
 * question rows are read with the key present only because the database stores
 * it; this function is the single boundary where it is dropped.
 */
function toStudentQuestion(row: QuestionRow, options: OptionRow[]): Question {
  const mine = options
    .filter((o) => o.question_id === row.id)
    .sort((a, b) => a.display_order - b.display_order);

  const isLikert = row.type === 'likert';

  const studentOptions: QuestionOption[] = isLikert
    ? LIKERT_LABELS.map((label, i) => ({
        id: String(i + 1),
        label,
        value: i + 1,
        isCorrect: false,
      }))
    : mine.map((o) => ({
        id: o.id,
        label: o.label,
        value: o.value === null ? null : Number(o.value),
        isCorrect: false,
      }));

  return {
    id: row.id,
    dimensionKey: row.dimension_key,
    type: row.type,
    prompt: row.prompt,
    helpText: row.help_text,
    options: studentOptions,
    scaleLabels: isLikert ? LIKERT_LABELS : null,
  };
}

/**
 * Question order is derived from the session id rather than stored, so a refresh
 * cannot reshuffle the paper mid-attempt. Deterministic, not random per request.
 */
function deterministicOrder(questionIds: string[], sessionId: string): string[] {
  const keyed = questionIds.map((id, index) => {
    let hash = 2166136261;
    const seed = `${sessionId}:${id}`;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return { id, index, hash: hash >>> 0 };
  });
  return keyed.sort((a, b) => (a.hash === b.hash ? a.index - b.index : a.hash - b.hash)).map((k) => k.id);
}

function clockFor(session: SessionRow, now = Date.now()): SessionClock {
  const remaining = Math.max(0, Math.round((session.expires_at.getTime() - now) / 1000));
  return {
    startedAtMs: session.started_at.getTime(),
    expiresAtMs: session.expires_at.getTime(),
    serverNowMs: now,
    durationSeconds: session.duration_seconds,
    remainingSeconds: remaining,
  };
}

/* -------------------------------------------------------------------------- */
/* Start / resume                                                              */
/* -------------------------------------------------------------------------- */

export interface AttemptMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Idempotent: calling this twice returns the same open attempt rather than
 * burning a second attempt. A refresh or a double-tap cannot cost a student one
 * of their attempts.
 */
export async function startAttempt(
  actor: Actor,
  rawToken: string,
  meta: AttemptMeta = {},
): Promise<ActiveSession> {
  const resolution = await resolveLink(rawToken);
  if (!resolution.ok) {
    throw new AuthorizationError(
      resolution.reason === 'not_found' ? 'not_found' : 'forbidden',
    );
  }

  const { assignment } = resolution;

  assertMayAccessStudent(actor, assignment.student_id);
  assertSameOrganization(actor, assignment.organization_id);

  const db = await getDb();
  const now = Date.now();

  const session = await db.tx(async (tx) => {
    // Serialise concurrent starts on the assignment row. Without this lock two
    // requests can both read "no open attempt", both compute attempt_number = 1,
    // and one dies on the unique constraint with a raw 500 instead of resuming.
    await tx.query(`select id from assessment_assignments where id = $1 for update`, [assignment.id]);

    const open = (
      await tx.query<SessionRow>(
        `select id, assignment_id, student_id, attempt_number, status, started_at, expires_at, duration_seconds
           from assessment_sessions
          where assignment_id = $1 and status = 'in_progress'
          order by attempt_number desc
          limit 1`,
        [assignment.id],
      )
    ).rows[0];

    if (open) return open;

    const used = (
      await tx.query<{ used: number }>(
        `select count(*)::int as used from assessment_sessions where assignment_id = $1`,
        [assignment.id],
      )
    ).rows[0]?.used ?? 0;

    if (used >= assignment.max_attempts) {
      throw new AuthorizationError('forbidden');
    }

    const version = (
      await tx.query<VersionRow>(
        `select id, version, duration_seconds, question_count, min_completion_ratio, allow_resume
           from assessment_versions where id = $1`,
        [assignment.assessment_version_id],
      )
    ).rows[0];

    if (!version) throw new Error('assignment points at a missing assessment version');

    const rule = (
      await tx.query<{ id: string }>(
        `select id from scoring_rules
          where assessment_version_id = $1
          order by rule_version desc limit 1`,
        [version.id],
      )
    ).rows[0];
    if (!rule) throw new Error('assessment version has no scoring rule');

    const started = new Date(now);
    const expires = new Date(now + version.duration_seconds * 1000);

    const created = (
      await tx.query<SessionRow>(
        `insert into assessment_sessions
           (assignment_id, student_id, organization_id, assessment_version_id, scoring_rule_id,
            attempt_number, started_at, expires_at, duration_seconds, created_ip, created_ua)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning id, assignment_id, student_id, attempt_number, status, started_at, expires_at, duration_seconds`,
        [
          assignment.id,
          assignment.student_id,
          assignment.organization_id,
          version.id,
          rule.id,
          used + 1,
          started,
          expires,
          version.duration_seconds,
          meta.ip ?? null,
          meta.userAgent ?? null,
        ],
      )
    ).rows[0];

    await tx.query(
      `update assessment_assignments set status = 'in_progress' where id = $1 and status = 'assigned'`,
      [assignment.id],
    );

    return created;
  });

  return loadAttempt(actor, session.id);
}

/* -------------------------------------------------------------------------- */
/* Read                                                                        */
/* -------------------------------------------------------------------------- */

type VersionBundle = {
  version: VersionRow;
  assessment: { title: string; description: string };
  dimensions: Dimension[];
  questions: Question[];
};

/**
 * Per-process cache of the immutable question paper for a version.
 *
 * A published assessment version cannot change (the database refuses edits), so
 * this never goes stale for the lifetime of the process. Without it, every
 * autosave re-read 150 questions and their options from the database, which is
 * three extra queries on a keystroke-rate path.
 */
const versionBundleCache = new Map<string, VersionBundle>();

async function loadVersionRows(versionId: string): Promise<VersionBundle> {
  const cached = versionBundleCache.get(versionId);
  if (cached) return cached;

  const bundle = await fetchVersionRows(versionId);

  // Bounded so a long-running process cannot accumulate bundles forever.
  if (versionBundleCache.size >= 64) {
    const oldest = versionBundleCache.keys().next().value;
    if (oldest) versionBundleCache.delete(oldest);
  }
  versionBundleCache.set(versionId, bundle);
  return bundle;
}

async function fetchVersionRows(versionId: string): Promise<VersionBundle> {
  const db = await getDb();

  const version = (
    await db.query<VersionRow>(
      `select av.id, av.version, av.duration_seconds, av.question_count, av.instructions,
              av.min_completion_ratio::text as min_completion_ratio,
              av.min_completion_ratio::float as min_completion_ratio_num,
              av.allow_resume,
              a.title, a.summary as description
         from assessment_versions av
         join assessments a on a.id = av.assessment_id
        where av.id = $1`,
      [versionId],
    )
  ).rows[0];

  if (!version) throw new Error('assessment version not found');

  const dimensions = (
    await db.query<{ key: string; label: string; kind: 'aptitude' | 'interest'; description: string; weight: string }>(
      `select key, label, kind, description, weight::text as weight
         from assessment_dimensions where assessment_version_id = $1 order by display_order`,
      [versionId],
    )
  ).rows.map((r) => ({
    key: r.key,
    label: r.label,
    kind: r.kind,
    description: r.description,
    weight: Number(r.weight),
  }));

  const questionRows = (
    await db.query<QuestionRow>(
      `select id, dimension_key, type, prompt, help_text, reverse_scored,
              case when type = 'likert' then null else '[]'::jsonb end as scale_labels
         from questions
        where assessment_version_id = $1 and is_active
        order by display_order`,
      [versionId],
    )
  ).rows;

  const optionRows = (
    await db.query<OptionRow>(
      `select o.id, o.question_id, o.label, o.value::text as value, o.is_correct, o.display_order
         from question_options o
         join questions q on q.id = o.question_id
        where q.assessment_version_id = $1 and q.is_active`,
      [versionId],
    )
  ).rows;

  return {
    version,
    assessment: { title: version.title, description: version.description },
    dimensions,
    questions: questionRows.map((r) => toStudentQuestion(r, optionRows)),
  };
}

export async function loadAttempt(actor: Actor, sessionId: string): Promise<ActiveSession> {
  const db = await getDb();

  const session = (
    await db.query<SessionRow & { assessment_version_id: string; organization_id: string }>(
      `select id, assignment_id, student_id, organization_id, assessment_version_id,
              attempt_number, status, started_at, expires_at, duration_seconds
         from assessment_sessions where id = $1`,
      [sessionId],
    )
  ).rows[0];

  if (!session) throw new AuthorizationError('not_found');
  assertMayAccessStudent(actor, session.student_id);
  assertSameOrganization(actor, session.organization_id);

  // Server-authoritative expiry: close the attempt if the deadline has passed.
  if (session.status === 'in_progress' && session.expires_at.getTime() <= Date.now()) {
    await finaliseSession(db, session, 'timeout');
    session.status = 'expired';
  }

  // `dimensions` is not needed here; the runner renders dimension labels from
  // the questions themselves and scoring re-reads the catalogue.
  const { version, assessment, questions } = await loadVersionRows(
    session.assessment_version_id,
  );

  const ordered = deterministicOrder(
    questions.map((q) => q.id),
    session.id,
  );
  const byId = new Map(questions.map((q) => [q.id, q]));

  const answers = (
    await db.query<{ question_id: string; value: string; is_flagged: boolean }>(
      `select question_id, value, is_flagged from responses where session_id = $1`,
      [session.id],
    )
  ).rows;

  return {
    sessionId: session.id,
    assignmentId: session.assignment_id,
    attemptNumber: session.attempt_number,
    status: session.status,
    clock: clockFor(session),
    assessment: {
      id: version.id,
      slug: 'stream-selector',
      title: assessment.title,
      description: assessment.description,
      version: version.version,
      durationSeconds: version.duration_seconds,
      questionCount: version.question_count,
      instructions: version.instructions,
      minCompletionRatio: version.min_completion_ratio_num,
    },
    questions: ordered.map((id) => byId.get(id)!).filter(Boolean),
    answeredIds: answers.map((a) => a.question_id),
    // The student's own responses, so a refresh restores their selections.
    answers: answers.map((a) => ({ questionId: a.question_id, value: a.value })),
    flaggedIds: answers.filter((a) => a.is_flagged).map((a) => a.question_id),
    minCompletionRatio: version.min_completion_ratio_num,
  };
}

/* -------------------------------------------------------------------------- */
/* Save                                                                        */
/* -------------------------------------------------------------------------- */

export interface SaveResult {
  saved: number;
  answeredCount: number;
  clock: SessionClock;
  /** Set when the deadline passed during this save; the client must stop. */
  closed: boolean;
}

export async function saveAnswers(
  actor: Actor,
  sessionId: string,
  answers: SavedAnswer[],
): Promise<SaveResult> {
  const db = await getDb();

  const session = (
    await db.query<SessionRow & { assessment_version_id: string; organization_id: string }>(
      `select id, assignment_id, student_id, organization_id, assessment_version_id,
              attempt_number, status, started_at, expires_at, duration_seconds
         from assessment_sessions where id = $1`,
      [sessionId],
    )
  ).rows[0];

  if (!session) throw new AuthorizationError('not_found');
  assertMayAccessStudent(actor, session.student_id);
  assertSameOrganization(actor, session.organization_id);

  if (session.status !== 'in_progress') {
    throw new AuthorizationError('forbidden');
  }

  if (session.expires_at.getTime() <= Date.now()) {
    await finaliseSession(db, session, 'timeout');
    return { saved: 0, answeredCount: session.answered_count ?? 0, clock: clockFor(session), closed: true };  }

  const { questions } = await loadVersionRows(session.assessment_version_id);
  const questionIndex = new Map(questions.map((q) => [q.id, q]));

  let saved = 0;
  let persisted = 0;

  await db.tx(async (tx) => {
    for (const answer of answers) {
      const question = questionIndex.get(answer.questionId);
      if (!question) continue; // ignore ids outside this version

      // Canonicalise before validating, so "b|a" and "a|b" persist identically.
      // Doing this only in the scoring layer would leave two different strings on
      // disk for the same selection and make "answered" checks unreliable.
      const canonical = normaliseStoredValue(String(answer.value).slice(0, 512));
      if (canonical === null) continue;

      // A likert value must be an option id this question actually offers,
      // otherwise a crafted payload could store an out-of-range score.
      const allowed = new Set(question.options.map((o) => o.id));
      const parts = canonical.split(RESPONSE_SEPARATOR);
      if (parts.some((p) => !allowed.has(p))) continue;
      if (question.type === 'multi_select' && parts.length > question.options.length) continue;
      if (question.type !== 'multi_select' && parts.length > 1) continue;

      await tx.query(
        `insert into responses (session_id, question_id, value)
         values ($1, $2, $3)
         on conflict (session_id, question_id)
         do update set value = excluded.value, answered_at = now()`,
        [sessionId, answer.questionId, canonical],
      );
      saved += 1;
    }

    const counts = (
      await tx.query<{ answered: number; flagged: number }>(
        `select count(*)::int as answered, count(*) filter (where is_flagged)::int as flagged
           from responses where session_id = $1`,
        [sessionId],
      )
    ).rows[0];

    persisted = counts?.answered ?? 0;

    await tx.query(
      `update assessment_sessions set answered_count = $2, flagged_count = $3, last_saved_at = now()
        where id = $1`,
      [sessionId, persisted, counts?.flagged ?? 0],
    );
  });

  return {
    saved,
    answeredCount: persisted,
    clock: clockFor(session),
    closed: false,
  };
}

export async function setFlag(
  actor: Actor,
  sessionId: string,
  questionId: string,
  flagged: boolean,
): Promise<void> {
  const db = await getDb();
  const session = (
    await db.query<SessionRow & { organization_id: string }>(
      `select id, assignment_id, student_id, organization_id, assessment_version_id,
              attempt_number, status, started_at, expires_at, duration_seconds
         from assessment_sessions where id = $1`,
      [sessionId],
    )
  ).rows[0];

  if (!session) throw new AuthorizationError('not_found');
  assertMayAccessStudent(actor, session.student_id);
  assertSameOrganization(actor, session.organization_id);
  if (session.status !== 'in_progress') throw new AuthorizationError('forbidden');

  await db.query(
    `update responses set is_flagged = $3
      where session_id = $1 and question_id = $2`,
    [sessionId, questionId, flagged],
  );
}

/* -------------------------------------------------------------------------- */
/* Submit and score                                                            */
/* -------------------------------------------------------------------------- */

export interface SubmitResult {
  sessionId: string;
  reportId: string;
  reference: string;
  status: 'submitted' | 'expired';
  /** Coverage failure is reported rather than thrown, so the UI can explain it. */
  coverage: { answered: number; total: number; ratio: number; meetsMinimum: boolean };
}

async function finaliseSession(
  db: Db,
  session: SessionRow,
  reason: 'student' | 'timeout',
): Promise<SubmitResult> {
  return db.tx(async (tx) => {
    // Claim the attempt. Only the caller whose UPDATE actually changes a row
    // proceeds, which makes concurrent submits (double-click, refresh + retry)
    // collapse to exactly one scoring run.
    const claimed = (
      await tx.query<SessionRow>(
        `update assessment_sessions
            set status = $2, submitted_at = now(), submit_reason = $3
          where id = $1 and status = 'in_progress'
          returning id, assignment_id, student_id, attempt_number, status,
                    started_at, expires_at, duration_seconds`,
        [session.id, reason === 'timeout' ? 'expired' : 'submitted', reason],
      )
    ).rows[0];

    if (!claimed) {
      // Someone else closed the attempt first. Their UPDATE held a row lock, so
      // this branch only runs after that transaction committed and the report
      // row exists; the read below is not racing.
      const existing = (
        await tx.query<{ id: string; status: SessionStatus }>(
          `select id, status from assessment_sessions where id = $1`,
          [session.id],
        )
      ).rows[0];
      const report = (
        await tx.query<{ id: string; reference: string }>(
          `select id, reference from assessment_reports where session_id = $1`,
          [session.id],
        )
      ).rows[0];
      if (!existing || !report) throw new Error('attempt is closed but has no report record');

      // Report the real coverage rather than a placeholder, so a duplicate
      // submit reports the same numbers as the original.
      const counts = (
        await tx.query<{ answered: number; total: number }>(
          `select (select count(*)::int from responses where session_id = $1) as answered,
                  (select count(*)::int from questions q
                     join assessment_sessions s on s.assessment_version_id = q.assessment_version_id
                    where s.id = $1 and q.is_active) as total`,
          [session.id],
        )
      ).rows[0];
      const answered = counts?.answered ?? 0;
      const total = counts?.total ?? 0;

      return {
        sessionId: existing.id,
        reportId: report.id,
        reference: report.reference,
        status: existing.status === 'expired' ? 'expired' : 'submitted',
        coverage: {
          answered,
          total,
          ratio: total === 0 ? 0 : Math.round((answered / total) * 10000) / 10000,
          meetsMinimum: true,
        },
      };
    }

    const scoring = await scoreSession(tx, claimed);

    const reference = newReference('SS');
    const report = (
      await tx.query<{ id: string }>(
        `insert into assessment_reports (session_id, organization_id, student_id, reference, template_key, status)
         values ($1, (select organization_id from assessment_sessions where id = $1),
                 (select student_id from assessment_sessions where id = $1), $2, 'stream-selector', 'pending')
         returning id`,
        [claimed.id, reference],
      )
    ).rows[0];

    await tx.query(
      `update assessment_assignments set status = $2 where id = $1
        and status in ('assigned','in_progress')`,
      [claimed.assignment_id, reason === 'timeout' ? 'expired' : 'completed'],
    );

    return {
      sessionId: claimed.id,
      reportId: report.id,
      reference,
      status: reason === 'timeout' ? 'expired' : 'submitted',
      coverage: scoring.coverage,
    };
  });
}

export async function submitAttempt(actor: Actor, sessionId: string): Promise<SubmitResult> {
  const db = await getDb();
  const session = (
    await db.query<SessionRow & { organization_id: string; assessment_version_id: string }>(
      `select id, assignment_id, student_id, organization_id, assessment_version_id,
              attempt_number, status, started_at, expires_at, duration_seconds
         from assessment_sessions where id = $1`,
      [sessionId],
    )
  ).rows[0];

  if (!session) throw new AuthorizationError('not_found');
  assertMayAccessStudent(actor, session.student_id);
  assertSameOrganization(actor, session.organization_id);

  // Already closed: return the original outcome rather than scoring twice.
  if (session.status !== 'in_progress') {
    const existing = (
      await db.query<{ id: string; reference: string }>(
        `select id, reference from assessment_reports where session_id = $1`,
        [sessionId],
      )
    ).rows[0];
    if (existing) {
      const counts = (
        await db.query<{ answered: number; total: number }>(
          `select (select count(*)::int from responses where session_id = $1) as answered,
                  (select count(*)::int from questions q
                     join assessment_sessions s on s.assessment_version_id = q.assessment_version_id
                    where s.id = $1 and q.is_active) as total`,
          [sessionId],
        )
      ).rows[0];
      const answered = counts?.answered ?? 0;
      const total = counts?.total ?? 0;
      return {
        sessionId,
        reportId: existing.id,
        reference: existing.reference,
        status: session.status === 'expired' ? 'expired' : 'submitted',
        coverage: {
          answered,
          total,
          ratio: total === 0 ? 0 : Math.round((answered / total) * 10000) / 10000,
          meetsMinimum: true,
        },
      };
    }
  }

  const timedOut = session.expires_at.getTime() <= Date.now();

  // A student-initiated submit below the configured completion floor is refused.
  // A timeout is not: the paper is closed by the clock either way, and refusing
  // there would discard real answers the student did give.
  if (!timedOut) {
    const check = (
      await db.query<{ answered: number; total: number; min_ratio: number }>(
        `select (select count(*)::int from responses where session_id = $1) as answered,
                (select count(*)::int from questions q
                   join assessment_sessions s on s.assessment_version_id = q.assessment_version_id
                  where s.id = $1 and q.is_active) as total,
                (select av.min_completion_ratio::float from assessment_sessions s
                   join assessment_versions av on av.id = s.assessment_version_id
                  where s.id = $1) as min_ratio`,
        [sessionId],
      )
    ).rows[0];

    const answered = check?.answered ?? 0;
    const total = check?.total ?? 0;
    const minRatio = check?.min_ratio ?? 1;

    if (total > 0 && answered / total < minRatio) {
      throw new IncompleteSubmissionError({
        answered,
        total,
        required: Math.ceil(total * minRatio),
      });
    }
  }

  return finaliseSession(db, session, timedOut ? 'timeout' : 'student');
}

/**
 * Raised when a student tries to submit before answering the configured share of
 * questions. Carries the numbers so the interface can say exactly what is
 * missing instead of a generic failure.
 */
export class IncompleteSubmissionError extends Error {
  readonly status = 422;
  constructor(
    readonly detail: { answered: number; total: number; required: number },
  ) {
    super(
      `Only ${detail.answered} of ${detail.total} questions answered. At least ${detail.required} are required.`,
    );
    this.name = 'IncompleteSubmissionError';
  }
}

/**
 * Pure scoring over stored answers. Deliberately shares the scoring engine in
 * src/lib/scoring so a re-score in an admin tool cannot drift from what the
 * student was shown.
 */
async function scoreSession(
  tx: Db,
  session: SessionRow,
): Promise<{ coverage: { answered: number; total: number; ratio: number; meetsMinimum: boolean } }> {
  const version = (
    await tx.query<VersionRow>(
      `select id, version, duration_seconds, question_count, instructions,
              min_completion_ratio::text as min_completion_ratio,
              min_completion_ratio::float as min_completion_ratio_num, allow_resume
         from assessment_versions where id = (
           select assessment_version_id from assessment_sessions where id = $1)`,
      [session.id],
    )
  ).rows[0];

  const dimensionRows = (
    await tx.query<{ key: string; label: string; kind: 'aptitude' | 'interest'; description: string; weight: string }>(
      `select key, label, kind, description, weight::text as weight
         from assessment_dimensions where assessment_version_id = $1 order by display_order`,
      [version.id],
    )
  ).rows.map((r) => ({
    key: r.key,
    label: r.label,
    kind: r.kind,
    description: r.description,
    weight: Number(r.weight),
  }));

  const itemRows = (
    await tx.query<{
      id: string;
      dimension_key: string;
      type: Question['type'];
      reverse_scored: boolean;
    }>(
      `select id, dimension_key, type, reverse_scored from questions
        where assessment_version_id = $1 and is_active`,
      [version.id],
    )
  ).rows;

  const optionRows = (
    await tx.query<{ id: string; question_id: string; value: string | null; is_correct: boolean }>(
      `select o.id, o.question_id, o.value::text as value, o.is_correct
         from question_options o
         join questions q on q.id = o.question_id
        where q.assessment_version_id = $1 and q.is_active`,
      [version.id],
    )
  ).rows;

  const items: ScoredItem[] = itemRows.map((item) => ({
    id: item.id,
    dimensionKey: item.dimension_key,
    type: item.type,
    reverseScored: item.reverse_scored,
    options: optionRows
      .filter((o) => o.question_id === item.id)
      .map((o) => ({ id: o.id, value: o.value === null ? null : Number(o.value), isCorrect: o.is_correct })),
  }));

  const responseRows = (
    await tx.query<{ question_id: string; value: string }>(
      `select question_id, value from responses where session_id = $1`,
      [session.id],
    )
  ).rows;

  const responses = new Map(responseRows.map((r) => [r.question_id, r.value]));

  const dimensions = scoreDimensions(dimensionRows, items, responses);
  const coverage = coverageFor(items, responses, version.min_completion_ratio_num);
  const outcome = matchProfiles(STREAM_PROFILES, dimensions);

  for (const score of dimensions) {
    await tx.query(
      `insert into dimension_scores
         (session_id, dimension_key, kind, raw_score, max_raw_score, normalized_score,
          items_answered, items_total, rank)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        session.id,
        score.key,
        score.kind,
        score.rawScore,
        score.maxRawScore,
        score.normalizedScore,
        score.itemsAnswered,
        score.itemsTotal,
        score.rank,
      ],
    );
  }

  const profileIds = (
    await tx.query<{ id: string; key: string }>(`select id, key from career_profiles`)
  ).rows;
  const idByKey = new Map(profileIds.map((p) => [p.key, p.id]));

  for (const match of outcome.matches) {
    const profileId = idByKey.get(match.stream);
    if (!profileId) continue;
    const rank = outcome.matches.findIndex((m) => m.stream === match.stream) + 1;
    await tx.query(
      `insert into career_match_results (session_id, profile_id, match_score, band, rank, rationale)
       values ($1,$2,$3,$4,$5,$6)`,
      [session.id, profileId, match.fitScore, match.band, rank, JSON.stringify(match.rationale)],
    );
  }

  return { coverage };
}

/* -------------------------------------------------------------------------- */
/* Result assembly                                                             */
/* -------------------------------------------------------------------------- */

export async function loadResult(actor: Actor, sessionId: string) {
  const db = await getDb();

  const session = (
    await db.query<{
      id: string;
      student_id: string;
      organization_id: string;
      assessment_version_id: string;
      status: SessionStatus;
      started_at: Date;
      submitted_at: Date | null;
      duration_seconds: number;
      display_name: string;
      grade: number | null;
      school_name: string | null;
      title: string;
      version: number;
      reference: string | null;
      report_status: string | null;
      report_id: string | null;
      generated_at: Date | null;
    }>(
      `select s.id, s.student_id, s.organization_id, s.assessment_version_id, s.status,
              s.started_at, s.submitted_at, s.duration_seconds,
              st.display_name, st.grade, o.name as school_name,
              a.title, av.version,
              r.reference, r.status as report_status, r.id as report_id, r.generated_at
         from assessment_sessions s
         join students st on st.id = s.student_id
         join organizations o on o.id = s.organization_id
         join assessment_versions av on av.id = s.assessment_version_id
         join assessments a on a.id = av.assessment_id
         left join assessment_reports r on r.session_id = s.id
        where s.id = $1`,
      [sessionId],
    )
  ).rows[0];

  if (!session) throw new AuthorizationError('not_found');

  // A student may only read their own attempt. Staff may only read attempts in
  // their own organisation. Admins may read anything. Everything else is
  // reported as not-found so an id cannot be probed for existence.
  if (actor.role === 'student') {
    if (actor.studentId !== session.student_id) throw new AuthorizationError('not_found');
  } else if (actor.role === 'teacher') {
    if (!actor.organizationId || actor.organizationId !== session.organization_id) {
      throw new AuthorizationError('not_found');
    }
  }

  return session;
}

/** Recomputes the interpretation payload for an already-scored attempt. */
export async function buildResultPayload(sessionId: string) {
  const db = await getDb();

  const meta = (
    await db.query<{
      display_name: string;
      grade: number | null;
      title: string;
      version: number;
      reference: string;
      started_at: Date;
      submitted_at: Date;
      question_count: number;
      answered_count: number;
      duration_seconds: number;
    }>(
      `select st.display_name, st.grade, a.title, av.version, r.reference,
              s.started_at, s.submitted_at, av.question_count, s.answered_count, s.duration_seconds
         from assessment_sessions s
         join students st on st.id = s.student_id
         join assessment_versions av on av.id = s.assessment_version_id
         join assessments a on a.id = av.assessment_id
         join assessment_reports r on r.session_id = s.id
        where s.id = $1`,
      [sessionId],
    )
  ).rows[0];

  if (!meta) throw new Error('cannot build a result for an unscored attempt');

  const dimensionRows = (
    await db.query<{
      dimension_key: string;
      kind: 'aptitude' | 'interest';
      raw_score: string;
      max_raw_score: string;
      normalized_score: string;
      items_answered: number;
      items_total: number;
      rank: number;
    }>(
      `select dimension_key, kind, raw_score::text, max_raw_score::text,
              normalized_score::text, items_answered, items_total, rank
         from dimension_scores where session_id = $1`,
      [sessionId],
    )
  ).rows;

  const dimensions = dimensionRows.map((row) => {
    const def = STREAM_DIMENSIONS.find((d) => d.key === row.dimension_key);
    return {
      key: row.dimension_key,
      label: def?.label ?? row.dimension_key,
      kind: row.kind,
      description: def?.description ?? '',
      rawScore: Number(row.raw_score),
      maxRawScore: Number(row.max_raw_score),
      normalizedScore: Number(row.normalized_score),
      itemsAnswered: row.items_answered,
      itemsTotal: row.items_total,
      rank: row.rank,
    };
  });

  const matches = matchProfiles(STREAM_PROFILES, dimensions);
  const completedInSeconds = Math.max(
    0,
    Math.round((meta.submitted_at.getTime() - meta.started_at.getTime()) / 1000),
  );

  const narrative = buildInterpretation({
    studentDisplayName: meta.display_name,
    grade: meta.grade,
    dimensions,
    matches: matches.matches,
    streamContent: STREAM_CONTENT,
    answeredQuestions: meta.answered_count,
    totalQuestions: meta.question_count,
    completedInSeconds,
  });

  return { meta, dimensions, matches: matches.matches, narrative };
}

