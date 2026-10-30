#!/usr/bin/env python3
"""Minimal anonymous daily skill-usage collector.

The public Nginx site forwards one exact POST path to this loopback-only
service. No IP address, headers, prompts, file paths, or task content are
stored. A batch ID makes retries idempotent.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MAX_BODY_BYTES = 256 * 1024
MAX_SKILLS = 2_000
MAX_COUNT = 1_000_000_000
RETENTION_DAYS = 90
PLUGIN_VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$")


class ValidationError(ValueError):
    pass


def validate_payload(value: Any, today: date | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError("body must be an object")
    required = {"schema_version", "batch_id", "plugin_version", "day", "skills"}
    if set(value) != required:
        raise ValidationError("body fields do not match schema")
    if value["schema_version"] != 1 or isinstance(value["schema_version"], bool):
        raise ValidationError("unsupported schema_version")

    batch_id = value["batch_id"]
    if not isinstance(batch_id, str):
        raise ValidationError("batch_id must be a UUID")
    try:
        uuid.UUID(batch_id)
    except (ValueError, AttributeError):
        raise ValidationError("batch_id must be a UUID") from None

    plugin_version = value["plugin_version"]
    if not isinstance(plugin_version, str) or not PLUGIN_VERSION_RE.fullmatch(plugin_version):
        raise ValidationError("invalid plugin_version")

    day_text = value["day"]
    if not isinstance(day_text, str):
        raise ValidationError("day must be YYYY-MM-DD")
    try:
        day = date.fromisoformat(day_text)
    except ValueError:
        raise ValidationError("day must be YYYY-MM-DD") from None
    current = today or datetime.now(timezone.utc).date()
    if day > current or day < current - timedelta(days=30):
        raise ValidationError("day is outside the accepted upload window")

    raw_skills = value["skills"]
    if not isinstance(raw_skills, list) or not raw_skills or len(raw_skills) > MAX_SKILLS:
        raise ValidationError("skills must be a non-empty bounded array")
    counts: dict[str, int] = {}
    for item in raw_skills:
        if not isinstance(item, dict) or set(item) != {"name", "count"}:
            raise ValidationError("invalid skill entry")
        name, count = item["name"], item["count"]
        if not isinstance(name, str) or not name or len(name) > 500 or any(ord(c) < 32 for c in name):
            raise ValidationError("invalid skill name")
        if not isinstance(count, int) or isinstance(count, bool) or count < 1 or count > MAX_COUNT:
            raise ValidationError("invalid skill count")
        counts[name] = min(MAX_COUNT, counts.get(name, 0) + count)

    return {
        "schema_version": 1,
        "batch_id": str(uuid.UUID(batch_id)),
        "plugin_version": plugin_version,
        "day": day.isoformat(),
        "skills": counts,
    }


def initialize_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with sqlite3.connect(db_path, timeout=5) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS batches (
                batch_id TEXT PRIMARY KEY,
                day TEXT NOT NULL,
                plugin_version TEXT NOT NULL,
                received_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS skill_usage (
                day TEXT NOT NULL,
                skill TEXT NOT NULL,
                count INTEGER NOT NULL,
                PRIMARY KEY (day, skill)
            )
            """
        )
    try:
        os.chmod(db_path, 0o600)
    except OSError:
        pass


def store_batch(db_path: Path, payload: dict[str, Any]) -> None:
    received_at = datetime.now(timezone.utc)
    cutoff = (received_at.date() - timedelta(days=RETENTION_DAYS)).isoformat()
    with sqlite3.connect(db_path, timeout=5) as connection:
        connection.execute("PRAGMA busy_timeout=5000")
        connection.execute("BEGIN IMMEDIATE")
        inserted = connection.execute(
            "INSERT OR IGNORE INTO batches(batch_id, day, plugin_version, received_at) VALUES (?, ?, ?, ?)",
            (payload["batch_id"], payload["day"], payload["plugin_version"], received_at.isoformat()),
        )
        if inserted.rowcount == 0:
            connection.rollback()
            return
        for name, count in payload["skills"].items():
            connection.execute(
                """
                INSERT INTO skill_usage(day, skill, count) VALUES (?, ?, ?)
                ON CONFLICT(day, skill) DO UPDATE SET count = count + excluded.count
                """,
                (payload["day"], name, count),
            )
        connection.execute("DELETE FROM skill_usage WHERE day < ?", (cutoff,))
        connection.execute("DELETE FROM batches WHERE day < ?", (cutoff,))
        connection.commit()


class TelemetryHandler(BaseHTTPRequestHandler):
    server_version = "codex-skills-telemetry/1"
    sys_version = ""

    @property
    def db_path(self) -> Path:
        return self.server.db_path  # type: ignore[attr-defined]

    def send_json(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self.send_json(HTTPStatus.OK, {"status": "ok"})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/skill-usage":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        if self.headers.get("X-Codex-Skills-Telemetry") != "1":
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "missing telemetry header"})
            return
        if not (self.headers.get("Content-Type") or "").lower().startswith("application/json"):
            self.send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "application/json required"})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json(HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length required"})
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "invalid body size"})
            return
        try:
            raw = self.rfile.read(length)
            payload = validate_payload(json.loads(raw))
            store_batch(self.db_path, payload)
        except (json.JSONDecodeError, ValidationError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid telemetry payload"})
            return
        except sqlite3.Error:
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "storage unavailable"})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        # Deliberately omit the client address and request headers.
        sys.stderr.write(f"{self.log_date_time_string()} {fmt % args}\n")


class TelemetryServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], db_path: Path):
        super().__init__(address, TelemetryHandler)
        self.db_path = db_path
        initialize_db(db_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18990)
    parser.add_argument("--db", default="/var/lib/codex-skills-telemetry/usage.sqlite3")
    args = parser.parse_args()
    server = TelemetryServer((args.host, args.port), Path(args.db))
    sys.stderr.write(f"codex-skills telemetry listening on {args.host}:{args.port}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
