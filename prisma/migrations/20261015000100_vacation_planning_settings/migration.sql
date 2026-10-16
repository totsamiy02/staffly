ALTER TABLE organizations ADD COLUMN vacation_standard_days INTEGER NOT NULL DEFAULT 28, ADD COLUMN vacation_holidays TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE organizations ADD CONSTRAINT vacation_standard_days_check CHECK(vacation_standard_days BETWEEN 28 AND 366);
