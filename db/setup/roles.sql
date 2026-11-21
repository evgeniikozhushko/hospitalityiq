-- Environment setup (not a migration): grants for the read-only application role.
-- Run by `npm run db:setup`, which creates the role (with its password from
-- DATABASE_URL_READONLY) and substitutes the identifiers below. Run it again after
-- any migration that adds a table the question path must read.
-- Safe to run repeatedly.
--
-- The role reads named tables and views only, never the whole schema, and gets
-- nothing on tables created later. A campaign figures table must stay unreadable
-- to the question path the day it is created (docs/trends-campaigns-plan.md, decision 1).

-- Remove any broader grant left by an earlier version of this file.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :ro_role;
ALTER DEFAULT PRIVILEGES FOR ROLE :owner_role IN SCHEMA public REVOKE ALL ON TABLES FROM :ro_role;

GRANT USAGE ON SCHEMA public TO :ro_role;
GRANT SELECT ON :ro_objects TO :ro_role;
