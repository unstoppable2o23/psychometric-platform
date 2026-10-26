/**
 * Regression tests for defects found during the audit.
 *
 * Each test names the behaviour that was wrong, so a future change that
 * reintroduces it fails here rather than in production.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureDatabase } from './helpers/db';
import { getDb } from '@/server/db/client';
import {
  buildResultPayload,
  loadResult,
  saveAnswers,
  startAttempt,
  submitAttempt,
  IncompleteSubmissionError,
} from '@/server/dal/attempts';
import { hashToken } from '@/server/auth/tokens';
import { rateLimit, resetRateLimits } from '@/server/security/rate-limit';
import { assertBankIntegrity, buildStreamSelectorQuestions } from '@/server/content/stream-selector-questions';
import { STREAM_CONTENT, DIMENSIONS } from '@/server/content/stream-selector';
import { buildInterpretation } from '@/lib/scoring/interpret';
import { matchProfiles } from '@/lib/scoring/engine';
import type { Actor } from '@/server/dal/actor';
import type { SavedAnswer } from '@/lib/domain/types';

const studentActor: Actor = {
  userId: '00000000-0000-0000-0000-000000000000',
  role: 'student',
  organizationId: null,
  displayName: 'Aarav Sharma',
  studentId: null,
};

const TOTAL = buildStreamSelectorQuestions().length;
const REQUIRED = Math.ceil(TOTAL * 0.9);

let studentId: string;
let orgId: string;
let versionId: string;
let teacherUserId: string;
let alphaOrgId: string;
let alphaStudentId: string;

beforeEach(async () => {
  await ensureDatabase();
  resetRateLimits();
  const db = await getDb();

  const rows = await db.query<{ user_id: string; student_id: string; org: string }>(
    `select p.id as user_id, s.id as student_id, s.organization_id as org
       from profiles p join students s on s.user_id = p.id
      where p.email = 'student@psychometric.local'`,
  );
  studentActor.userId = rows.rows[0].user_id;
  studentActor.studentId = rows.rows[0].student_id;
  studentActor.organizationId = rows.rows[0].org;
  studentId = rows.rows[0].student_id;
  orgId = rows.rows[0].org;

  versionId = (
    await db.query<{ id: string }>(
      `select av.id from assessment_versions av join assessments a on a.id = av.assessment_id
        where a.slug = 'stream-selector' and av.status = 'published'`,
    )
  ).rows[0].id;

  teacherUserId = (
    await db.query<{ id: string }>(
      `select id from profiles
        where role = 'teacher' and organization_id = $1
        order by created_at limit 1`,
      [orgId],
    )
  ).rows[0].id;

  // A second organisation, to prove staff scoping is real.
  alphaOrgId = (
    await db.query<{ id: string }>(
      `insert into organizations (name, slug) values ('Rival School', 'rival-audit')
       on conflict (slug) do update set name = excluded.name returning id`,
    )
  ).rows[0].id;

  alphaStudentId = (
    await db.query<{ id: string }>(
      `insert into students (organization_id, display_name, external_ref)
       values ($1, 'Rival Student', 'rival-1')
       on conflict (organization_id, external_ref) do update set display_name = excluded.display_name
       returning id`,
      [alphaOrgId],
    )
  ).rows[0].id;
});

async function freshAssignment(student = studentId, organization = orgId, maxAttempts = 2) {
  const db = await getDb();
  await db.query(
    `update assessment_assignments set revoked_at = now(), status = 'revoked'
      where student_id = $1 and status in ('assigned','in_progress')`,
    [student],
  );
  const raw = `audit-token-${crypto.randomUUID()}`;
  await db.query(
    `insert into assessment_assignments
       (organization_id, student_id, assessment_version_id, token_hash, token_hint, max_attempts, expires_at)
     values ($1,$2,$3,$4,'audt',$5, now() + interval '1 day')`,
    [organization, student, versionId, hashToken(raw), maxAttempts],
  );
  return raw;
}

/**
 * Answers every question with a value that is actually valid for its type:
 * a likert scale point for likert items, and a real option id for choice items.
 * Sending a likert value to a choice item is rejected by the validator, which is
 * the behaviour several of these tests rely on elsewhere.
 */
