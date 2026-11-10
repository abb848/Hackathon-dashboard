"""SQLite storage: every hackathon PR seen, and which PR hit which milestone."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from logic import PR

SCHEMA = """
CREATE TABLE IF NOT EXISTS prs (
    repo           TEXT    NOT NULL,
    number         INTEGER NOT NULL,
    title          TEXT    NOT NULL,
    author         TEXT    NOT NULL,
    avatar_url     TEXT    NOT NULL,
    url            TEXT    NOT NULL,
    labels         TEXT    NOT NULL,  -- JSON list of label names
    created_at     TEXT    NOT NULL,  -- ISO 8601, UTC
    merged_at      TEXT,
    first_seen_at  TEXT    NOT NULL,
    last_seen_at   TEXT    NOT NULL,
    still_labelled INTEGER NOT NULL DEFAULT 1,  -- 0 if the label was removed later
    PRIMARY KEY (repo, number)
);
CREATE TABLE IF NOT EXISTS milestones (
    threshold INTEGER PRIMARY KEY,
    repo      TEXT    NOT NULL,
    number    INTEGER NOT NULL,
    hit_at    TEXT    NOT NULL
);
"""


def _iso(when: datetime | None) -> str | None:
    return None if when is None else when.astimezone(timezone.utc).isoformat()


def _parse(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)


def connect(path: str | Path) -> sqlite3.Connection:
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.executescript(SCHEMA)
    return conn


def save_prs(conn: sqlite3.Connection, prs: list[PR], seen_at: datetime) -> None:
    seen = _iso(seen_at)
    with conn:
        conn.executemany(
            """
            INSERT INTO prs (repo, number, title, author, avatar_url, url, labels,
                             created_at, merged_at, first_seen_at, last_seen_at, still_labelled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT (repo, number) DO UPDATE SET
                title = excluded.title,
                avatar_url = excluded.avatar_url,
                labels = excluded.labels,
                merged_at = excluded.merged_at,
                last_seen_at = excluded.last_seen_at,
                still_labelled = 1
            """,
            [
                (p.repo, p.number, p.title, p.author, p.avatar_url, p.url, json.dumps(list(p.labels)),
                 _iso(p.created_at), _iso(p.merged_at), seen, seen)
                for p in prs
            ],
        )


def mark_unlabelled(conn: sqlite3.Connection, current: list[PR]) -> None:
    """Flag stored PRs that are no longer in the search, e.g. because the label was removed."""
    keep = {(p.repo, p.number) for p in current}
    rows = conn.execute("SELECT repo, number FROM prs WHERE still_labelled = 1").fetchall()
    gone = [row for row in rows if tuple(row) not in keep]
    with conn:
        conn.executemany("UPDATE prs SET still_labelled = 0 WHERE repo = ? AND number = ?", gone)


def load_prs(conn: sqlite3.Connection) -> list[PR]:
    rows = conn.execute(
        """SELECT repo, number, title, author, avatar_url, url, labels, created_at, merged_at
           FROM prs WHERE still_labelled = 1"""
    ).fetchall()
    return [
        PR(
            repo=repo, number=number, title=title, author=author, avatar_url=avatar, url=url,
            labels=tuple(json.loads(labels)), created_at=_parse(created), merged_at=_parse(merged),
        )
        for repo, number, title, author, avatar, url, labels, created, merged in rows
    ]


def load_milestones(conn: sqlite3.Connection) -> dict[int, str]:
    rows = conn.execute("SELECT threshold, repo, number FROM milestones").fetchall()
    return {threshold: f"{repo}#{number}" for threshold, repo, number in rows}


def save_milestone(conn: sqlite3.Connection, threshold: int, pr: PR, hit_at: datetime) -> None:
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO milestones (threshold, repo, number, hit_at) VALUES (?, ?, ?, ?)",
            (threshold, pr.repo, pr.number, _iso(hit_at)),
        )
