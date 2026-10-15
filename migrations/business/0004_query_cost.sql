ALTER TABLE line_index ADD COLUMN case_id TEXT REFERENCES cases(id);
UPDATE line_index SET case_id=(SELECT case_id FROM log_lines WHERE id=line_id)
WHERE case_id IS NOT (SELECT case_id FROM log_lines WHERE id=line_id);
DELETE FROM line_index WHERE line_id IN (SELECT id FROM log_lines WHERE deleted_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS index_case_recent ON line_index(case_id,recent_date);
CREATE INDEX IF NOT EXISTS index_record_date ON line_index(record_date);
CREATE TRIGGER IF NOT EXISTS index_case_on_insert AFTER INSERT ON line_index
WHEN NEW.case_id IS NULL
BEGIN
  UPDATE line_index SET case_id=(SELECT case_id FROM log_lines WHERE id=NEW.line_id) WHERE line_id=NEW.line_id;
END;
CREATE TRIGGER IF NOT EXISTS index_remove_on_delete AFTER UPDATE OF deleted_at ON log_lines
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM line_index WHERE line_id=NEW.id;
END;
