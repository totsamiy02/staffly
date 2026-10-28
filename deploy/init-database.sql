\set ON_ERROR_STOP on
\getenv app_password APP_DATABASE_PASSWORD
\getenv migration_password MIGRATION_DATABASE_PASSWORD
\getenv database POSTGRES_DB

-- Run once by the PostgreSQL entrypoint on a NEW volume. Never run against an
-- existing database without reviewing ownership/grants and taking a backup.
CREATE ROLE staffly_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'migration_password';
CREATE ROLE staffly_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO staffly_migrator;
GRANT CONNECT ON DATABASE :"database" TO staffly_migrator, staffly_app;
-- Existing migrations create the public schema and trusted btree_gist extension.
GRANT CREATE ON DATABASE :"database" TO staffly_migrator;
GRANT USAGE ON SCHEMA public TO staffly_app;
