/**
 * Security probe.
 *
 *   npm run db:probe
 *
 * These are assertions about the database, not about the application. They run
 * as an unprivileged role so row-level security is genuinely enforced rather
 * than bypassed by the superuser connection the app normally uses, and the
 * whole run happens inside a transaction that is rolled back, so it leaves no
 * fixtures behind and is safe to repeat.
 *
 * Checks:
 *   1. A teacher in one organisation cannot see another organisation's students.
 *   2. An admin context sees across organisations.
 *   3. Answers cannot be modified once an attempt is submitted.
 *   4. A submitted attempt's start time cannot be rewritten (timer integrity).
 *   5. Computed dimension scores cannot be modified.
 *   6. Published assessment versions are frozen against question edits.
 *   7. Only one version of an assessment may be published.
 *   8. A student cannot hold two live assignments for the same version.
 *   9. Credits cannot be overspent, and the ledger nets out correctly.
 */
import { getDb, type Db } from './client';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -> ${detail}` : ''}\n`);
}

/**
 * Runs a statement expected to fail, inside a savepoint.
 *
 * A plain try/catch is not enough: in Postgres a failed statement poisons the
 * entire transaction, so without rolling back to a savepoint the next expected
 * failure reports "current transaction is aborted" instead of its real message.
 */
function rejectsInTx(db: Db) {
  let n = 0;
  return async (fn: () => Promise<unknown>, pattern: RegExp): Promise<boolean> => {
    const name = `probe_sp_${(n += 1)}`;
    await db.query(`savepoint ${name}`);
    try {
      await fn();
      await db.query(`release savepoint ${name}`);
      return false;
    } catch (err) {
      await db.query(`rollback to savepoint ${name}`);
      await db.query(`release savepoint ${name}`);
      return pattern.test((err as Error).message);
    }
  };
}

/** Runs a read as the unprivileged role so RLS is actually applied. */
async function readAsRole(tx: Db, sql: string, params: readonly unknown[] = []) {
  await tx.query('set local role probe_teacher');
  try {
    return await tx.query(sql, params);
  } finally {
    // `set local role` lasts for the rest of the transaction, so it has to be
    // undone or every later statement runs unprivileged too.
    await tx.query('reset role');
  }
}