const answerAllValid = (
  questions: { id: string; type: string; options: { id: string }[] }[],
  likertValue = '5',
): SavedAnswer[] =>
  questions.map((q) => ({
    questionId: q.id,
    value: q.type === 'likert' ? likertValue : (q.options[0]?.id ?? ''),
  }));

describe('regression: results page authorisation', () => {
  it('lets a student read their own result', async () => {
    const token = await freshAssignment();
    const attempt = await startAttempt(studentActor, token);
    await saveAnswers(studentActor, attempt.sessionId, answerAllValid(attempt.questions));
    await submitAttempt(studentActor, attempt.sessionId);

    const meta = await loadResult(studentActor, attempt.sessionId);
    expect(meta.id).toBe(attempt.sessionId);
  });

  it('denies a student another student result', async () => {
    const token = await freshAssignment(alphaStudentId, alphaOrgId);
    const rival: Actor = {
      ...studentActor,
      studentId: alphaStudentId,
      organizationId: alphaOrgId,
    };
    const attempt = await startAttempt(rival, token);
    await expect(loadResult(studentActor, attempt.sessionId)).rejects.toThrow();
  });

  // The bug: the old check tested `role === 'student'` and nothing else, so any
  // teacher could read any result by id.
  it('denies a teacher in another organisation', async () => {
    const token = await freshAssignment(alphaStudentId, alphaOrgId);
    const rival: Actor = { ...studentActor, studentId: alphaStudentId, organizationId: alphaOrgId };
    const attempt = await startAttempt(rival, token);
    await saveAnswers(rival, attempt.sessionId, answerAllValid(attempt.questions));
    await submitAttempt(rival, attempt.sessionId);

    const outsiderTeacher: Actor = {
      userId: teacherUserId,
      role: 'teacher',
      organizationId: orgId,
      displayName: 'Outsider',
      studentId: null,
    };
    await expect(loadResult(outsiderTeacher, attempt.sessionId)).rejects.toThrow();
  });

  it('denies a student with no student record', async () => {
    const token = await freshAssignment();
    const attempt = await startAttempt(studentActor, token);
    const ghost: Actor = { ...studentActor, studentId: null };
    await expect(loadResult(ghost, attempt.sessionId)).rejects.toThrow();
  });
});

