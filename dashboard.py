"""Home Assistant hackathon live PR dashboard.

Run it, then open http://localhost:8080 in a browser and press F11 for full screen.

  python dashboard.py                          live dashboard (demo instead if DEMO_MODE is True)
  python dashboard.py demo                     replay the sample database in DEMO_DURATION
  python dashboard.py replay data/x.db --duration 3m   replay any database in a set time
  python dashboard.py replay data/x.db --speed 60      replay at 60x real speed (for timelapses)
  python dashboard.py import-sample            copy recent real PRs into the sample database
  python dashboard.py import-sample --query "is:pr org:home-assistant label:WTH" --limit 50

Add --port 8000 after the command to use a different port.
"""
from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import github_client
import logic
import store
from replay import Replay, parse_duration

# ---------------------------------------------------------------------------
# Settings: edit these
# ---------------------------------------------------------------------------
# The label plus the start time identify a hackathon, so for the next one just change the start time.
# An empty label ("") shows every PR in ORGS, for testing.
HACKATHON_LABEL = "hackathon"
WTH_LABEL = "WTH"
START_TIME = "2026-11-19T09:00:00+01:00"  # PRs created before this are ignored
ORGS = ["home-assistant"]
EVENT_LOCATION = "THE HAGUE"
MILESTONES = [10, 25, 50, 100]
POLL_SECONDS = 20  # each check is one GitHub search per 100 PRs; the limit is 30 searches a minute
PORT = 8080

DEMO_MODE = False  # True: plain "python dashboard.py" runs the demo instead of live
DEMO_DB = "data/sample.db"
DEMO_DURATION = "3m"
# ---------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent
STATIC_DIR = HERE / "static"
TOKEN_FILE = HERE / "github_token.txt"
START = datetime.fromisoformat(START_TIME)
EVENT_SUBTITLE = f"{EVENT_LOCATION} · {START.day} {START:%b %Y}".upper()
# One database per label and date, so tests and earlier hackathons never block this one's milestones
LIVE_DB = HERE / "data" / f"live-{HACKATHON_LABEL}-{START:%Y-%m-%d}.db"


def log(message: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {message}", flush=True)


def read_token() -> str | None:
    if TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if token:
            return token
    log(f"No token in {TOKEN_FILE.name}, using GitHub without one (lower rate limit)")
    return None


class LiveSource:
    """Polls GitHub in a background thread and keeps the latest state in memory."""

    def __init__(self, token: str | None):
        self.token = token
        self.query = github_client.build_query(ORGS, HACKATHON_LABEL, START_TIME)
        self.conn = store.connect(LIVE_DB)
        # Last known values, so a restart shows numbers straight away
        self.prs = store.load_prs(self.conn)
        self.milestones = store.load_milestones(self.conn)
        self.ok = True
        self.last_updated: datetime | None = None
        self.cycle_start = time.time()
        self._state = self._build()

    def start(self) -> None:
        log(f"Searching GitHub for: {self.query}")
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        while True:
            started = time.time()
            self.poll_once(started)
            time.sleep(max(1.0, started + POLL_SECONDS - time.time()))

    def poll_once(self, started: float) -> None:
        try:
            prs = github_client.search_prs(self.token, self.query)
        except github_client.GitHubError as err:
            self.ok = False
            log(f"Update failed, keeping the last values: {err}")
        else:
            now = datetime.now(timezone.utc)
            store.save_prs(self.conn, prs, now)
            store.mark_unlabelled(self.conn, prs)
            for threshold, pr in logic.new_milestones(prs, MILESTONES, set(self.milestones)):
                store.save_milestone(self.conn, threshold, pr, now)
                self.milestones[threshold] = pr.key
                log(f"Milestone {threshold} reached by {pr.key}")
            if not self.ok:
                log("Connection is back")
            self.prs, self.ok, self.last_updated = prs, True, now
        self.cycle_start = started
        self._state = self._build()

    def _build(self) -> dict:
        state = logic.build_state(
            self.prs,
            when=datetime.now(timezone.utc),
            wth_label=WTH_LABEL,
            thresholds=MILESTONES,
            milestones=dict(self.milestones),
        )
        state.update(
            mode="live",
            ok=self.ok,
            rate=1,
            last_updated=logic.to_ms(self.last_updated),
            cycle_start=int(self.cycle_start * 1000),
            cycle_ms=POLL_SECONDS * 1000,
        )
        return state

    def state(self) -> dict:
        return {**self._state, "now": int(time.time() * 1000)}


class ReplaySource:
    def __init__(self, replay: Replay):
        self.replay = replay

    def start(self) -> None:
        log(f"Replaying {len(self.replay.prs)} PRs over {self.replay.real_duration:.0f} seconds "
            f"({self.replay.rate:.0f}x speed), starting in a few seconds")

    def state(self) -> dict:
        return self.replay.state(wth_label=WTH_LABEL, thresholds=MILESTONES)


class Handler(SimpleHTTPRequestHandler):
    source: LiveSource | ReplaySource

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/api/state":
            state = self.source.state()
            state.update(label=HACKATHON_LABEL, subtitle=EVENT_SUBTITLE, server_time=int(time.time() * 1000))
            body = json.dumps(state).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, format, *args) -> None:
        pass


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address) -> None:
        # Browsers closing connections early is normal, don't print tracebacks for it
        if not isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            super().handle_error(request, client_address)


