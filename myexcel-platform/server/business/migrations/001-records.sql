CREATE TABLE IF NOT EXISTS mx_entities (
  space_id VARCHAR(64) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  schema_hash CHAR(64) NOT NULL,
  PRIMARY KEY (space_id, entity_id)
) ENGINE=InnoDB;
-- statement-break
CREATE TABLE IF NOT EXISTS mx_releases (
  template_id VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  content JSON NOT NULL,
  PRIMARY KEY (template_id, version)
) ENGINE=InnoDB;
-- statement-break
CREATE TABLE IF NOT EXISTS mx_records (
  id CHAR(36) NOT NULL PRIMARY KEY,
  space_id VARCHAR(64) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  template_id VARCHAR(64) NOT NULL,
  template_version INT NOT NULL,
  parent_id CHAR(36) NULL,
  detail_key VARCHAR(64) NULL,
  ordinal INT NOT NULL DEFAULT 0,
  revision INT NOT NULL DEFAULT 1,
  owner_id VARCHAR(64) NOT NULL,
  values_json JSON NOT NULL,
  created_at VARCHAR(30) NOT NULL,
  updated_at VARCHAR(30) NOT NULL,
  CONSTRAINT mx_record_release FOREIGN KEY (template_id, template_version) REFERENCES mx_releases(template_id, version),
  CONSTRAINT mx_record_parent FOREIGN KEY (parent_id) REFERENCES mx_records(id),
  CONSTRAINT mx_record_entity FOREIGN KEY (space_id, entity_id) REFERENCES mx_entities(space_id, entity_id),
  INDEX mx_record_lookup (space_id, entity_id, owner_id, id),
  INDEX mx_record_parent_order (parent_id, detail_key, ordinal),
  INDEX mx_record_template (template_id, parent_id, id)
) ENGINE=InnoDB;
-- statement-break
CREATE TABLE IF NOT EXISTS mx_references (
  source_id CHAR(36) NOT NULL,
  field_id VARCHAR(64) NOT NULL,
  target_id CHAR(36) NOT NULL,
  PRIMARY KEY (source_id, field_id),
  CONSTRAINT mx_reference_source FOREIGN KEY (source_id) REFERENCES mx_records(id),
  CONSTRAINT mx_reference_target FOREIGN KEY (target_id) REFERENCES mx_records(id)
) ENGINE=InnoDB;
-- statement-break
CREATE TABLE IF NOT EXISTS mx_requests (
  actor_id VARCHAR(64) NOT NULL,
  request_key VARCHAR(100) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_json JSON NULL,
  created_at VARCHAR(30) NOT NULL,
  PRIMARY KEY (actor_id, request_key)
) ENGINE=InnoDB;
-- statement-break
CREATE TABLE IF NOT EXISTS mx_audit (
  id CHAR(36) NOT NULL PRIMARY KEY,
  record_id CHAR(36) NOT NULL,
  actor_id VARCHAR(64) NOT NULL,
  action VARCHAR(32) NOT NULL,
  revision INT NOT NULL,
  template_version INT NOT NULL,
  created_at VARCHAR(30) NOT NULL,
  before_json JSON NULL,
  after_json JSON NOT NULL,
  CONSTRAINT mx_audit_record FOREIGN KEY (record_id) REFERENCES mx_records(id),
  INDEX mx_audit_record_version (record_id, revision)
) ENGINE=InnoDB;
