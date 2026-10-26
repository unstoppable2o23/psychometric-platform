/**
 * End-to-end smoke run: seed -> attempt -> answer -> submit -> render PDF.
 *
 * Proves the whole vertical slice works against a real database without needing
 * the UI or any external credentials. Prints the report path and page count so
 * the output can be eyeballed.
 *
 *   npx tsx scripts/demo-report.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/server/db/client';
import { seed } from '../src/server/db/seed';
import { renderReport } from '../src/server/reports/render';
import { unicodeFontAvailable } from '../src/server/reports/fonts';
import { saveAnswers, startAttempt, submitAttempt } from '../src/server/dal/attempts';
import type { Actor } from '../src/server/dal/actor';
import { generateAssessmentToken, hashToken } from '../src/server/auth/tokens';

async function main(): Promise<void> {
  await seed();
  const db = await getDb();

  const who = await db.query<{ user_id: string; student_id: string; org: string }>(
    `select p.id as user_id, s.id as student_id, s.organization_id as org
       from profiles p join students s on s.user_id = p.id
      where p.email = 'student@psychometric.local'`,
  );
  const row = who.rows[0];

  const versionId = (
    await db.query<{ id: string }>(
      `select av.id from assessment_versions av join assessments a on a.id = av.assessment_id
        where a.slug = 'stream-selector' and av.status = 'published'`,
    )
  ).rows[0].id;

  const token = generateAssessmentToken();
  await db.query(
    `update assessment_assignments set revoked_at = now(), status = 'revoked'
      where student_id = $1 and status in ('assigned','in_progress')`,
    [row.student_id],
  );
  await db.query(
    `insert into assessment_assignments (organization_id, student_id, assessment_version_id, token_hash, token_hint)
     values ($1,$2,$3,$4,'demo')`,
    [row.org, row.student_id, versionId, hashToken(token)],
  );

  const actor: Actor = {
    userId: row.user_id,
    role: 'student',
    organizationId: row.org,
    displayName: 'Aarav Sharma',
    studentId: row.student_id,
  };

  const attempt = await startAttempt(actor, token);

  // A deliberately mixed paper: aptitude accuracy and interest strength both
  // vary by dimension, so the resulting profile is not flat.
  const aptitudeHits: Record<string, number> = {
    verbal: 12, numerical: 14, clerical: 8, spatial: 6, reasoning: 10,
  };
  const seen: Record<string, number> = {};

  await saveAnswers(
    actor,
    attempt.sessionId,
    attempt.questions.map((q) => {
      const budget = aptitudeHits[q.dimensionKey];
      const index = (seen[q.dimensionKey] ?? 0) + 1;
      seen[q.dimensionKey] = index;

      if (q.type === 'likert') {
        // Spread the interest answers so the profile has a shape.
        const offset = ['riasec_i', 'riasec_r', 'riasec_s'].includes(q.dimensionKey) ? 1 : 0;
        return { questionId: q.id, value: String(Math.min(5, 3 + offset - (index % 3))) };
      }
      return { questionId: q.id, value: index <= (budget ?? 0) ? q.options[0].id : q.options[1].id };
    }),
  );

  const result = await submitAttempt(actor, attempt.sessionId);
  console.log(`  submitted -> ${result.reference} (${result.status})`);

  const reportRows = await db.query<{ id: string }>(
    `select id from assessment_reports where session_id = $1`,
    [attempt.sessionId],
  );
  const reportId = reportRows.rows[0].id;

  const started = Date.now();
  const outcome = await renderReport(reportId);
  console.log(`  rendered  -> ${outcome.byteSize} bytes in ${Date.now() - started}ms`);
  console.log(`             ${outcome.storagePath}`);
  console.log(`             ${outcome.pageCountNote}`);

  const bytes = fs.readFileSync(outcome.storagePath);
  const text = bytes.toString('latin1');
  const pageMatches = text.match(/\/Type\s*\/Page[^s]/g);
  console.log(`  page count: ${pageMatches ? pageMatches.length : 'unknown'}`);
  console.log(`  unicode font installed: ${unicodeFontAvailable()}`);
  console.log(`  PDF header: ${text.slice(0, 8)}`);

  const statusRows = await db.query<{ status: string; error: string | null }>(
    `select status, error from assessment_reports where id = $1`,
    [reportId],
  );
  const status = statusRows.rows[0];
  console.log(`  report status: ${status.status}${status.error ? ` (${status.error})` : ''}`);
  console.log(`\n  open: ${path.resolve(outcome.storagePath)}\n`);

  process.exit(status.status === 'ready' ? 0 : 1);
}

main().catch((err) => {
  console.error((err as Error).stack);
  process.exit(1);
});
