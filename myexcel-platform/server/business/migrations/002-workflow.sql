ALTER TABLE mx_records ADD COLUMN workflow_state VARCHAR(64) NULL AFTER revision;
-- statement-break
CREATE TABLE IF NOT EXISTS mx_workflow_events (
  record_id CHAR(36) NOT NULL,
  request_key VARCHAR(100) NOT NULL,
  actor_id VARCHAR(64) NOT NULL,
  transition_id VARCHAR(64) NOT NULL,
  from_state VARCHAR(64) NOT NULL,
  to_state VARCHAR(64) NOT NULL,
  created_at VARCHAR(30) NOT NULL,
  PRIMARY KEY (record_id, request_key),
  CONSTRAINT mx_workflow_record FOREIGN KEY (record_id) REFERENCES mx_records(id),
  INDEX mx_workflow_history (record_id, created_at)
) ENGINE=InnoDB;
