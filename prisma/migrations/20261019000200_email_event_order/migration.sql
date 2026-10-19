-- Transaction-local notifications can share created_at; sequence gives coalescing a stable order.
ALTER TABLE email_deliveries ADD COLUMN event_order BIGSERIAL NOT NULL;
