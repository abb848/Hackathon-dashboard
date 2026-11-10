"""Fetches PRs from the GitHub search API, using only the standard library."""
from __future__ import annotations

import json
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from logic import PR

SEARCH_URL = "https://api.github.com/search/issues"
PAGE_SIZE = 100
SEARCH_CAP = 1000  # GitHub never returns more than this for one search


class GitHubError(Exception):
    pass


def build_query(orgs: list[str], label: str, start: str) -> str:
    parts = ["is:pr", *(f"org:{org}" for org in orgs)]
    if label:  # an empty label means every PR, which is handy for testing
        parts.append(f'label:"{label}"')
    parts.append(f"created:>={start}")
    return " ".join(parts)


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def parse_item(item: dict) -> PR:
    user = item.get("user") or {}
    return PR(
        repo=item["repository_url"].split("/repos/", 1)[1],
        number=item["number"],
        title=item.get("title") or "",
        author=user.get("login") or "ghost",
        avatar_url=user.get("avatar_url") or "",
        url=item["html_url"],
        labels=tuple(label["name"] for label in item.get("labels") or []),
        created_at=parse_time(item["created_at"]),
        merged_at=parse_time((item.get("pull_request") or {}).get("merged_at")),
    )


def _get(url: str, token: str | None, timeout: float) -> dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ohf-hackathon-dashboard",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        with urlopen(Request(url, headers=headers), timeout=timeout) as response:
            return json.load(response)
    except HTTPError as err:
        raise GitHubError(f"GitHub returned HTTP {err.code}") from None
    except (URLError, OSError) as err:
        raise GitHubError(f"network error: {err}") from None
    except ValueError:
        raise GitHubError("GitHub sent a response that is not JSON") from None


def search_prs(token: str | None, query: str, limit: int = SEARCH_CAP, timeout: float = 20) -> list[PR]:
    """All PRs matching `query`, newest first. Raises GitHubError if anything goes wrong."""
    found: dict[str, PR] = {}
    page = 1
    while len(found) < limit:
        params = urlencode({"q": query, "sort": "created", "order": "desc", "per_page": PAGE_SIZE, "page": page})
        data = _get(f"{SEARCH_URL}?{params}", token, timeout)
        if data.get("incomplete_results"):
            # A partial result would make the numbers drop, so treat it as a failed poll
            raise GitHubError("GitHub returned incomplete results")
        items = data.get("items") or []
        for item in items:
            pr = parse_item(item)
            found.setdefault(pr.key, pr)
        total = min(data.get("total_count", 0), SEARCH_CAP)
        if len(items) < PAGE_SIZE or page * PAGE_SIZE >= total:
            break
        page += 1
    return list(found.values())[:limit]
