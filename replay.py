"""Replays stored PRs through the dashboard on a compressed clock (replay, demo and testing)."""
from __future__ import annotations

import re
import time
from datetime import datetime, timedelta
from typing import Callable

import logic
from logic import PR


def parse_duration(text: str) -> float:
    """'3m', '90s', '1h', '1h30m' or plain seconds -> seconds."""
    text = text.strip().lower()
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return float(text)
    parts = re.findall(r"(\d+(?:\.\d+)?)([hms])", text)
    if not parts or "".join(n + u for n, u in parts) != text:
        raise ValueError(f"cannot read duration {text!r}, use e.g. 3m, 90s or 1h30m")
    return sum(float(n) * {"h": 3600, "m": 60, "s": 1}[u] for n, u in parts)


class Replay:
    def __init__(
        self,
        prs: list[PR],
        *,
        duration: float | None = None,
        speed: float | None = None,
        lead_in: float = 5.0,
        clock: Callable[[], float] = time.time,
    ):
        if not prs:
            raise ValueError("there are no PRs in this database to replay")
        if (duration is None) == (speed is None):
            raise ValueError("give either a duration or a speed")
        times = [p.created_at for p in prs] + [p.merged_at for p in prs if p.merged_at]
        # Start just before the first PR so the screen begins at zero
        self.start = min(times) - timedelta(seconds=1)
        self.end = max(times)
        span = (self.end - self.start).total_seconds()
        self.rate = span / duration if duration else speed
        self.real_duration = span / self.rate
        self.prs = prs
        self.clock = clock
        self.real_start = clock() + lead_in

    def elapsed(self) -> float:
        """Real seconds of playback so far, clamped to the replay length."""
        return min(max(self.clock() - self.real_start, 0.0), self.real_duration)

    def virtual_now(self) -> datetime:
        return self.start + timedelta(seconds=self.elapsed() * self.rate)

    def is_running(self) -> bool:
        return 0 < self.clock() - self.real_start < self.real_duration

    def state(self, *, wth_label: str, thresholds: list[int]) -> dict:
        now = self.virtual_now()
        shown = logic.visible_at(self.prs, now)
        milestones = {t: pr.key for t, pr in logic.new_milestones(shown, thresholds, set())}
        state = logic.build_state(
            shown, when=now, wth_label=wth_label, thresholds=thresholds, milestones=milestones
        )
        state.update(
            mode="replay",
            ok=True,
            now=logic.to_ms(now),
            rate=self.rate if self.is_running() else 0,
            last_updated=logic.to_ms(now),
            cycle_start=int(self.real_start * 1000),
            cycle_ms=int(self.real_duration * 1000),
        )
        return state
