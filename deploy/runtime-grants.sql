-- Applied by the schema owner AFTER every migration, before APIs/workers start.
GRANT USAGE ON SCHEMA public TO staffly_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO staffly_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO staffly_app;
ALTER DEFAULT PRIVILEGES FOR ROLE staffly_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO staffly_app;
ALTER DEFAULT PRIVILEGES FOR ROLE staffly_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO staffly_app;
REVOKE ALL ON TABLE public._prisma_migrations FROM staffly_app;
