SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM log_lines l LEFT JOIN line_index i ON i.line_id=l.id
  WHERE l.deleted_at IS NULL AND (i.line_id IS NULL OR i.parser_version<2
    OR i.source_line_version<>l.version OR i.marker IN ('⭐','☐','📷') OR i.kind='photo')
) THEN 1 ELSE json('Legacy cleanup requires current active parser indices') END;

DELETE FROM audit_changes WHERE action IN ('legacy_import','parser_v2_normalize_marker');
DELETE FROM write_guards WHERE operation_id IN (
  SELECT id FROM operations WHERE action IN ('legacy_import','parser_v2_normalize_marker')
);
DELETE FROM operations WHERE action IN ('legacy_import','parser_v2_normalize_marker');
DELETE FROM read_snapshots WHERE tool IN ('cases_search','lines_search')
  OR expires_at<strftime('%Y-%m-%dT%H:%M:%fZ','now');
DROP TABLE import_sources;
DROP TABLE data_migrations;
ALTER TABLE cases DROP COLUMN legacy_metadata;