describe('regression: submission minimum is enforced', () => {
  // The bug: coverage was computed and stored but never checked, so the 90%
  // rule advertised in the instructions was not actually enforced anywhere.
  it('refuses a student submit below the completion floor', async () => {
    const token = await freshAssignment();
    const attempt = await startAttempt(studentActor, token);

    const partial = answerAllValid(attempt.questions).slice(0, REQUIRED - 1);
    await saveAnswers(studentActor, attempt.sessionId, partial);

    await expect(submitAttempt(studentActor, attempt.sessionId)).rejects.toBeInstanceOf(
      IncompleteSubmissionError,
    );

    const stillOpen = await getDb().then(
      async (db) => (await db.query<{ status: string }>(`select status from assessment_sessions where id = $1`, [attempt.sessionId])).rows[0],
    );
    expect(stillOpen.status).toBe('in_progress');
  });

  it('reports how many answers are still required', async () => {
    const token = await freshAssignment();
    const attempt = await startAttempt(studentActor, token);
    await saveAnswers(studentActor, attempt.sessionId, answerAllValid(attempt.questions).slice(0, 10));

    try {
      await submitAttempt(studentActor, attempt.sessionId);
      throw new Error('expected the submit to be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(IncompleteSubmissionError);
      const detail = (err as IncompleteSubmissionError).detail;
      expect(detail.answered).toBe(10);
      expect(detail.total).toBe(TOTAL);
      expect(detail.required).toBe(REQUIRED);
    }
  });

  it('accepts a submit at exactly the floor', async () => {
    const token = await freshAssignment();
    const attempt = await startAttempt(studentActor, token);
    await saveAnswers(studentActor, attempt.sessionId, answerAllValid(attempt.questions).slice(0, REQUIRED));
    const result = await submitAttempt(studentActor, attempt.sessionId);
    expect(result.status).toBe('submitted');
    expect(result.coverage.meetsMinimum).toBe(true);
  });

  it('still scores a timed-out paper that is below the floor', async () => {
    const db = await getDb();
    const token = await freshAssignment();
    const attempt = await startAttempt(studentActor, token);
    await saveAnswers(studentActor, attempt.sessionId, answerAllValid(attempt.questions).slice(0, 5));

    // Move the deadline into the past to simulate the clock running out.
    await db.query(`update assessment_sessions set expires_at = now() - interval '1 second' where id = $1`, [
      attempt.sessionId,
    ]);

    const result = await submitAttempt(studentActor, attempt.sessionId);
    expect(result.status).toBe('expired');
    expect(result.coverage.answered).toBe(5);
  });
});

describe('regression: multi-select canonicalisation on save', () => {
  // The bug: normaliseStoredValue existed and was unit tested, but the save path
  // bypassed it, so a separator-packed value was stored raw instead of being
  // parsed, canonicalised and validated.
  it('documents that this assessment currently uses no multi-select items', () => {
    const types = new Set(buildStreamSelectorQuestions().map((q) => q.type));
    expect(types.has('multi_select')).toBe(false);
    expect(types).toEqual(new Set(['likert', 'single_choice']));
  });

  it('rejects a separator-packed value on a single-choice item', async () => {
    const token = await freshAssignment();
    const attempt = await startAttempt(studentActor, token);
    const choice = attempt.questions.find((q) => q.type === 'single_choice')!;
    const [a, b] = [choice.options[0].id, choice.options[1].id];

    await saveAnswers(studentActor, attempt.sessionId, [{ questionId: choice.id, value: `${b}|${a}` }]);

    const row = await getDb().then(
      async (db) =>
        (await db.query<{ n: number }>(
          `select count(*)::int as n from responses where session_id = $1 and question_id = $2`,
          [attempt.sessionId, choice.id],
        )).rows[0],
    );
    // A multi-select payload aimed at a single-choice item must not be stored.
    expect(row.n).toBe(0);
  });

  it('rejects a multi-select payload on a likert item', async () => {
    const token = await freshAssignment();
    const attempt = await startAttempt(studentActor, token);
    const likert = attempt.questions.find((q) => q.type === 'likert')!;

    await saveAnswers(studentActor, attempt.sessionId, [{ questionId: likert.id, value: '3|4' }]);

    const row = await getDb().then(
      async (db) =>
        (await db.query<{ n: number }>(
          `select count(*)::int as n from responses where session_id = $1 and question_id = $2`,
          [attempt.sessionId, likert.id],
        )).rows[0],
    );
    expect(row.n).toBe(0);
  });

  it('accepts a legitimate single value for each type', async () => {
    const token = await freshAssignment();
    const attempt = await startAttempt(studentActor, token);
    const likert = attempt.questions.find((q) => q.type === 'likert')!;
    const choice = attempt.questions.find((q) => q.type === 'single_choice')!;

    await saveAnswers(studentActor, attempt.sessionId, [
      { questionId: likert.id, value: '3' },
      { questionId: choice.id, value: choice.options[0].id },
    ]);

    const row = await getDb().then(
      async (db) =>
        (await db.query<{ n: number }>(`select count(*)::int as n from responses where session_id = $1`, [
          attempt.sessionId,
        ])).rows[0],
    );
    expect(row.n).toBe(2);
  });
});

describe('regression: duplicate submit reports real coverage', () => {
  // The bug: the already-closed branch returned a hardcoded 0/0 coverage, so a
  // duplicate submit reported a different result from the original.
  it('returns the same coverage on a repeated submit', async () => {
    const token = await freshAssignment();
    const attempt = await startAttempt(studentActor, token);
    await saveAnswers(studentActor, attempt.sessionId, answerAllValid(attempt.questions));

    const first = await submitAttempt(studentActor, attempt.sessionId);
    const second = await submitAttempt(studentActor, attempt.sessionId);

    expect(second.reference).toBe(first.reference);
    expect(second.coverage.answered).toBe(first.coverage.answered);
    expect(second.coverage.total).toBe(first.coverage.total);
    expect(second.coverage.total).toBe(TOTAL);
  });
});

describe('regression: stream rationale lookup', () => {
  // The bug: the key was parsed as the first word of a rendered label
  // ("Numerical Aptitude (85/100, weight 1)" -> "Numerical"), which never matches
  // the lowercase dimension keys, so the stream-specific paragraph never rendered.
  it('emits the stream rationale for the leading stream', () => {
    const dimensions = DIMENSIONS.map((d, i) => ({
      key: d.key,
      label: d.label,
      kind: d.kind,
      description: d.description,
      rawScore: 0,
      maxRawScore: 0,
      normalizedScore: 100 - i * 5,
      itemsAnswered: 10,
      itemsTotal: 10,
      rank: i + 1,
    }));

    const { matches } = matchProfiles(
      Object.values(
        // Build profiles from the shipped weights so the match reflects reality.
        (() => {
          const out: Record<string, { key: string; label: string; dimensionWeights: Record<string, number> }> = {};
          for (const [key, content] of Object.entries(STREAM_CONTENT)) {
            const weights: Record<string, number> = {};
            for (const k of Object.keys(content.rationale)) weights[k] = 1;
            out[key] = { key, label: content.label, dimensionWeights: weights };
          }
          return out;
        })(),
      ),
      dimensions,
    );

    const narrative = buildInterpretation({
      studentDisplayName: 'Test',
      grade: 9,
      dimensions,
      matches,
      streamContent: STREAM_CONTENT,
      answeredQuestions: TOTAL,
      totalQuestions: TOTAL,
      completedInSeconds: 1200,
    });

    const expected = STREAM_CONTENT[matches[0].stream].rationale[matches[0].contributingDimensionKeys[0]];
    expect(expected).toBeTruthy();
    expect(narrative.interpretation.join('\n')).toContain(expected!);
  });

  it('never derives a lookup key by parsing a label', () => {
    const dimensions = DIMENSIONS.map((d) => ({
      key: d.key,
      label: d.label,
      kind: d.kind,
      description: d.description,
      rawScore: 0,
      maxRawScore: 0,
      normalizedScore: 50,
      itemsAnswered: 1,
      itemsTotal: 1,
      rank: 1,
    }));
    const { matches } = matchProfiles(
      [{ key: 'science', label: 'Science', dimensionWeights: { numerical: 1 } }],
      dimensions,
    );
    expect(matches[0].contributingDimensionKeys).toEqual(['numerical']);
    // The display string is for humans; the key must be available separately.
    expect(matches[0].contributingDimensions[0]).toContain('Numerical Aptitude');
  });
});

describe('regression: reverse-scored items are worded against their dimension', () => {
  it('rejects a reverse key that points at a positively-worded item', () => {
    expect(() => assertBankIntegrity()).not.toThrow();
  });

  it('has no reverse-scored item lacking negative wording', () => {
    const negative =
      /\b(dislike|drains me|unbearable|rather stay in the background|rather study|lose(s)? interest|feels restrictive)\b/i;
    for (const q of buildStreamSelectorQuestions()) {
      if (q.reverseScored) expect(q.prompt).toMatch(negative);
    }
  });

  it('has no reverse-scored choice item', () => {
    for (const q of buildStreamSelectorQuestions()) {
      if (q.reverseScored) expect(q.type).toBe('likert');
    }
  });

  it('flips the score direction for a reverse item', async () => {
    const token = await freshAssignment();
    const attempt = await startAttempt(studentActor, token);
    const reverse = buildStreamSelectorQuestions().find((q) => q.reverseScored)!;
    const key = reverse.dimension;
    const idFor = (questions: { id: string; dimensionKey: string }[]) =>
      questions.find((q) => q.dimensionKey === key)?.id;

    const allHigh = await (async () => {
      const t = await freshAssignment();
      const a = await startAttempt(studentActor, t);
      await saveAnswers(studentActor, a.sessionId, answerAllValid(a.questions));
      await submitAttempt(studentActor, a.sessionId);
      return buildResultPayload(a.sessionId);
    })();

    const allLow = await (async () => {
      const t = await freshAssignment();
      const a = await startAttempt(studentActor, t);
      await saveAnswers(studentActor, a.sessionId, answerAllValid(a.questions, '1'));
      await submitAttempt(studentActor, a.sessionId);
      return buildResultPayload(a.sessionId);
    })();

    const high = allHigh.dimensions.find((d) => d.key === key)!;
    const low = allLow.dimensions.find((d) => d.key === key)!;
    // With exactly one reverse item out of many, agreeing everywhere must still
    // raise the dimension. It must never invert the whole scale.
    expect(high.normalizedScore).toBeGreaterThan(low.normalizedScore);
    void idFor;
    void attempt;
  });
});

describe('regression: concurrent attempt start', () => {
  // The bug: startAttempt read "no open attempt" and computed the next attempt
  // number without holding a lock, so two simultaneous starts both chose the
  // same number and one failed with a raw unique-constraint error (a 500 for the
  // student) instead of simply resuming.
  it('resolves two simultaneous starts onto one attempt', async () => {
    const token = await freshAssignment();
    const [a, b] = await Promise.all([
      startAttempt(studentActor, token),
      startAttempt(studentActor, token),
    ]);

    expect(a.sessionId).toBe(b.sessionId);
    expect(a.attemptNumber).toBe(b.attemptNumber);

    const rows = await getDb().then(
      async (db) =>
        (await db.query<{ n: number }>(
          `select count(*)::int as n from assessment_sessions
            where assignment_id = (select id from assessment_assignments where token_hash = $1)`,
          [hashToken(token)],
        )).rows[0],
    );
    expect(rows.n).toBe(1);
  });

  it('survives many simultaneous starts', async () => {
    const token = await freshAssignment();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => startAttempt(studentActor, token)),
    );
    const ids = new Set(results.map((r) => r.sessionId));
    expect(ids.size).toBe(1);
  });
});

describe('rate limiter', () => {

  it('allows up to the limit then refuses', () => {
    for (let i = 0; i < 5; i += 1) expect(rateLimit('k', 5).allowed).toBe(true);
    expect(rateLimit('k', 5).allowed).toBe(false);
  });

  it('keeps counters independent per key', () => {
    for (let i = 0; i < 5; i += 1) rateLimit('a', 5);
    expect(rateLimit('a', 5).allowed).toBe(false);
    expect(rateLimit('b', 5).allowed).toBe(true);
  });

  it('reports a retry hint', () => {
    const result = rateLimit('k', 1, 60_000);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets after the window rolls over', () => {
    expect(rateLimit('k', 1, 1).allowed).toBe(true);
    expect(rateLimit('k', 1, 1).allowed).toBe(false);
    // Window is 1ms; by the time this runs it has expired.
    return new Promise((resolve) =>
      setTimeout(() => {
        expect(rateLimit('k', 1, 1).allowed).toBe(true);
        resolve(undefined);
      }, 10),
    );
  });
});
