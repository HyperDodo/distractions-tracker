-- Each entity keeps its latest sequence, including after deletion.
CREATE TABLE sync_entities (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('entry', 'day_note', 'settings', 'report')),
  id TEXT NOT NULL,
  UNIQUE (kind, id)
);

-- A null watermark records a rejected operation, so retries cannot run it later.
CREATE TABLE sync_operations (
  id TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  through INTEGER
);

INSERT INTO sync_entities (kind, id) VALUES ('settings', '1');
INSERT INTO sync_entities (kind, id) SELECT 'entry', id FROM entries;
INSERT INTO sync_entities (kind, id) SELECT 'day_note', date FROM day_notes;
INSERT INTO sync_entities (kind, id) SELECT 'report', id FROM reports WHERE kind <> 'connection_test';

CREATE TRIGGER sync_entry_insert AFTER INSERT ON entries BEGIN
  INSERT INTO sync_entities (kind, id) VALUES ('entry', NEW.id)
  ON CONFLICT (kind, id) DO UPDATE SET seq=excluded.seq;
END;

CREATE TRIGGER sync_entry_update AFTER UPDATE ON entries BEGIN
  INSERT INTO sync_entities (kind, id) VALUES ('entry', NEW.id)
  ON CONFLICT (kind, id) DO UPDATE SET seq=excluded.seq;
END;

CREATE TRIGGER sync_entry_delete AFTER DELETE ON entries BEGIN
  INSERT INTO sync_entities (kind, id) VALUES ('entry', OLD.id)
  ON CONFLICT (kind, id) DO UPDATE SET seq=excluded.seq;
END;

CREATE TRIGGER sync_day_note_insert AFTER INSERT ON day_notes BEGIN
  INSERT INTO sync_entities (kind, id) VALUES ('day_note', NEW.date)
  ON CONFLICT (kind, id) DO UPDATE SET seq=excluded.seq;
END;

CREATE TRIGGER sync_day_note_update AFTER UPDATE ON day_notes BEGIN
  INSERT INTO sync_entities (kind, id) VALUES ('day_note', NEW.date)
  ON CONFLICT (kind, id) DO UPDATE SET seq=excluded.seq;
END;

CREATE TRIGGER sync_day_note_delete AFTER DELETE ON day_notes BEGIN
  INSERT INTO sync_entities (kind, id) VALUES ('day_note', OLD.date)
  ON CONFLICT (kind, id) DO UPDATE SET seq=excluded.seq;
END;

CREATE TRIGGER sync_settings_update AFTER UPDATE OF revision ON settings BEGIN
  INSERT INTO sync_entities (kind, id) VALUES ('settings', '1')
  ON CONFLICT (kind, id) DO UPDATE SET seq=excluded.seq;
END;

CREATE TRIGGER sync_report_insert AFTER INSERT ON reports WHEN NEW.kind <> 'connection_test' BEGIN
  INSERT INTO sync_entities (kind, id) VALUES ('report', NEW.id)
  ON CONFLICT (kind, id) DO UPDATE SET seq=excluded.seq;
END;

CREATE TRIGGER sync_report_update AFTER UPDATE ON reports WHEN NEW.kind <> 'connection_test' BEGIN
  INSERT INTO sync_entities (kind, id) VALUES ('report', NEW.id)
  ON CONFLICT (kind, id) DO UPDATE SET seq=excluded.seq;
END;

CREATE TRIGGER sync_report_delete AFTER DELETE ON reports WHEN OLD.kind <> 'connection_test' BEGIN
  INSERT INTO sync_entities (kind, id) VALUES ('report', OLD.id)
  ON CONFLICT (kind, id) DO UPDATE SET seq=excluded.seq;
END;
