-- A schema migration must never silently reinterpret populated legacy dates.
-- Fresh databases and already-UTC databases can adopt the canonical model.
CREATE TABLE app_time_model (
  id integer PRIMARY KEY CHECK (id = 1),
  version varchar(16) NOT NULL CHECK (version IN ('utc-v1', 'legacy-v0')),
  source_timezone text NOT NULL,
  converted_at timestamptz(3)
);
INSERT INTO app_time_model (id, version, source_timezone, converted_at)
SELECT 1,
  CASE WHEN current_setting('TimeZone') IN ('UTC', 'Etc/UTC') OR NOT EXISTS (SELECT 1 FROM users) THEN 'utc-v1' ELSE 'legacy-v0' END,
  current_setting('TimeZone'),
  CASE WHEN current_setting('TimeZone') IN ('UTC', 'Etc/UTC') OR NOT EXISTS (SELECT 1 FROM users) THEN now() ELSE NULL END;
