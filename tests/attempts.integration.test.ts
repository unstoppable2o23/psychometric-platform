/**
 * Integration tests for the attempt lifecycle against a real Postgres database.
 *
 * Covers the journeys that matter: link -> attempt -> autosave -> submit ->
 * score -> report record, plus the failure modes that would otherwise only show
 * up in production (double submit, refresh mid-attempt, attempt exhaustion,
 * cross-tenant access, tampering after submission).
 *
 * Each test gets its own assignment row, so attempt limits stay realistic rather
 * than being quietly raised to make tests pass.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureDatabase } from './helpers/db';
import { getDb } from '@/server/db/client';
import {
  buildResultPayload,
  loadAttempt,
  resolveLink,
  saveAnswers,
  setFlag,
  startAttempt,
  submitAttempt,
} from '@/server/dal/attempts';
import { AuthorizationError, type Actor } from '@/server/dal/actor';
import { hashToken } from '@/server/auth/tokens';
import type { SavedAnswer } from '@/lib/domain/types';
import { EXPECTED_QUESTION_COUNT } from '@/server/content/stream-selector-questions';

const studentActor: Actor = {
  userId: '00000000-0000-0000-0000-000000000000',
  role: 'student',
  organizationId: null,
  displayName: 'Aarav Sharma',
  studentId: null,
};

type Paper = { id: string; type: string; options: { id: string }[] };

function answerAll(
  questions: Paper[],
  strategy: (q: Paper, index: number) => string,
): SavedAnswer[] {
  return questions.map((q, i) => ({ questionId: q.id, value: strategy(q, i) }));
}

/** The likert value a "high interest" paper uses. */
const HIGH = '5';

let studentId: string;
let orgId: string;
let versionId: string;
let teacherUserId: string;
let token: string;

beforeAll(async () => {
  await ensureDatabase();
  const db = await getDb();
  const rows = await db.query<{ user_id: string; student_id: string; org: string }>(
    `select p.id as user_id, s.id as student_id, s.organization_id as org
       from profiles p
       join students s on s.user_id = p.id
      where p.email = 'student@psychometric.local'`,
  );
  studentActor.userId = rows.rows[0].user_id;
  studentActor.studentId = rows.rows[0].student_id;
  studentActor.organizationId = rows.rows[0].org;
  studentId = rows.rows[0].student_id;
  orgId = rows.rows[0].org;

  const v = await db.query<{ id: string }>(
    `select av.id from assessment_versions av
       join assessments a on a.id = av.assessment_id
      where a.slug = 'stream-selector'`,
  );
  versionId = v.rows[0].id;

  const t = await db.query<{ id: string }>(
    `select id from profiles
      where role = 'teacher' and organization_id = $1
      order by created_at limit 1`,
    [orgId],
  );
  teacherUserId = t.rows[0].id;
});

/**
 * Creates a fresh assignment with its own bearer token.
 *
 * The schema allows only one live assignment per student per version, which is
 * the real product rule a school relies on, so any existing live assignment
 * (including the seeded one) is revoked before the new link is issued.
 */
async function createAssignment(maxAttempts = 2): Promise<string> {
  const db = await getDb();
  await db.query(
    `update assessment_assignments set revoked_at = now(), status = 'revoked'
      where student_id = $1 and status in ('assigned', 'in_progress')`,
    [studentId],
  );
  const raw = `test-token-${randomUUID()}`;
  await db.query(
    `insert into assessment_assignments
       (organization_id, student_id, assessment_version_id, token_hash, token_hint,
        max_attempts, expires_at, created_by)
     values ($1, $2, $3, $4, $5, $6, now() + interval '1 day', $7)`,
    [orgId, studentId, versionId, hashToken(raw), raw.slice(-4), maxAttempts, teacherUserId],
  );
  return raw;
}

beforeEach(async () => {
  token = await createAssignment();
});

