-- Applied by the schema owner AFTER every migration, before APIs/workers start.
GRANT USAGE ON SCHEMA public TO staffly_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO staffly_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO staffly_app;
ALTER DEFAULT PRIVILEGES FOR ROLE staffly_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO staffly_app;
ALTER DEFAULT PRIVILEGES FOR ROLE staffly_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO staffly_app;
REVOKE ALL ON TABLE public._prisma_migrations FROM staffly_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.app_time_model FROM staffly_app;
-- Quota policy and accounting are maintained by the schema owner/triggers.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.organization_resource_budgets FROM staffly_app;
GRANT UPDATE(export_window_start, export_window_count, last_export_at, last_email_at, email_window_start, email_window_count, offer_check_cursor, request_check_cursor) ON public.organization_resource_budgets TO staffly_app;
