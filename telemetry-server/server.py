#!/usr/bin/env python3
"""Minimal anonymous daily skill-usage collector.

The public Nginx site forwards one exact POST path to this loopback-only
service. No IP address, headers, prompts, file paths, or task content are
stored. A batch ID makes retries idempotent.
"""

from __future__ import annotations

import argparse
import html
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
from urllib.parse import parse_qs, urlsplit

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


def dashboard_data(db_path: Path, days: int, today: date | None = None) -> dict[str, Any]:
    if days not in (7, 30, 90):
        days = 30
    current = today or datetime.now(timezone.utc).date()
    cutoff = (current - timedelta(days=days - 1)).isoformat()
    with sqlite3.connect(db_path, timeout=5) as connection:
        total_count, used_skills, active_days, last_day = connection.execute(
            """
            SELECT COALESCE(SUM(count), 0),
                   COUNT(DISTINCT skill),
                   COUNT(DISTINCT day),
                   MAX(day)
            FROM skill_usage
            """
        ).fetchone()
        daily = connection.execute(
            """
            SELECT day, SUM(count), COUNT(DISTINCT skill)
            FROM skill_usage
            WHERE day >= ?
            GROUP BY day
            ORDER BY day DESC
            """,
            (cutoff,),
        ).fetchall()
        top = connection.execute(
            """
            SELECT skill, SUM(count) AS total
            FROM skill_usage
            WHERE day >= ?
            GROUP BY skill
            ORDER BY total DESC, skill ASC
            LIMIT 25
            """,
            (cutoff,),
        ).fetchall()
        skills = connection.execute(
            """
            SELECT skill, SUM(count) AS total,
                   COUNT(DISTINCT day) AS active_days,
                   MAX(day) AS last_day
            FROM skill_usage
            WHERE day >= ?
            GROUP BY skill
            ORDER BY total ASC, skill ASC
            """,
            (cutoff,),
        ).fetchall()
    return {
        "days": days,
        "total_count": int(total_count),
        "used_skills": int(used_skills),
        "active_days": int(active_days),
        "last_day": last_day,
        "daily": daily,
        "top": top,
        "skills": skills,
    }