describe('link resolution', () => {
  it('rejects an unknown token without revealing whether it ever existed', async () => {
    const result = await resolveLink('this-token-was-never-issued-at-all');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('rejects a revoked link', async () => {
    const db = await getDb();
    await db.query(`update assessment_assignments set revoked_at = now() where token_hash = $1`, [
      hashToken(token),
    ]);
    const result = await resolveLink(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  it('rejects an expired link', async () => {
    const db = await getDb();
    await db.query(`update assessment_assignments set expires_at = now() - interval '1 hour' where token_hash = $1`, [
      hashToken(token),
    ]);
    const result = await resolveLink(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('accepts a valid link and exposes the assigned student', async () => {
    const result = await resolveLink(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assignment.student_id).toBe(studentId);
      expect(result.assignment.max_attempts).toBe(2);
    }
  });

  it('allows only one live assignment per student per version', async () => {
    const db = await getDb();
    await expect(
      db.query(
        `insert into assessment_assignments
           (organization_id, student_id, assessment_version_id, token_hash, token_hint)
         values ($1, $2, $3, $4, 'zzzz')`,
        [orgId, studentId, versionId, `dupe-${randomUUID()}`],
      ),
    ).rejects.toThrow(/duplicate key/i);
  });
});

describe('attempt lifecycle', () => {
  it('starts an attempt with the full question paper and a server clock', async () => {
    const attempt = await startAttempt(studentActor, token);

    expect(attempt.status).toBe('in_progress');
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.questions).toHaveLength(EXPECTED_QUESTION_COUNT);
    expect(attempt.clock.remainingSeconds).toBeGreaterThan(0);
    expect(attempt.clock.remainingSeconds).toBeLessThanOrEqual(45 * 60);
    // The deadline is derived from the recorded start, not from the browser.
    expect(attempt.clock.expiresAtMs - attempt.clock.startedAtMs).toBe(45 * 60 * 1000);
    expect(attempt.assessment.version).toBe(1);
    expect(attempt.assessment.minCompletionRatio).toBe(0.9);
  });

  it('never sends answer keys to the client', async () => {
    const attempt = await startAttempt(studentActor, token);
    const serialised = JSON.stringify(attempt.questions);
    expect(serialised).not.toContain('"isCorrect":true');
    for (const q of attempt.questions) {
      expect(q.options.every((o) => o.isCorrect === false)).toBe(true);
    }
  });

  it('is idempotent: starting again resumes rather than burning an attempt', async () => {
    const first = await startAttempt(studentActor, token);
    const second = await startAttempt(studentActor, token);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.attemptNumber).toBe(first.attemptNumber);
  });

  it('serves a stable question order across reloads', async () => {
    const a = await startAttempt(studentActor, token);
    const b = await loadAttempt(studentActor, a.sessionId);
    expect(a.questions.map((q) => q.id)).toEqual(b.questions.map((q) => q.id));
  });

  it('persists answers and reports coverage', async () => {
    const attempt = await startAttempt(studentActor, token);
    const answers = answerAll(attempt.questions, (q) =>
      q.type === 'likert' ? HIGH : (q.options[1]?.id ?? ''),
    );

    const result = await saveAnswers(studentActor, attempt.sessionId, answers);
    expect(result.closed).toBe(false);
    expect(result.answeredCount).toBe(EXPECTED_QUESTION_COUNT);

    const reloaded = await loadAttempt(studentActor, attempt.sessionId);
    expect(reloaded.answeredIds).toHaveLength(EXPECTED_QUESTION_COUNT);
  });

  it('ignores a forged option id that the question does not offer', async () => {
    const attempt = await startAttempt(studentActor, token);
    const choiceQuestion = attempt.questions.find((q) => q.type !== 'likert')!;

    const before = await loadAttempt(studentActor, attempt.sessionId);
    await saveAnswers(studentActor, attempt.sessionId, [
      { questionId: choiceQuestion.id, value: 'a-uuid-that-does-not-exist' },
    ]);
    const after = await loadAttempt(studentActor, attempt.sessionId);

    expect(after.answeredIds.length).toBe(before.answeredIds.length);
  });

  it('ignores a question id from a different version', async () => {
    const attempt = await startAttempt(studentActor, token);
    const before = await loadAttempt(studentActor, attempt.sessionId);
    await saveAnswers(studentActor, attempt.sessionId, [
      { questionId: '00000000-0000-0000-0000-0000000000ff', value: '3' },
    ]);
    const after = await loadAttempt(studentActor, attempt.sessionId);
    expect(after.answeredIds.length).toBe(before.answeredIds.length);
  });

  it('persists and clears a review flag', async () => {
    const attempt = await startAttempt(studentActor, token);
    // Pick a likert item so the answer value is unambiguously valid; a choice
    // item would reject "3" as a forged option id.
    const target = attempt.questions.find((q) => q.type === 'likert')!;

    await saveAnswers(studentActor, attempt.sessionId, [{ questionId: target.id, value: '3' }]);
    await setFlag(studentActor, attempt.sessionId, target.id, true);
    expect((await loadAttempt(studentActor, attempt.sessionId)).flaggedIds).toContain(target.id);

    await setFlag(studentActor, attempt.sessionId, target.id, false);
    expect((await loadAttempt(studentActor, attempt.sessionId)).flaggedIds).not.toContain(target.id);
  });

  it('scores a full paper and writes dimension scores and stream matches', async () => {
    const attempt = await startAttempt(studentActor, token);
    await saveAnswers(
      studentActor,
      attempt.sessionId,
      answerAll(attempt.questions, (q, i) =>
        q.type === 'likert' ? String(4 + (i % 2)) : (q.options[0]?.id ?? ''),
      ),
    );

    const result = await submitAttempt(studentActor, attempt.sessionId);
    expect(result.status).toBe('submitted');
    expect(result.reference).toMatch(/^SS-\d{8}-[0-9A-F]{8}$/);
    expect(result.coverage.meetsMinimum).toBe(true);

    const db = await getDb();
    const scores = await db.query<{ dimension_key: string; normalized_score: number; rank: number }>(
      `select dimension_key, normalized_score::float, rank from dimension_scores where session_id = $1`,
      [attempt.sessionId],
    );
    expect(scores.rows).toHaveLength(11);
    for (const row of scores.rows) {
      expect(row.normalized_score).toBeGreaterThanOrEqual(0);
      expect(row.normalized_score).toBeLessThanOrEqual(100);
    }
    // Ranks must be a permutation of 1..11 with no duplicates.
    expect(scores.rows.map((r) => r.rank).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 11 }, (_, i) => i + 1),
    );

    const matches = await db.query<{ match_score: number; band: number; rank: number }>(
      `select match_score::float, band, rank from career_match_results
        where session_id = $1 order by rank`,
      [attempt.sessionId],
    );
    expect(matches.rows).toHaveLength(4);
    const ordered = matches.rows.map((r) => r.match_score);
    expect([...ordered].sort((x, y) => y - x)).toEqual(ordered);
    for (const row of matches.rows) expect([1, 2, 3]).toContain(row.band);

    const report = await db.query<{ status: string; reference: string }>(
      `select status, reference from assessment_reports where session_id = $1`,
      [attempt.sessionId],
    );
    expect(report.rows[0].status).toBe('pending');
    expect(report.rows[0].reference).toBe(result.reference);
  });

  it('produces different scores for different answer patterns', async () => {
    // The answer key position varies across the bank, so a "fully correct"
    // paper has to be derived from the database rather than assumed to be
    // option 0 everywhere.
    const db = await getDb();
    const keyRows = await db.query<{ question_id: string; option_id: string; wrong_id: string }>(
      `select q.id as question_id,
              (select id from question_options o
                where o.question_id = q.id and o.is_correct limit 1) as option_id,
              (select id from question_options o
                where o.question_id = q.id and not o.is_correct limit 1) as wrong_id
         from questions q
         join assessment_sessions s on s.assessment_version_id = q.assessment_version_id
        where s.id = (select id from assessment_sessions order by started_at desc limit 1)
          and q.is_active and q.type <> 'likert'`,
    );
    const correctByQuestion = new Map(keyRows.rows.map((r) => [r.question_id, r.option_id]));
    const wrongByQuestion = new Map(keyRows.rows.map((r) => [r.question_id, r.wrong_id]));

    const run = async (likert: string, pick: 'correct' | 'wrong') => {
      const t = await createAssignment();
      const attempt = await startAttempt(studentActor, t);
      const map = pick === 'correct' ? correctByQuestion : wrongByQuestion;

      await saveAnswers(
        studentActor,
        attempt.sessionId,
        attempt.questions.map((q) => ({
          questionId: q.id,
          value: q.type === 'likert' ? likert : (map.get(q.id) ?? q.options[0]?.id ?? ''),
        })),
      );
      await submitAttempt(studentActor, attempt.sessionId);

      const rows = await db.query<{ dimension_key: string; normalized_score: number }>(
        `select dimension_key, normalized_score::float from dimension_scores where session_id = $1`,
        [attempt.sessionId],
      );
      return new Map(rows.rows.map((r) => [r.dimension_key, r.normalized_score]));
    };

    const allHigh = await run('5', 'correct');
    const allLow = await run('1', 'wrong');

    // Aptitude has no reverse items, so a fully correct paper reaches 100 on
    // every aptitude dimension and a fully wrong one reaches 0.
    for (const key of ['verbal', 'numerical', 'clerical', 'spatial', 'reasoning']) {
      expect(allHigh.get(key)).toBe(100);
      expect(allLow.get(key)).toBe(0);
    }

    // Each interest dimension carries exactly one reverse-worded item, so a
    // maximally positive paper cannot reach 100: agreeing with the reverse item
    // contributes zero. That is the intended effect, not a scoring error.
    for (const key of ['riasec_i', 'riasec_a', 'riasec_c', 'riasec_r', 'riasec_s', 'riasec_e']) {
      expect(allHigh.get(key)!).toBeGreaterThan(allLow.get(key)!);
      expect(allHigh.get(key)!).toBeLessThan(100);
      expect(allHigh.get(key)!).toBeGreaterThan(90);
      expect(allLow.get(key)!).toBeGreaterThan(0);
      expect(allLow.get(key)!).toBeLessThan(10);
    }
  });

  it('collapses a duplicate submit onto the original run', async () => {
    const attempt = await startAttempt(studentActor, token);
    await saveAnswers(
      studentActor,
      attempt.sessionId,
      answerAll(attempt.questions, (q) => (q.type === 'likert' ? '3' : q.options[0]!.id)),
    );

    const [a, b] = await Promise.all([
      submitAttempt(studentActor, attempt.sessionId),
      submitAttempt(studentActor, attempt.sessionId),
    ]);

    expect(a.reference).toBe(b.reference);
    expect(a.reportId).toBe(b.reportId);

    const db = await getDb();
    expect((await db.query(`select id from dimension_scores where session_id = $1`, [attempt.sessionId])).rows)
      .toHaveLength(11);
    expect((await db.query(`select id from assessment_reports where session_id = $1`, [attempt.sessionId])).rows)
      .toHaveLength(1);
  });

  it('refuses further saves once the attempt is closed', async () => {
    const attempt = await startAttempt(studentActor, token);
    await saveAnswers(
      studentActor,
      attempt.sessionId,
      answerAll(attempt.questions, (q) => (q.type === 'likert' ? '3' : q.options[0]!.id)),
    );
    await submitAttempt(studentActor, attempt.sessionId);

    await expect(
      saveAnswers(studentActor, attempt.sessionId, [{ questionId: attempt.questions[0].id, value: '1' }]),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('enforces the attempt limit rather than issuing unlimited retries', async () => {
    const limited = await createAssignment(1);
    const first = await startAttempt(studentActor, limited);
    await saveAnswers(
      studentActor,
      first.sessionId,
      answerAll(first.questions, (q) => (q.type === 'likert' ? '3' : q.options[0]!.id)),
    );
    await submitAttempt(studentActor, first.sessionId);

    // The link is now spent, so it cannot be reopened for a second attempt.
    const reopened = await resolveLink(limited);
    expect(reopened.ok).toBe(false);
    if (!reopened.ok) expect(reopened.reason).toBe('used_up');
  });

  it('builds a narrative grounded in the stored scores', async () => {
    const attempt = await startAttempt(studentActor, token);
    await saveAnswers(
      studentActor,
      attempt.sessionId,
      answerAll(attempt.questions, (q, i) => (q.type === 'likert' ? String(5 - (i % 3)) : q.options[0]!.id)),
    );
    await submitAttempt(studentActor, attempt.sessionId);

    const payload = await buildResultPayload(attempt.sessionId);
    expect(payload.dimensions).toHaveLength(11);
    expect(payload.matches).toHaveLength(4);
    expect(payload.narrative.interpretation.length).toBeGreaterThan(3);
    expect(payload.narrative.recommendations.length).toBeGreaterThan(2);
    expect(payload.narrative.actionPlan).toHaveLength(3);
    expect(payload.narrative.discussionQuestions.length).toBeGreaterThan(3);

    const joined = payload.narrative.interpretation.join(' ');
    // Every narrative must cite a real score and must disclose the absence of norms.
    expect(joined).toMatch(/\d+%/);
    expect(joined).toMatch(/norm group/i);
    expect(payload.narrative.developmentDimensions).toHaveLength(2);
    expect(payload.narrative.strongestDimensions).toHaveLength(3);
  });
});

describe('authorisation boundaries', () => {
  it('denies a student access to another student attempt', async () => {
    const attempt = await startAttempt(studentActor, token);
    const impostor: Actor = {
      ...studentActor,
      studentId: '11111111-1111-1111-1111-111111111111',
    };
    await expect(loadAttempt(impostor, attempt.sessionId)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('denies a caller with no student record', async () => {
    const anonymous: Actor = {
      userId: '22222222-2222-2222-2222-222222222222',
      role: 'student',
      organizationId: null,
      displayName: 'Nobody',
      studentId: null,
    };
    await expect(startAttempt(anonymous, token)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('denies a student in a different organisation', async () => {
    const db = await getDb();
    await db.query(
      `update organizations set name = name where slug = 'greenfield-vidyalaya'`,
    );
    const crossOrg: Actor = {
      ...studentActor,
      organizationId: '33333333-3333-3333-3333-333333333333',
    };
    await expect(startAttempt(crossOrg, token)).rejects.toBeInstanceOf(AuthorizationError);
  });
});
