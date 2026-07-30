-- Metadata only. The file bytes live in R2; this table is the index over them.
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,   -- uuid, also the R2 object key
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,      -- mime type
  size        INTEGER NOT NULL,   -- bytes
  uploaded_at TEXT NOT NULL       -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_files_uploaded_at ON files (uploaded_at DESC);
