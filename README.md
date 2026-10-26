# Psychometric Assessment Platform

A working vertical slice of a psychometric guidance platform for students in
Grades 8–12: one complete assessment (**Stream Selector Test**, 150 questions)
running end to end from a purchased credit, through a server-enforced timed
attempt, to a personalised multi-page PDF report.

Everything in this repository runs. Nothing is mocked, and no screen is a
placeholder.

---

## What actually works today

| Capability | Status |
| --- | --- |
| Postgres schema, migrations, RLS, immutable-result triggers | Done, verified against real Postgres |
| Tenant isolation (one school cannot read another's students) | Verified by probe suite |
| 156-question Stream Selector bank, dimension-mapped | Done, distinct, integrity-checked |
| Scoring: correct-answer, 5-point interest, reverse scoring, F1 multi-select | Done, unit tested |
| Weighted stream matching across four streams | Done, unit tested |
| Unique single-use assessment links (SHA-256 hashed) | Done, integration tested |
| Server-authoritative timer, autosave, resume, duplicate-submit guard | Done, integration tested |
| Enforced 90% completion floor on submit | Done, tested |
| Rate limiting on auth and assessment endpoints | Done, per-endpoint keys |
| Dynamic PDF report, 5+ pages, charts, Devanagari support | Done, renders in ~3s |
| Authenticated PDF download with path-traversal guard | Done |
| Student-facing landing, runner, and results pages | Done |
| Individual teacher logins (scrypt, invite activation, lockout) | Done, tested |
| Super-admin teacher management (create, edit, enable/disable, unlock, reissue link) | Done, tested |
| Disabling an account kills its live sessions immediately | Done, verified over HTTP |
| Role checks for student / teacher / admin | Done |

**Not built yet** (see [Roadmap](#roadmap)): the other seven assessments, teacher
roster/assignment management, purchases, and Razorpay. The commerce schema exists
but no checkout flow is wired.

---

## Quick start

No database server and no credentials are required.

```bash
npm install
cp .env.example .env.local     # optional; sensible defaults apply
npm run db:migrate             # creates ./pglite and applies migrations
npm run db:seed                # prints a working assessment link
npm run dev
```

`db:seed` prints a working assessment link and the staff accounts, with
passwords:

```
super admin        admin@psychometric.local          /admin/signin
teacher            meera.iyer@greenfield.example     Greenfield#2026
                                                     /teacher/signin
activation links   two teachers awaiting activation
assessment link    http://localhost:3000/assessment/<token>
```

Open the assessment link to take the test, `/admin/signin` to manage teacher
access, or `/teacher/signin` for a teacher's account home. The seed is
idempotent: re-running it reissues the pending activation links rather than
duplicating accounts.

Prefer no browser? Render a complete PDF report headlessly:

```bash
npm run demo:report
```

---

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run db:migrate` | Apply migrations (`-- --reset` to rebuild) |
| `npm run db:seed` | Seed catalogue, demo school, students, credits, staff accounts |
| `npm run db:probe` | Verify schema security guarantees (see below) |
| `npm run demo:report` | Full attempt → scored → PDF, headless |
| `npm run inspect:pdf <file>` | Page/blank-page check on a rendered report |
| `npm test` | Unit + integration tests (124) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npx tsx --tsconfig tsconfig.scripts.json scripts/print-session.mts <email>` | Print a signed session cookie, for HTTP smoke tests |

---

## Architecture

```
src/
  lib/
    domain/types.ts          Shared vocabulary. No server imports.
    scoring/engine.ts        Pure scoring. No DB, no clock, no I/O.
    scoring/interpret.ts     Narrative generated from real scores
  server/
    env.ts                   Validated environment, read only on the server
    db/client.ts             PGlite (dev) | node-postgres (prod), one interface
    db/migrate.ts            Migration runner
    db/seed.ts               Idempotent development seed
    db/probe.ts              Security assertions against a live database
    auth/tokens.ts           HMAC signing, token hashing (no Next imports)
    auth/session.ts          Cookie plumbing (the only Next-auth module)
    dal/actor.ts             Actor resolution and authorization helpers
    dal/attempts.ts          Link resolution, attempts, autosave, submit, scoring
    reports/                 PDF document, render pipeline, font registration
    content/                 Question bank and stream content
  app/
    actions/attempts.ts      Server Actions (mutation entry points)
    assessment/[token]/      Landing page + runner
    results/[sessionId]/     Results
    api/reports/[reportId]/  Authorised PDF download
db/migrations/               Numbered SQL migrations
db/dev/auth-shim.sql         LOCAL ONLY stand-in for Supabase's auth.users
tests/                       Unit and integration tests
```

### Why a data access layer

Every read of student data goes through `src/server/dal`, and every DAL function
requires an `Actor`. There is no query path that reaches a student's results
without one. Authorisation is therefore a property of the function signature
rather than something each call site must remember.

Server Actions are a separate entry point from the page that rendered them, so
each one re-resolves and re-authorises the actor rather than trusting the page.

### Why PGlite

Docker was unavailable in this environment, so local development uses PGlite —
Postgres 17 compiled to WebAssembly. The important property is that **the same
migration files run unmodified** in both PGlite and Supabase. If a migration only
works locally, it is not verified.

`db/dev/auth-shim.sql` supplies a stand-in `auth.users` so `profiles` can carry a
real foreign key locally. On Supabase that file must never be applied.

---

## Measurement integrity

This is the part most worth reading, because it is where guidance tools usually
go wrong.

**No percentiles are produced.** There is no norm group behind this instrument.
A score of 72 does not mean "better than 72% of students", and the report never
implies it. What is produced instead:

- a raw score out of the item pool,
- a 0–100 normalisation within the student's own paper,
- a rank among the student's own eleven dimensions,
- per-dimension coverage (answered / total).

**Aptitude and interest are never merged.** They answer different questions.
Averaging them into one "ability score" hides exactly the tension a student most
needs to see, so the report calls that tension out in its own paragraph.

**Unanswered aptitude items score zero.** Treating them as "not counted" would
let a student raise their score by answering only the easy items. Coverage is
reported alongside every score instead of being hidden.

**Stream fit is a transparent weighted mean.** Each stream declares how much it
draws on each dimension in `src/server/content/stream-selector.ts`; the report
names the weights that produced the score. Retuning the model is a data change.

**Reverse-scored items are checked for wording.** An item marked
`reverseScored` must be phrased against its own dimension. This is enforced in
`assertBankIntegrity()` rather than trusted to review, because the failure mode is
silent and severe: a positively-worded item marked as reversed means a student
who agrees with it scores lower.

**Submission has a floor.** A student-initiated submit below 90% is refused by
the server with the exact numbers still required. A timeout is exempt — the clock
closes the paper either way, and refusing there would discard real answers.

**Bands are narrative, not clinical.** The 1/2/3 banding on fit scores groups a
student's own four scores for readability. It is not a validated cut-off.

**No MBTI, RIASEC-validated, or Gardner-normed claims.** The interest dimensions
are labelled as stated preferences. RIASEC-style labelling is descriptive here,
and the report says so.

---

## Security

Enforced in the database rather than trusted to application code.

**Row-level security.** Every policy resolves the acting user through
transaction-scoped settings (`app.set_request_context`). A teacher in one school
sees only that school's students; a student sees only their own records; an admin
sees everything.

**Immutable results.** Once an attempt is submitted:

- answers cannot be inserted, updated, or deleted,
- the start time and expiry cannot be rewritten (timer integrity),
- computed dimension scores and stream matches cannot be modified,
- `audit_logs` is append-only, even for a direct SQL session.

**Published versions are frozen.** Editing a question requires publishing
version *n+1*. That is what makes an old report reproducible from the exact
inputs the student saw.

**Assignment links are bearer credentials.** Only the SHA-256 hash is stored, so
a database leak does not hand out working URLs. Links are single-use, expiring,
revocable, and limited by `max_attempts`.

**One live assignment per student per version**, enforced by a partial unique
index — so a retake requires an explicit revocation.

**Answer validation.** A submitted option id must belong to that question, and a
likert value must be an id the question actually offers. A crafted payload cannot
store an out-of-range score.

**Credit ledger.** Balance is a running sum, not a mutable counter, so two
concurrent assignments cannot both spend the same credit.

**Concurrent starts serialise.** `startAttempt` takes a row lock on the
assignment before deciding whether to open an attempt. Without it, two
simultaneous requests both read "no open attempt", both compute attempt number 1,
and one dies on the unique constraint as a 500 rather than resuming.

**Rate limiting** is applied per endpoint and keyed deliberately: sign-in per
email (so an attacker cannot lock a school out via a shared IP), link resolution
per client (so one student cannot exhaust a global bucket for everyone), autosave
per attempt. Counters are in-process, so on N instances the effective limit is N
times the configured value — see the note in `src/server/security/rate-limit.ts`.

### Verifying these claims

```bash
npm run db:probe
```

Eleven assertions run as an unprivileged role, so RLS is genuinely enforced rather
than bypassed by the superuser connection the app normally uses. The whole run
happens inside a transaction that is rolled back, so it leaves no fixtures and is
safe to repeat:

```
[PASS] RLS hides other organisations students from a teacher
[PASS] Admin context sees students across organisations
[PASS] Submitted attempt rejects answer tampering
[PASS] Submitted attempt rejects a rewritten start time
[PASS] Computed dimension scores cannot be modified
[PASS] Published version rejects new questions
[PASS] Published version rejects new options
[PASS] A second published version for one assessment is rejected
[PASS] A student cannot hold two live assignments for the same version
[PASS] Assigning without credits is refused
[PASS] Credit ledger nets to the expected balance
```

---

## The question bank

156 distinct items in `src/server/content/stream-selector-questions.ts`:

| Dimension | Kind | Items | Reversed |
| --- | --- | ---: | ---: |
| Verbal aptitude | aptitude | 16 | – |
| Numerical aptitude | aptitude | 16 | – |
| Clerical accuracy | aptitude | 13 | – |
| Spatial aptitude | aptitude | 13 | – |
| Logical & abstract reasoning | aptitude | 17 | – |
| Hands-on & practical (R) | interest | 12 | 1 |
| Analytical & investigative (I) | interest | 12 | 1 |
| Creative & expressive (A) | interest | 13 | 1 |
| Helping & supporting (S) | interest | 13 | 1 |
| Leading & persuading (E) | interest | 15 | 1 |
| Organised & detail-focused (C) | interest | 16 | 1 |

156 rather than the required 150 because each interest dimension needs one
genuinely *negatively-worded* item for reverse scoring. Without them, the only
available items would have been positive statements marked as reversed — which
scores a student *lower* for agreeing with something plainly true. That is worse
than having no reverse items at all.

`assertBankIntegrity()` fails the build if the count drifts, if two items share a
prompt, if an answer key is out of range, if options are duplicated, if a
`REVERSE_KEYS` entry points at nothing or at a choice item, or if a reverse-scored
item is not actually worded against its dimension. It runs in the seed and the
test suite.

**These are drafted, not psychometrically validated.** They should be reviewed by
a qualified assessor before real use with students. Spatial items are text-based
because no illustrations are wired up yet; the schema supports image options.

The bank uses `single_choice` and `likert` only. `multi_select` is implemented and
tested in the scoring engine but currently unused by this assessment.

---

## Reports

`src/server/reports/stream-selector-report.tsx` builds a five-page A4 document:
summary, score profile, stream comparison and interpretation, recommendations,
and an action plan. Content comes entirely from the student's stored responses.

- Rendered server-side in ~3s (font embedding dominates).
- Bar charts and a four-axis radar drawn as native SVG, so nothing rasterises.
- Reports are written outside `public/` and served only through an authenticated
  route that re-checks authorisation and rejects any path escaping the storage root.
- Devanagari renders because `public/fonts/NotoSansDevanagari-*.ttf` is embedded.
  Without those files the report falls back to Helvetica and Devanagari names
  become unreadable; `unicodeFontAvailable()` surfaces this rather than failing
  silently.

Reports currently render inline with the submit request. The status column already
moves `pending → generating → ready|failed`, so moving this to a queue is a change
of caller, not a rewrite.

---

## Deployment notes

1. Create a Supabase project and apply the migrations:
   ```bash
   supabase link --project-ref <ref>
   supabase db push          # uses db/migrations, in order
   ```
2. Set `DATABASE_URL` to the pooled connection string and `DATABASE_PGSSL=true`.
3. Set `AUTH_SECRET` to 32+ random bytes.
4. Point `REPORT_STORAGE_DIR` at durable storage. Serverless filesystems are
   ephemeral — a local disk will lose reports between invocations. Use Supabase
   Storage or S3 and swap the read/write in `reports/render.tsx`.
5. Replace `devSignInAction` with Supabase Auth. It already refuses to run when
   `NODE_ENV=production`, but it is not an identity system.
6. `serverExternalPackages` must keep `@electric-sql/pglite`, `pg`, and the
   react-pdf packages external. Bundling PGlite breaks it: it resolves paths
   against a `URL` from its own realm, which fails Turbopack's server sandbox.

---

## Authentication status

Session cookies are HMAC-signed (`src/server/auth/tokens.ts`) and roles are
resolved from the `profiles` table on every request. Authorization is real:
results are gated in the data access layer, which distinguishes a student reading
their own result from staff reading one inside their organisation.

**Staff accounts have real passwords.** Each teacher is a separate account with
its own email, password and organisation. There is no shared teacher login.

- Passwords are hashed with scrypt (N=16384, r=8, p=1) and a per-account random
  salt. Costs are stored per row so they can be raised later without
  invalidating existing passwords. `src/server/auth/passwords.ts`
- An admin creates a teacher without ever choosing their password. The account
  starts with a single-use activation link (SHA-256 hashed at rest, 48-hour
  expiry); the teacher sets their own password on redemption.
  `src/server/auth/teacher-auth.ts`
- Sign-in failures are uniform: an unknown email and a wrong password produce
  the same message, so the form cannot enumerate accounts. Eight failures lock
  the account for 15 minutes; an admin can unlock it.
- The session cookie carries a credential version. Disabling an account, or the
  teacher changing their password, bumps that version, and every live session
  stops resolving on the next request — no waiting for the cookie to expire.
  `getActiveSessionUserId()` in `src/server/auth/session.ts`
- Every privileged change is written to `audit_logs`
  (`teacher.created`, `teacher.disabled`, `teacher.enabled`, `teacher.activated`,
  `teacher.password_reset`, `staff.sign_in`, `teacher.password_changed`, …).

The super admin manages teachers at `/admin/teachers`: create, edit, enable or
disable, unlock, and issue an activation link — or a reset link for a teacher
who already has a password. Both are single-use and both revoke live sessions. Admin sign-in is at
`/admin/signin`; teachers sign in at `/teacher/signin`.

Two things to wire before a real deployment:

1. **Auth-user provisioning.** `profiles.id` is a foreign key to `auth.users.id`.
   Locally the app inserts that row directly. On Supabase it must call
   `supabase.auth.admin.createUser(...)` instead — see the note in
   `src/server/auth/provisioning.ts`.
2. **Email delivery.** The activation link is printed by the seed and returned
   by the admin screen; there is no mailer yet, so an admin copies it across.

Student accounts still use `devSignInAction` for local development, which
requires an explicit `ALLOW_DEV_LOGIN=true` *and* is refused in production no
matter what. Gating on `NODE_ENV` alone was not enough: a Server Action is a
public POST endpoint, so a preview deployment or a misconfigured `NODE_ENV`
would otherwise have left a passwordless bypass exposed.

---

## Child data

The platform is aimed at minors in India, so the following are deliberate:

- no student data is sold, shared, or used for advertising;
- reports are not publicly listable and there are no leaderboards;
- only the minimum student data is collected, and guardian email is optional;
- assessment content carries the limitation disclaimer on every report.

**This is not legal advice.** The Digital Personal Data Protection Act, 2023 and
the rules in force at your deployment impose obligations (consent, guardian
handling, breach notification, data residency) that code alone cannot satisfy.
Obtain a review before taking real student data.

---

## Roadmap

In dependency order, matching the phases in the original brief:

1. **Teacher roster and assignment management** — the account, sign-in and
   account home exist; a teacher still cannot create students, spend credits or
   issue assessment links. That is the next piece.
2. **Purchases** — the commerce schema exists; wire the credit-allocation flow
   behind the existing `app.spend_credit()` function and a provider interface.
3. **Razorpay** — written against `PAYMENT_PROVIDER=razorpay`; needs real keys and
   a webhook endpoint. Idempotency is already enforced by the
   `(provider, provider_payment_id)` unique constraint.
4. **Seven more assessments** — reuse the engine. Each needs a question bank
   (90–150 items), dimensions, stream weights, and a report variant.
5. **Admin dashboard** — catalogue, pricing, question import. Teacher management
   already lives at `/admin/teachers`; this extends it into a full console.
6. **Background job for report rendering** once volume justifies it.

The highest-risk work is the remaining ~690 questions. That is a content task
needing subject-matter review, not a coding task, and it is worth budgeting
separately.

---

## Testing

```bash
npm test
```

124 tests, all against a real Postgres instance:

- `tests/scoring.test.ts` — pure scoring: item credit, reverse scoring, F1
  multi-select, normalisation, ranking, coverage, weighted matching, plus
  question-bank integrity.
- `tests/attempts.integration.test.ts` — link resolution, attempt idempotency,
  autosave, forged-value rejection, resume ordering, duplicate-submit collapse,
  attempt limits, score persistence, cross-tenant denial.
- `tests/teachers.test.ts` — password hashing and policy, invite creation and
  single-use redemption, per-teacher credential isolation, admin-only
  management, uniform sign-in failure, lockout and unlock, disable/re-enable,
  credential-version session revocation, and admin vs teacher role separation.
- `tests/regressions.test.ts` — one test per defect found in the audit, each
  naming the behaviour that was wrong so a regression fails here rather than in
  production.

Eleven defects were found during development and the audit, all of them invisible
from reading the code:

1. A `BEFORE` trigger that returned `old` on an `INSERT` silently discarded the
   row, making it impossible to save a single answer.
2. `dimension_scores.session_id` was `UNIQUE`, but there are eleven dimensions
   per attempt.
3. Revoking an assignment set `revoked_at` but not `status`, so the partial unique
   index still treated it as live and re-seeding always failed.
4. `actor_student_ids()` used a scalar subquery inside a `CASE`, which raises when
   an admin sees more than one student.
5. PGlite resolves paths against a `URL` from its own realm, so it silently
   breaks once Turbopack bundles it into the server sandbox.
6. The results page checked only `role === 'student'`, so any authenticated
   teacher could read any school's results by guessing a session id.
7. The stream rationale was looked up by `split(' ')[0]` on a rendered label,
   which never matches the lowercase dimension keys, so that paragraph was never
   rendered.
8. Three "reverse-scored" items were positively worded, so agreeing with them
   lowered the student's score.
9. The 90% completion floor was computed and stored but never enforced, despite
   being advertised in the instructions.
10. The save path bypassed `normaliseStoredValue`, so multi-select order leaked
    into storage.
11. The link rate limiter had no client in its key, so every student shared one
    bucket.

Two more were caught by tooling rather than tests: reading `Date.now()` during
render in the countdown timer (impure, risks a hydration mismatch), and PGlite
being bundled instead of kept external.
