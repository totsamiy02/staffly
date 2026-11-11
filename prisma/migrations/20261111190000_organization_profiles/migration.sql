-- Existing profile/contact data and unknown opening hours remain unchanged.
ALTER TABLE organizations
 ADD COLUMN industry varchar(120),
 ADD COLUMN profile_revision integer NOT NULL DEFAULT 1 CHECK (profile_revision > 0),
 ADD COLUMN creation_key uuid,
 ADD COLUMN creation_fingerprint varchar(64);
CREATE UNIQUE INDEX organizations_created_by_user_id_creation_key_key ON organizations(created_by_user_id, creation_key);
ALTER TABLE organization_locations
 ADD COLUMN kind varchar(16) NOT NULL DEFAULT 'PHYSICAL' CHECK (kind IN ('PHYSICAL','REMOTE')),
 ADD COLUMN phone varchar(12),
 ADD COLUMN description varchar(1000),
 ADD COLUMN opening_hours jsonb CHECK (opening_hours IS NULL OR (jsonb_typeof(opening_hours)='array' AND jsonb_array_length(opening_hours)=7)),
 ADD COLUMN inherits_timezone boolean NOT NULL DEFAULT false,
 ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
