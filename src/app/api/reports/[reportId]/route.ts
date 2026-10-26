/**
 * Authenticated PDF download.
 *
 * Report files are written outside `public/`, so this route is the only way to
 * reach them. It re-checks authorisation on every request rather than relying on
 * an unguessable URL, because a leaked link must not grant access to a student's
 * results.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/server/db/client';
import { resolveActor } from '@/server/dal/actor';
import { env } from '@/server/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ reportId: string }> },
): Promise<NextResponse> {
  const { reportId } = await params;

  const resolved = await resolveActor();
  if (!resolved.ok) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  const actor = resolved.actor;

  const db = await getDb();
  const row = (
    await db.query<{
      student_id: string;
      organization_id: string;
      status: string;
      storage_path: string | null;
      content: Buffer | Uint8Array | null;
      reference: string;
    }>(
      `select student_id, organization_id, status, storage_path, content, reference
         from assessment_reports where id = $1`,
      [reportId],
    )
  ).rows[0];

  const denied = () =>
    NextResponse.json({ error: 'Report not available' }, { status: 404 });

  if (!row) return denied();

  // Authorisation: own result, or staff in the owning organisation, or admin.
  const permitted =
    actor.role === 'admin' ||
    (actor.role === 'student' && actor.studentId === row.student_id) ||
    (actor.role === 'teacher' && actor.organizationId === row.organization_id);

  if (!permitted) return denied();
  if (row.status !== 'ready') return denied();

  // Prefer the database copy: it works on hosts with an ephemeral filesystem.
  let bytes: Uint8Array | null = null;
  if (row.content) {
    bytes = row.content instanceof Uint8Array ? row.content : new Uint8Array(row.content as unknown as ArrayBuffer);
  } else if (row.storage_path) {
    // Legacy rows generated before the content column was added. The path
    // guard below keeps a tampered row from becoming an arbitrary file read.
    const root = path.resolve(
      path.isAbsolute(env.REPORT_STORAGE_DIR)
        ? env.REPORT_STORAGE_DIR
        : path.join(process.cwd(), env.REPORT_STORAGE_DIR),
    );
    const target = path.resolve(row.storage_path);
    if (!target.startsWith(root + path.sep)) return denied();
    try {
      bytes = new Uint8Array(await fs.readFile(target));
    } catch {
      return denied();
    }
  }

  if (!bytes) return denied();

  const filename = `${row.reference}.pdf`;

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.byteLength),
      // Inline rather than attachment keeps the reference visible in the tab.
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
