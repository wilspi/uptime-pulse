-- Shareable status pages, each showing a chosen subset of monitors at its own link.
CREATE TABLE status_pages (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE status_page_monitors (
  page_id TEXT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  display_name TEXT,
  position INTEGER NOT NULL,
  PRIMARY KEY (page_id, monitor_id)
);

CREATE INDEX status_page_monitors_monitor ON status_page_monitors(monitor_id);

-- Existing monitors stay on the homepage; new monitors are hidden unless chosen.
ALTER TABLE monitors ADD COLUMN show_on_homepage INTEGER NOT NULL DEFAULT 1 CHECK (show_on_homepage IN (0, 1));

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('homepage_show_all', '1');
