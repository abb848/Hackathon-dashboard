import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import github_client  # noqa: E402
import logic  # noqa: E402
import store  # noqa: E402
from logic import PR  # noqa: E402
from replay import Replay, parse_duration  # noqa: E402

T0 = datetime(2026, 11, 19, 9, 0, tzinfo=timezone.utc)


def pr(n, minutes, merged_after=None, labels=("hackathon",), repo="home-assistant/core"):
    created = T0 + timedelta(minutes=minutes)
    merged = created + timedelta(minutes=merged_after) if merged_after is not None else None
    return PR(repo=repo, number=n, title=f"PR {n}", author="someone", avatar_url="", url=f"https://github.com/{repo}/pull/{n}",
              labels=tuple(labels), created_at=created, merged_at=merged)


class CountTests(unittest.TestCase):
    def test_counts(self):
        prs = [pr(1, 0, merged_after=5), pr(2, 1, labels=("hackathon", "wth")), pr(3, 2, merged_after=1, labels=("WTH",))]
        c = logic.count(prs, T0 + timedelta(hours=1), "WTH")
        self.assertEqual((c.opened, c.merged, c.ready, c.wth), (3, 2, 1, 2))

    def test_counts_ignore_the_future(self):
        prs = [pr(1, 0, merged_after=30), pr(2, 10)]
        c = logic.count(prs, T0 + timedelta(minutes=5), "WTH")
        self.assertEqual((c.opened, c.merged), (1, 0))

    def test_empty(self):
        c = logic.count([], T0, "WTH")
        self.assertEqual((c.opened, c.merged, c.ready, c.wth), (0, 0, 0, 0))


class MilestoneTests(unittest.TestCase):
    def test_none_below_first(self):
        self.assertEqual(logic.new_milestones([pr(i, i) for i in range(9)], [10, 25], set()), [])

    def test_hit_by_nth_created(self):
        prs = [pr(i, 100 - i) for i in range(10)]  # newest first, like the search
        hits = logic.new_milestones(prs, [10, 25], set())
        self.assertEqual([(t, p.number) for t, p in hits], [(10, 0)])

    def test_several_at_once(self):
        hits = logic.new_milestones([pr(i, i) for i in range(30)], [10, 25, 50], set())
        self.assertEqual([(t, p.number) for t, p in hits], [(10, 9), (25, 24)])

    def test_already_hit_does_not_fire_again(self):
        hits = logic.new_milestones([pr(i, i) for i in range(30)], [10, 25], {10, 25})
        self.assertEqual(hits, [])

    def test_progress(self):
        self.assertEqual(logic.progress(0, [10, 25])["next"], 10)
        p = logic.progress(47, [10, 25, 50, 100])
        self.assertEqual((p["prev"], p["next"]), (25, 50))
        self.assertAlmostEqual(p["fraction"], 22 / 25)
        self.assertEqual(logic.progress(120, [10, 25, 50, 100]), {"prev": 100, "next": None, "fraction": 1.0})


class StateTests(unittest.TestCase):
    def test_latest_lists(self):
        prs = [pr(i, i, merged_after=10 if i % 2 else None) for i in range(6)]
        s = logic.build_state(prs, when=T0 + timedelta(hours=1), wth_label="WTH", thresholds=[10], milestones={})
        self.assertEqual([p["number"] for p in s["latest_opened"]], [5, 4, 3, 2])
        self.assertEqual(s["latest_merged"]["number"], 5)

    def test_merge_hidden_before_it_happens(self):
        s = logic.build_state([pr(1, 0, merged_after=30)], when=T0 + timedelta(minutes=5),
                              wth_label="WTH", thresholds=[10], milestones={})
        self.assertIsNone(s["latest_merged"])
        self.assertIsNone(s["latest_opened"][0]["merged"])


