/**
 * Report rendering pipeline.
 *
 * Renders on the server, stores the PDF bytes with the report row, and records
 * status so a failure is visible and recoverable rather than a silently missing
 * download.
 *
 * Why the database rather than a directory: serverless hosts (Vercel) provide a
 * read-only bundle and an ephemeral /tmp, so a filesystem path is not a durable
 * store. A local file is still written when the directory is writable, because
 * the demo and inspection scripts read it directly.
 *
 * Scope note: for this slice rendering is synchronous with the submit request.
 * The status transitions (pending -> generating -> ready/failed) are already in
 * place so moving the work to a background queue is a change of `renderReport`'s
 * caller, not a rewrite of this module.
 */
import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderToBuffer } from '@react-pdf/renderer';
import { getDb } from '../db/client';
import { env } from '../env';
import { buildResultPayload } from '../dal/attempts';
import { STREAM_CONTENT } from '../content/stream-selector';
import { DISCLAIMER } from '@/lib/scoring/interpret';
import { StreamSelectorReport, type ReportInput } from './stream-selector-report';
import { unicodeFontAvailable } from './fonts';

export interface RenderOutcome {
  reportId: string;
  /** Filesystem path when one could be written, otherwise `db:<reference>`. */
  storagePath: string;
  byteSize: number;
  pageCountNote: string;
}

/** Reports live outside `public/`, so they are never served as static files. */
function storageRoot(): string {
  if (path.isAbsolute(env.REPORT_STORAGE_DIR)) return env.REPORT_STORAGE_DIR;
  // Report files are runtime data, not part of the build graph. The deployment
  // warning about dynamic filesystem access is expected here and is scoped away
  // with outputFileTracingIncludes in next.config.ts instead of in this call.
  return path.join(process.cwd(), env.REPORT_STORAGE_DIR);
}

export async function renderReport(reportId: string): Promise<RenderOutcome> {
  const db = await getDb();

  const row = (
    await db.query<{ session_id: string; reference: string }>(
      `select session_id, reference from assessment_reports where id = $1`,
      [reportId],
    )
  ).rows[0];

  if (!row) throw new Error(`report ${reportId} not found`);

  await db.query(`update assessment_reports set status = 'generating', error = null where id = $1`, [
    reportId,
  ]);

  try {
    const { meta, dimensions, matches, narrative } = await buildResultPayload(row.session_id);
    const context = (
      await db.query<{ display_name: string; grade: number | null; school_name: string | null; started_at: Date }>(
        `select st.display_name, st.grade, o.name as school_name, s.started_at
           from assessment_sessions s
           join students st on st.id = s.student_id
           join organizations o on o.id = s.organization_id
          where s.id = $1`,
        [row.session_id],
      )
    ).rows[0];

    const input: ReportInput = {
      studentName: context.display_name,
      grade: context.grade,
      schoolName: context.school_name,
      assessmentTitle: meta.title,
      assessmentVersion: meta.version,
      reference: row.reference,
      completedAt: meta.submitted_at,
      generatedAt: new Date(),
      answeredQuestions: meta.answered_count,
      totalQuestions: meta.question_count,
      durationMinutes: Math.max(1, Math.round((meta.submitted_at.getTime() - context.started_at.getTime()) / 60000)),
      dimensions,
      streams: matches,
      streamSubjects: Object.fromEntries(
        Object.entries(STREAM_CONTENT).map(([key, value]) => [key, value.subjects]),
      ),
      narrative,
      disclaimer: DISCLAIMER,
    };

    const buffer = await renderToBuffer(<StreamSelectorReport data={input} />);

    // The database copy is authoritative. The file write is a convenience for
    // local tooling and is allowed to fail on a read-only filesystem.
    let storagePath = `db:${row.reference}`;
    try {
      const dir = path.join(storageRoot(), meta.reference);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${row.reference}.pdf`);
      await fs.writeFile(file, buffer);
      storagePath = file;
    } catch {
      // Serverless or read-only storage: `content` still has the bytes.
    }

    await db.query(
      `update assessment_reports
          set status = 'ready',
              storage_path = $2,
              content = $3,
              byte_size = $4,
              generated_at = now()
        where id = $1`,
      [reportId, storagePath, buffer, buffer.byteLength],
    );

    return {
      reportId,
      storagePath,
      byteSize: buffer.byteLength,
      pageCountNote: unicodeFontAvailable()
        ? 'rendered with Unicode font'
        : 'rendered with Helvetica; Devanagari glyphs will not display',
    };
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    await db.query(`update assessment_reports set status = 'failed', error = $2 where id = $1`, [
      reportId,
      message,
    ]);
    throw err;
  }
}