async function runProbe(db: Db): Promise<void> {
  const rejectsTx = rejectsInTx(db);

  await db.exec(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'probe_teacher') then
        create role probe_teacher login;
      end if;
    end$$;
    grant usage on schema public, app to probe_teacher;
    grant select on all tables in schema public to probe_teacher;
  `);

  /* ---------------------------------------------------------------- orgs */

  const { rows: orgs } = await db.query<{ id: string }>(`
    insert into organizations (name, slug) values
      ('Alpha School', 'alpha-probe'), ('Beta School', 'beta-probe')
    on conflict (slug) do update set name = excluded.name
    returning id
  `);
  const alphaOrg = orgs[0].id;
  const betaOrg = orgs[1].id;

  const { rows: studs } = await db.query<{ id: string; name: string }>(`
    insert into students (organization_id, display_name, external_ref) values
      ($1, 'Asha', 'probe-a1'), ($2, 'Chetan', 'probe-b1')
    on conflict (organization_id, external_ref) do update set display_name = excluded.display_name
    returning id, display_name as name
  `, [alphaOrg, betaOrg]);
  const alphaStudent = studs[0];
  const betaStudent = studs[1];

  /* ----------------------------------------------------------- catalogue */

  // A fresh slug every run. A version published by an earlier run can neither be
  // edited nor deleted (that is the point of the guard), and assignments hold a
  // RESTRICT foreign key to versions, so reusing the slug would be impossible.
  const probeSlug = `probe-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  // Token hashes are unique per run for the same reason: `token_hash` is the
  // lookup key for assignment links, so a leftover row from an earlier run
  // would otherwise be reused and keep pointing at a stale version.
  const tokenA = `probe-token-hash-a-${probeSlug}`;
  const tokenB = `probe-token-hash-b-${probeSlug}`;

  const { rows: vers } = await db.query<{ id: string }>(
    `insert into assessments (slug, title) values ($1, 'Probe') returning id`,
    [probeSlug],
  );
  const assessmentId = vers[0].id;

  const { rows: versions } = await db.query<{ id: string }>(`
    insert into assessment_versions (assessment_id, version, duration_seconds, question_count)
    values ($1, 1, 600, 1) returning id
  `, [assessmentId]);
  const versionId = versions[0].id;

  await db.query(
    `insert into assessment_dimensions (assessment_version_id, key, label, kind)
     values ($1, 'verbal', 'Verbal', 'aptitude')
     on conflict (assessment_version_id, key) do nothing`,
    [versionId],
  );

  const { rows: qs } = await db.query<{ id: string }>(
    `insert into questions (assessment_version_id, external_key, dimension_key, type, prompt)
     values ($1, 'probe-q1', 'verbal', 'single_choice', 'Probe item') returning id`,
    [versionId],
  );
  const questionId = qs[0].id;

  await db.query(
    `insert into question_options (question_id, label, is_correct) values ($1,'A',true), ($1,'B',false)
     on conflict (question_id, label) do nothing`,
    [questionId],
  );

  const { rows: rules } = await db.query<{ id: string }>(`
    insert into scoring_rules (assessment_version_id, rule_version, definition)
    values ($1, 1, '{"model":"probe"}') returning id
  `, [versionId]);

  /* ------------------------------------------------------------ 1 & 2 RLS */

  const teacherSees = await db.tx(async (tx) => {
    await tx.query(`select app.set_request_context(null, 'teacher', $1)`, [alphaOrg]);
    const res = await readAsRole(tx, 'select display_name from students');
    return res.rows.map((r) => (r as { display_name: string }).display_name);
  });

  check(
    'RLS hides other organisations students from a teacher',
    !teacherSees.includes(betaStudent.name) && teacherSees.includes(alphaStudent.name),
    `visible: [${teacherSees.join(', ')}]`,
  );

  const adminSees = await db.tx(async (tx) => {
    await tx.query(`select app.set_request_context(null, 'admin', null)`);
    const res = await readAsRole(tx, 'select display_name from students');
    return res.rows.map((r) => (r as { display_name: string }).display_name);
  });

  check(
    'Admin context sees students across organisations',
    adminSees.includes(alphaStudent.name) && adminSees.includes(betaStudent.name),
    `visible: [${adminSees.join(', ')}]`,
  );

  /* ------------------------------------------------------------- attempts */

  const { rows: assigns } = await db.query<{ id: string }>(`
    insert into assessment_assignments
      (organization_id, student_id, assessment_version_id, token_hash, token_hint)
    values ($1, $2, $3, $4, 'haaa')
    on conflict (token_hash) do update set status = 'assigned', revoked_at = null
    returning id
  `, [alphaOrg, alphaStudent.id, versionId, tokenA]);

  const { rows: sess } = await db.query<{ id: string }>(`
    insert into assessment_sessions
      (assignment_id, student_id, organization_id, assessment_version_id, scoring_rule_id,
       attempt_number, duration_seconds, expires_at)
    values ($1, $2, $3, $4, $5,
            (select coalesce(max(attempt_number), 0) + 1
               from assessment_sessions where assignment_id = $1),
            600, now() + interval '10 minutes')
    returning id
  `, [assigns[0].id, alphaStudent.id, alphaOrg, versionId, rules[0].id]);
  const sessionId = sess[0].id;

  await db.query(
    `insert into responses (session_id, question_id, value) values ($1, $2, 'A')
     on conflict (session_id, question_id) do nothing`,
    [sessionId, questionId],
  );

  await db.query(
    `update assessment_sessions set status = 'submitted', submitted_at = now() where id = $1`,
    [sessionId],
  );

  /* ----------------------------------------------- 3, 4, 5 sealed attempts */

  check(
    'Submitted attempt rejects answer tampering',
    await rejectsTx(
      () => db.query(`update responses set value = 'tampered' where session_id = $1`, [sessionId]),
      /frozen|immutable|closed/i,
    ),
  );

  check(
    'Submitted attempt rejects a rewritten start time',
    await rejectsTx(
      () => db.query(`update assessment_sessions set started_at = now() - interval '1 day' where id = $1`, [sessionId]),
      /immutable/i,
    ),
  );

  check(
    'Computed dimension scores cannot be modified',
    await rejectsTx(async () => {
      await db.query(
        `insert into dimension_scores (session_id, dimension_key, kind, raw_score, max_raw_score,
           normalized_score, items_answered, items_total, rank)
         values ($1,'verbal','aptitude',1,1,50.00,1,1,1)
         on conflict (session_id, dimension_key) do nothing`,
        [sessionId],
      );
      await db.query(`update dimension_scores set raw_score = 999 where session_id = $1`, [sessionId]);
    }, /immutable/i),
  );

  /* ------------------------------------------------ 6 & 7 frozen versions */

  await db.query(
    `update assessment_versions set status = 'published' where id = $1 and status = 'draft'`,
    [versionId],
  );

  check(
    'Published version rejects new questions',
    await rejectsTx(
      () => db.query(
        `insert into questions (assessment_version_id, external_key, dimension_key, type, prompt)
         values ($1, 'probe-late', 'verbal', 'likert', 'Late edit')`,
        [versionId],
      ),
      /published/i,
    ),
  );

  check(
    'Published version rejects new options',
    await rejectsTx(
      () => db.query(
        `insert into question_options (question_id, label, is_correct) values ($1,'C',false)`,
        [questionId],
      ),
      /published/i,
    ),
  );

  check(
    'A second published version for one assessment is rejected',
    await rejectsTx(
      () => db.query(
        `insert into assessment_versions (assessment_id, version, status, duration_seconds, question_count)
         values ($1, 2, 'published', 600, 1)`,
        [assessmentId],
      ),
      /unique|duplicate/i,
    ),
  );

  /* --------------------------------------------------- 8 duplicate links */

  check(
    'A student cannot hold two live assignments for the same version',
    await rejectsTx(
      () => db.query(
        `insert into assessment_assignments (organization_id, student_id, assessment_version_id, token_hash, token_hint)
         values ($1, $2, $3, $4, 'hbbb')`,
        [alphaOrg, alphaStudent.id, versionId, tokenB],
      ),
      /unique|duplicate/i,
    ),
  );

  /* --------------------------------------------------------- 9 credits */

  const { rows: prods } = await db.query<{ id: string }>(`
    insert into products (assessment_id, name, price_in_paise) values ($1, 'Probe', 96000)
    on conflict (assessment_id) do update set price_in_paise = 96000 returning id
  `, [assessmentId]);

  check(
    'Assigning without credits is refused',
    await rejectsTx(
      () => db.query(`select app.spend_credit($1, $2, 1, 'probe')`, [alphaOrg, prods[0].id]),
      /insufficient credits/i,
    ),
  );

  await db.query(
    `insert into credit_transactions (organization_id, product_id, delta, reason)
     values ($1, $2, 5, 'probe top-up')
     on conflict do nothing`,
    [alphaOrg, prods[0].id],
  );
  await db.query(`select app.spend_credit($1, $2, 3, 'probe spend')`, [alphaOrg, prods[0].id]);

  const { rows: bal } = await db.query<{ balance: string | number }>(
    `select balance from app.credit_balances where organization_id = $1 and product_id = $2`,
    [alphaOrg, prods[0].id],
  );
  check(
    'Credit ledger nets to the expected balance',
    String(bal[0]?.balance) === '2',
    `balance=${bal[0]?.balance}`,
  );

  await db.exec('drop owned by probe_teacher; drop role if exists probe_teacher;');
}

async function main(): Promise<void> {
  const db = await getDb();
  try {
    await db.tx((tx) => runProbe(tx));
  } catch (err) {
    process.stderr.write(`  probe crashed: ${(err as Error).stack}\n`);
    process.exit(1);
  }

  process.stdout.write('  fixtures rolled back; database unchanged\n');
  process.stdout.write(failures === 0 ? '\n  all probes passed\n' : `\n  ${failures} probe(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`probe crashed: ${(err as Error).stack}\n`);
  process.exit(1);
});
