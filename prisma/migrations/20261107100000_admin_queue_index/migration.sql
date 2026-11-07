-- Global operations views filter the durable mail queue by creation time.
-- Build without blocking delivery writes on an existing large outbox.
CREATE INDEX CONCURRENTLY email_deliveries_created_at_idx ON public.email_deliveries(created_at);
