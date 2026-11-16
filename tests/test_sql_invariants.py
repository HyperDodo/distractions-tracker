"""Checks for database invariants using the shipped migration and SQLite.

D1 uses SQLite; these checks do not replace tests against the deployed D1 API.
"""
import pathlib
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class SqlInvariants(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        for migration in sorted((ROOT / 'migrations').glob('*.sql')):
            self.db.executescript(migration.read_text())

    def tearDown(self):
        self.db.close()

    def insert_entry(self, entry_id, start=100, end=None):
        self.db.execute('''INSERT INTO entries
            (id, started_at, ended_at, capture_mode, time_estimated, created_at, updated_at)
            VALUES (?, ?, ?, 'timer', 0, 100, 100)''', (entry_id, start, end))

    def test_at_most_one_active_entry(self):
        self.insert_entry('one')
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_entry('two')
        self.db.execute('UPDATE entries SET ended_at = 200 WHERE id = ?', ('one',))
        self.insert_entry('two', 200)
        self.assertEqual(self.db.execute('SELECT count(*) FROM entries WHERE ended_at IS NULL').fetchone()[0], 1)

    def test_invalid_interval_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_entry('invalid', 200, 199)

    def test_optimistic_revision_update_rejects_stale_writer(self):
        self.insert_entry('one')
        update = 'UPDATE entries SET note = ?, revision = revision + 1 WHERE id = ? AND revision = ?'
        self.assertEqual(self.db.execute(update, ('first', 'one', 1)).rowcount, 1)
        self.assertEqual(self.db.execute(update, ('stale', 'one', 1)).rowcount, 0)
        self.assertEqual(self.db.execute('SELECT note, revision FROM entries WHERE id = ?', ('one',)).fetchone(), ('first', 2))

    def test_conditional_switch_sql_and_transaction_rollback(self):
        # Exercise the SQLite batch pattern from section 14.2, including a failed
        # insert. This tests the database semantics, not the HTTP implementation.
        self.insert_entry('old')
        self.db.commit()

        def switch(expected_revision, new_id):
            self.db.execute('UPDATE entries SET ended_at = 200, revision = revision + 1 WHERE id = ? AND revision = ? AND ended_at IS NULL', ('old', expected_revision))
            self.db.execute('''INSERT INTO entries (id, started_at, ended_at, capture_mode, time_estimated, created_at, updated_at)
                SELECT ?, 200, NULL, 'timer', 0, 200, 200 WHERE changes() = 1''', (new_id,))
            self.db.execute('UPDATE settings SET data_revision = data_revision + 1 WHERE id = 1 AND changes() = 1')

        with self.db:
            switch(2, 'stale')
        self.assertIsNone(self.db.execute('SELECT ended_at FROM entries WHERE id = ?', ('old',)).fetchone()[0])
        self.assertEqual(self.db.execute('SELECT data_revision FROM settings WHERE id = 1').fetchone()[0], 0)
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                switch(1, 'old')  # Duplicate primary key makes the INSERT fail.
        self.assertIsNone(self.db.execute('SELECT ended_at FROM entries WHERE id = ?', ('old',)).fetchone()[0])
        with self.db:
            switch(1, 'new')
        self.assertEqual(self.db.execute('SELECT ended_at FROM entries WHERE id = ?', ('old',)).fetchone()[0], 200)
        self.assertEqual(self.db.execute('SELECT started_at FROM entries WHERE id = ?', ('new',)).fetchone()[0], 200)
        self.assertEqual(self.db.execute('SELECT data_revision FROM settings WHERE id = 1').fetchone()[0], 1)

    def test_single_report_reservation_and_deleted_tombstone(self):
        create = '''INSERT INTO reports (id, kind, status, created_at, updated_at, provider, model, prompt_version)
                    VALUES (?, 'connection_test', 'pending', 100, 100, 'openrouter', 'test', 'v1')'''
        self.db.execute(create, ('report',))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(create, ('report',))
        self.db.execute("UPDATE reports SET status = 'deleted', deleted_at = 200 WHERE id = ?", ('report',))
        late = self.db.execute("UPDATE reports SET status = 'completed', result_json = '{}' WHERE id = ? AND status = 'pending'", ('report',))
        self.assertEqual(late.rowcount, 0)
        self.assertEqual(self.db.execute('SELECT status FROM reports WHERE id = ?', ('report',)).fetchone()[0], 'deleted')


if __name__ == '__main__':
    unittest.main()
