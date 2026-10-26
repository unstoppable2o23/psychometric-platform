-- Report bytes are stored in the database.
--
-- The filesystem copy is convenient locally (the demo and inspection scripts
-- read it directly) but cannot be relied on in production: serverless hosts
-- such as Vercel give each invocation a read-only bundle and an ephemeral /tmp.
-- Keeping the bytes alongside the row also means the authorisation check and the
-- content come from one place.

alter table assessment_reports add column content bytea;
