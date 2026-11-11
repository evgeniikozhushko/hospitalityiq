-- Environment setup (not a migration): grants for the read-only application role.
-- Run by `npm run db:setup`, which creates the role (with its password from
-- DATABASE_URL_READONLY) and substitutes the two identifiers below.
-- Safe to run repeatedly.
GRANT USAGE ON SCHEMA public TO :ro_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :ro_role;
ALTER DEFAULT PRIVILEGES FOR ROLE :owner_role IN SCHEMA public GRANT SELECT ON TABLES TO :ro_role;
