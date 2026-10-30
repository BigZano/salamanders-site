-- Least-privilege role for the API. The API connects as `salamanders_app` (see
-- DATABASE_URL in docker-compose.yml): it can read and write the tables and use
-- their sequences, and nothing else. It is not a superuser and cannot create
-- roles or tables, so a compromised API cannot take over the database.
--
-- `salamanders` (POSTGRES_USER) stays the owner and is used only for admin work
-- such as applying schema.sql. Idempotent: safe to re-run, and re-running sets
-- the password again.
--
-- Run it as the owner, after schema.sql, with the password on stdin (not on a
-- command line). Roles live in the cluster, not in the database, so on a fresh
-- volume run this BEFORE restoring a dump (the dump's GRANTs name the role, and
-- pg_restore stops at the first one if it does not exist):
--
--   { printf '\\set app_password '"'"'%s'"'"'\n' "$APP_DB_PASSWORD"; cat app-role.sql; } \
--     | docker compose exec -T db psql -U salamanders -d salamanders_builds -v ON_ERROR_STOP=1
--
-- New tables made by `salamanders` (schema.sql changes) are covered by the
-- default privileges at the bottom.

select format('create role salamanders_app login password %L', :'app_password')
where not exists (select 1 from pg_roles where rolname = 'salamanders_app') \gexec

select format('alter role salamanders_app login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls', :'app_password') \gexec

grant connect on database salamanders_builds to salamanders_app;
grant usage on schema public to salamanders_app;
grant select, insert, update, delete on all tables in schema public to salamanders_app;
grant usage, select on all sequences in schema public to salamanders_app;

alter default privileges for role salamanders in schema public
  grant select, insert, update, delete on tables to salamanders_app;
alter default privileges for role salamanders in schema public
  grant usage, select on sequences to salamanders_app;
