"""Pure dashboard logic: counting, milestones and the state sent to the browser.

No network or database code here, so it is easy to unit test.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class PR:
    repo: str  # full name, e.g. "home-assistant/core"
    number: int
    title: str
    author: str
    avatar_url: str
    url: str
    labels: tuple[str, ...]
    created_at: datetime
    merged_at: datetime | None = None

    @property
    def key(self) -> str:
        return f"{self.repo}#{self.number}"

    def has_label(self, name: str) -> bool:
        # GitHub label names are case-insensitive
        wanted = name.lower()
        return any(label.lower() == wanted for label in self.labels)

    def is_merged_by(self, when: datetime) -> bool:
        return self.merged_at is not None and self.merged_at <= when


@dataclass(frozen=True)
class Counts:
    opened: int
    merged: int
    wth: int

    @property
    def ready(self) -> int:
        return self.opened - self.merged


def visible_at(prs: list[PR], when: datetime) -> list[PR]:
    """PRs that exist at `when`. Live mode passes "now", so this keeps everything."""
    return [p for p in prs if p.created_at <= when]


def count(prs: list[PR], when: datetime, wth_label: str) -> Counts:
    shown = visible_at(prs, when)
    return Counts(
        opened=len(shown),
        merged=sum(1 for p in shown if p.is_merged_by(when)),
        wth=sum(1 for p in shown if p.has_label(wth_label)),
    )


def by_creation(prs: list[PR]) -> list[PR]:
    return sorted(prs, key=lambda p: (p.created_at, p.repo, p.number))


def new_milestones(prs: list[PR], thresholds: list[int], already_hit: set[int]) -> list[tuple[int, PR]]:
    """Milestones reached by `prs` that are not in `already_hit`, with the PR that hit each one."""
    ordered = by_creation(prs)
    return [
        (t, ordered[t - 1])
        for t in sorted(thresholds)
        if t not in already_hit and len(ordered) >= t
    ]


def progress(opened: int, thresholds: list[int]) -> dict:
    """Progress from the previous milestone to the next one, as the bar shows it."""
    ordered = sorted(thresholds)
    prev = max((t for t in ordered if t <= opened), default=0)
    nxt = next((t for t in ordered if t > opened), None)
    if nxt is None:
        return {"prev": prev, "next": None, "fraction": 1.0}
    return {"prev": prev, "next": nxt, "fraction": (opened - prev) / (nxt - prev)}


def to_ms(when: datetime | None) -> int | None:
    return None if when is None else int(when.timestamp() * 1000)


def pr_json(pr: PR, when: datetime, wth_label: str) -> dict:
    return {
        "key": pr.key,
        "repo": pr.repo,
        "repo_name": pr.repo.split("/")[-1],
        "number": pr.number,
        "title": pr.title,
        "author": pr.author,
        "avatar": pr.avatar_url,
        "url": pr.url,
        "wth": pr.has_label(wth_label),
        "created": to_ms(pr.created_at),
        "merged": to_ms(pr.merged_at) if pr.is_merged_by(when) else None,
    }


def build_state(
    prs: list[PR],
    *,
    when: datetime,
    wth_label: str,
    thresholds: list[int],
    milestones: dict[int, str],
    latest_count: int = 4,
) -> dict:
    """The data part of the browser state, as it looks at time `when`.

    `milestones` maps threshold -> key of the PR that hit it.
    """
    shown = visible_at(prs, when)
    counts = count(shown, when, wth_label)
    newest_first = list(reversed(by_creation(shown)))
    merged = sorted((p for p in shown if p.is_merged_by(when)), key=lambda p: p.merged_at, reverse=True)
    return {
        "counts": {
            "opened": counts.opened,
            "merged": counts.merged,
            "ready": counts.ready,
            "wth": counts.wth,
        },
        "progress": progress(counts.opened, thresholds),
        "milestones": [{"threshold": t, "key": k} for t, k in sorted(milestones.items())],
        "latest_opened": [pr_json(p, when, wth_label) for p in newest_first[:latest_count]],
        "latest_merged": pr_json(merged[0], when, wth_label) if merged else None,
    }