def lan_address() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 80))  # no packet is sent, this just picks the LAN interface
            return s.getsockname()[0]
    except OSError:
        return None


def serve(source: LiveSource | ReplaySource, port: int) -> None:
    Handler.source = source
    server = Server(("0.0.0.0", port), Handler)
    source.start()
    log(f"Dashboard running at http://localhost:{port}")
    if ip := lan_address():
        log(f"Other devices on this network: http://{ip}:{port}")
    log("Press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Stopped")


def make_replay(db_path: str, duration: str | None, speed: float | None) -> Replay:
    path = Path(db_path)
    if not path.exists():
        sys.exit(f"Database not found: {path}")
    prs = store.load_prs(store.connect(path))
    if speed is None and duration is None:
        duration = DEMO_DURATION
    try:
        return Replay(prs, duration=parse_duration(duration) if duration else None, speed=speed)
    except ValueError as err:
        sys.exit(str(err))


def import_sample(query: str, limit: int, db_path: str) -> None:
    path = Path(db_path).resolve()
    if path.name.startswith("live-"):
        sys.exit("Refusing to import sample data into a live database")
    try:
        prs = github_client.search_prs(read_token(), query, limit=limit)
    except github_client.GitHubError as err:
        sys.exit(f"Import failed: {err}")
    conn = store.connect(path)
    store.save_prs(conn, prs, datetime.now(timezone.utc))
    total = conn.execute("SELECT COUNT(*) FROM prs").fetchone()[0]
    log(f"Imported {len(prs)} PRs into {path} ({total} in total)")


def main() -> None:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--port", type=int, default=PORT)

    def add_timing(p: argparse.ArgumentParser) -> None:
        group = p.add_mutually_exclusive_group()
        group.add_argument("--duration", help="total playback time, e.g. 3m (default %s)" % DEMO_DURATION)
        group.add_argument("--speed", type=float, help="speed multiplier, e.g. 60")

    parser = argparse.ArgumentParser(description="Hackathon live PR dashboard", parents=[common])
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("live", parents=[common], help="live dashboard from GitHub")
    demo = sub.add_parser("demo", parents=[common], help="replay the sample database")
    demo.add_argument("--db", default=str(HERE / DEMO_DB))
    add_timing(demo)
    rep = sub.add_parser("replay", parents=[common], help="replay any database")
    rep.add_argument("db")
    add_timing(rep)
    imp = sub.add_parser("import-sample", help="copy real PRs from a GitHub search into a sample database")
    imp.add_argument("--query", default="is:pr " + " ".join(f"org:{o}" for o in ORGS))
    imp.add_argument("--limit", type=int, default=100)
    imp.add_argument("--db", default=str(HERE / DEMO_DB))
    args = parser.parse_args()

    command = args.command or ("demo" if DEMO_MODE else "live")
    if command == "import-sample":
        import_sample(args.query, args.limit, args.db)
    elif command == "live":
        serve(LiveSource(read_token()), args.port)
    else:
        db = getattr(args, "db", None) or str(HERE / DEMO_DB)
        serve(ReplaySource(make_replay(db, getattr(args, "duration", None), getattr(args, "speed", None))),
              args.port)


if __name__ == "__main__":
    main()
