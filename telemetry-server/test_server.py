import sqlite3
import tempfile
import unittest
import uuid
from datetime import date
from pathlib import Path

from server import ValidationError, initialize_db, store_batch, validate_payload


class TelemetryServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "usage.sqlite3"
        initialize_db(self.db)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def payload(self) -> dict:
        return {
            "schema_version": 1,
            "batch_id": str(uuid.uuid4()),
            "plugin_version": "1.7.0",
            "day": "2026-10-30",
            "skills": [
                {"name": "ppt", "count": 3},
                {"name": "video", "count": 2},
            ],
        }

    def test_validation_accepts_only_the_minimal_shape(self) -> None:
        payload = self.payload()
        parsed = validate_payload(payload, today=date(2026, 10, 30))
        self.assertEqual(parsed["skills"], {"ppt": 3, "video": 2})
        extra = payload | {"query": "private task"}
        with self.assertRaises(ValidationError):
            validate_payload(extra, today=date(2026, 10, 30))

    def test_batch_retry_is_idempotent(self) -> None:
        payload = validate_payload(self.payload(), today=date(2026, 10, 30))
        store_batch(self.db, payload)
        store_batch(self.db, payload)
        with sqlite3.connect(self.db) as connection:
            rows = connection.execute(
                "SELECT skill, count FROM skill_usage ORDER BY skill"
            ).fetchall()
            batches = connection.execute("SELECT COUNT(*) FROM batches").fetchone()[0]
        self.assertEqual(rows, [("ppt", 3), ("video", 2)])
        self.assertEqual(batches, 1)

    def test_invalid_counts_and_out_of_window_dates_are_rejected(self) -> None:
        payload = self.payload()
        payload["skills"] = [{"name": "ppt", "count": 0}]
        with self.assertRaises(ValidationError):
            validate_payload(payload, today=date(2026, 10, 30))
        payload = self.payload()
        payload["day"] = "2026-01-01"
        with self.assertRaises(ValidationError):
            validate_payload(payload, today=date(2026, 10, 30))

    def test_database_contains_no_client_identifiers(self) -> None:
        payload = validate_payload(self.payload(), today=date(2026, 10, 30))
        store_batch(self.db, payload)
        with sqlite3.connect(self.db) as connection:
            columns = [row[1] for row in connection.execute("PRAGMA table_info(skill_usage)")]
        self.assertEqual(columns, ["day", "skill", "count"])


if __name__ == "__main__":
    unittest.main()