class StoreTests(unittest.TestCase):
    def test_round_trip_and_unlabel(self):
        conn = store.connect(":memory:")
        a, b = pr(1, 0, merged_after=5, labels=("hackathon", "WTH")), pr(2, 1)
        store.save_prs(conn, [a, b], T0)
        self.assertEqual(sorted(store.load_prs(conn), key=lambda p: p.number), [a, b])
        store.mark_unlabelled(conn, [a])
        self.assertEqual(store.load_prs(conn), [a])
        store.save_prs(conn, [a, b], T0)
        self.assertEqual(len(store.load_prs(conn)), 2)

    def test_milestone_saved_once(self):
        conn = store.connect(":memory:")
        store.save_milestone(conn, 10, pr(1, 0), T0)
        store.save_milestone(conn, 10, pr(2, 0), T0)
        self.assertEqual(store.load_milestones(conn), {10: "home-assistant/core#1"})


class GitHubTests(unittest.TestCase):
    def test_query(self):
        q = github_client.build_query(["home-assistant", "esphome"], "hackathon 2026", "2026-11-19T09:00:00+01:00")
        self.assertEqual(q, 'is:pr org:home-assistant org:esphome label:"hackathon 2026" created:>=2026-11-19T09:00:00+01:00')

    def test_query_without_label(self):
        q = github_client.build_query(["home-assistant"], "", "2026-11-10T08:00:00Z")
        self.assertEqual(q, "is:pr org:home-assistant created:>=2026-11-10T08:00:00Z")

    def test_parse_item(self):
        p = github_client.parse_item({
            "repository_url": "https://api.github.com/repos/home-assistant/frontend",
            "number": 27851, "title": "Show device area", "html_url": "https://github.com/home-assistant/frontend/pull/27851",
            "user": {"login": "octocat", "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4"},
            "labels": [{"name": "WTH"}], "created_at": "2026-11-19T09:15:00Z",
            "pull_request": {"merged_at": None},
        })
        self.assertEqual((p.repo, p.number, p.author, p.labels), ("home-assistant/frontend", 27851, "octocat", ("WTH",)))
        self.assertEqual(p.created_at, T0 + timedelta(minutes=15))
        self.assertIsNone(p.merged_at)


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class ReplayTests(unittest.TestCase):
    def setUp(self):
        # 30 PRs one minute apart, every third merged five minutes later
        self.prs = [pr(i, i, merged_after=5 if i % 3 == 0 else None) for i in range(30)]

    def test_parse_duration(self):
        self.assertEqual(parse_duration("3m"), 180)
        self.assertEqual(parse_duration("1h30m"), 5400)
        self.assertEqual(parse_duration("90"), 90)
        with self.assertRaises(ValueError):
            parse_duration("soon")

    def test_total_time(self):
        clock = FakeClock()
        r = Replay(self.prs, duration=60, clock=clock, lead_in=5)
        self.assertAlmostEqual(r.real_duration, 60)
        self.assertEqual(r.state(wth_label="WTH", thresholds=[10])["counts"]["opened"], 0)
        clock.t += 5 + 60
        s = r.state(wth_label="WTH", thresholds=[10, 25])
        self.assertEqual(s["counts"]["opened"], 30)
        self.assertEqual(s["counts"]["merged"], 10)
        self.assertEqual(s["rate"], 0)  # finished

    def test_speed(self):
        clock = FakeClock()
        r = Replay(self.prs, speed=60, clock=clock, lead_in=0)
        clock.t += 9.5  # 9.5 minutes of virtual time: PRs at minutes 0 to 9 are out
        s = r.state(wth_label="WTH", thresholds=[10])
        self.assertEqual(s["counts"]["opened"], 10)
        self.assertEqual(s["rate"], 60)

    def test_events_in_order_and_milestones(self):
        clock = FakeClock()
        r = Replay(self.prs, duration=100, clock=clock, lead_in=0)
        seen_opened, seen_milestones = [], []
        for _ in range(101):
            s = r.state(wth_label="WTH", thresholds=[10, 25])
            seen_opened.append(s["counts"]["opened"])
            seen_milestones.append([m["threshold"] for m in s["milestones"]])
            clock.t += 1
        self.assertEqual(seen_opened, sorted(seen_opened))
        self.assertEqual(seen_milestones[-1], [10, 25])
        first_10 = next(i for i, m in enumerate(seen_milestones) if m)
        self.assertEqual(seen_opened[first_10], 10)

    def test_needs_prs(self):
        with self.assertRaises(ValueError):
            Replay([], duration=60)


if __name__ == "__main__":
    unittest.main()