def render_dashboard(data: dict[str, Any]) -> str:
    days = int(data["days"])
    total_count = int(data["total_count"])
    used_skills = int(data["used_skills"])
    active_days = int(data["active_days"])
    last_day = data["last_day"] or "暂无"
    daily = data["daily"]
    top = data["top"]
    skills = data["skills"]
    max_top = max((int(row[1]) for row in top), default=1)

    tabs = "".join(
        f'<a class="tab{" active" if days == value else ""}" href="?days={value}">{value} 天</a>'
        for value in (7, 30, 90)
    )
    daily_rows = "".join(
        "<tr>"
        f"<td>{html.escape(str(day))}</td>"
        f"<td>{int(count):,}</td>"
        f"<td>{int(skill_count):,}</td>"
        "</tr>"
        for day, count, skill_count in daily
    ) or '<tr><td colspan="3" class="empty">暂无统计数据</td></tr>'
    top_rows = "".join(
        "<tr>"
        f'<td class="skill">{html.escape(str(skill))}</td>'
        f"<td>{int(count):,}</td>"
        f'<td><span class="bar" style="width:{max(2, round(int(count) / max_top * 100))}%"></span></td>'
        "</tr>"
        for skill, count in top
    ) or '<tr><td colspan="3" class="empty">暂无统计数据</td></tr>'
    skill_rows = "".join(
        "<tr>"
        f'<td class="skill">{html.escape(str(skill))}</td>'
        f"<td>{int(count):,}</td>"
        f"<td>{int(active):,}</td>"
        f"<td>{html.escape(str(last_seen))}</td>"
        "</tr>"
        for skill, count, active, last_seen in skills
    ) or '<tr><td colspan="4" class="empty">暂无统计数据</td></tr>'

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta http-equiv="refresh" content="300">
  <title>Codex Skills 使用统计</title>
  <style>
    :root {{ color-scheme: dark; --bg:#0e1015; --card:#171a22; --line:#2b303d; --text:#f3f5f9; --muted:#9ca5b7; --accent:#9b8cff; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:radial-gradient(circle at 15% 0%,#242047 0,transparent 34%),var(--bg); color:var(--text); font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }}
    main {{ width:min(1120px,calc(100% - 32px)); margin:0 auto; padding:48px 0 64px; }}
    header {{ display:flex; align-items:end; justify-content:space-between; gap:24px; margin-bottom:28px; }}
    h1 {{ margin:0 0 6px; font-size:30px; letter-spacing:-.03em; }}
    .sub {{ color:var(--muted); }}
    .tabs {{ display:flex; gap:8px; }}
    .tab {{ color:var(--muted); text-decoration:none; border:1px solid var(--line); border-radius:999px; padding:7px 12px; }}
    .tab.active {{ color:white; border-color:#7163d8; background:#6355c8; }}
    .cards {{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:24px; }}
    .card, section {{ background:rgba(23,26,34,.93); border:1px solid var(--line); border-radius:16px; }}
    .card {{ padding:18px 20px; }}
    .card b {{ display:block; font-size:28px; margin-top:4px; letter-spacing:-.03em; }}
    .card span {{ color:var(--muted); font-size:13px; }}
    .grid {{ display:grid; grid-template-columns:1fr 1fr; gap:18px; }}
    .wide {{ margin-top:18px; }}
    section {{ overflow:hidden; }}
    h2 {{ margin:0; padding:17px 20px; font-size:16px; border-bottom:1px solid var(--line); }}
    table {{ width:100%; border-collapse:collapse; }}
    th,td {{ text-align:left; padding:11px 20px; border-bottom:1px solid #232733; }}
    th {{ color:var(--muted); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; }}
    tr:last-child td {{ border-bottom:0; }}
    td:nth-child(n+2), th:nth-child(n+2) {{ text-align:right; }}
    .skill {{ max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
    td:last-child {{ width:38%; }}
    .bar {{ display:block; height:8px; min-width:3px; border-radius:8px; background:linear-gradient(90deg,#7667e6,#b99cff); }}
    .empty {{ text-align:center !important; color:var(--muted); padding:34px; }}
    footer {{ color:var(--muted); margin-top:22px; font-size:12px; }}
    @media(max-width:760px) {{ .cards{{grid-template-columns:1fr 1fr}} .grid{{grid-template-columns:1fr}} header{{align-items:start;flex-direction:column}} }}
  </style>
</head>
<body><main>
  <header>
    <div><h1>Codex Skills 使用统计</h1><div class="sub">匿名每日聚合 · 最近更新日期 {html.escape(str(last_day))}</div></div>
    <nav class="tabs">{tabs}</nav>
  </header>
  <div class="cards">
    <div class="card"><span>累计成功调用</span><b>{total_count:,}</b></div>
    <div class="card"><span>使用过的技能</span><b>{used_skills:,}</b></div>
    <div class="card"><span>有数据的日期</span><b>{active_days:,}</b></div>
    <div class="card"><span>最后上报日期</span><b style="font-size:20px">{html.escape(str(last_day))}</b></div>
  </div>
  <div class="grid">
    <section><h2>每日调用</h2><table><thead><tr><th>日期（UTC）</th><th>调用次数</th><th>技能数</th></tr></thead><tbody>{daily_rows}</tbody></table></section>
    <section><h2>高频技能 · 最近 {days} 天</h2><table><thead><tr><th>技能</th><th>次数</th><th>占比</th></tr></thead><tbody>{top_rows}</tbody></table></section>
  </div>
  <section class="wide"><h2>全部技能明细 · 最近 {days} 天 · 按次数从低到高</h2><table><thead><tr><th>技能</th><th>调用次数</th><th>有使用的天数</th><th>最后使用日期</th></tr></thead><tbody>{skill_rows}</tbody></table></section>
  <footer>只展示匿名聚合次数；不包含用户任务、搜索词、文件路径或调用详情。页面每 5 分钟刷新。</footer>
</main></body></html>"""


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

    def send_html(self, status: HTTPStatus, body: str) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802
        request = urlsplit(self.path)
        if request.path == "/healthz":
            self.send_json(HTTPStatus.OK, {"status": "ok"})
            return
        if request.path in ("/usage", "/usage/"):
            try:
                raw_days = parse_qs(request.query).get("days", ["30"])[0]
                days = int(raw_days)
                if days not in (7, 30, 90):
                    days = 30
                dashboard = dashboard_data(self.db_path, days)
                self.send_html(HTTPStatus.OK, render_dashboard(dashboard))
            except (ValueError, sqlite3.Error):
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "dashboard unavailable"})
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
