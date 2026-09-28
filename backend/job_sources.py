"""
Real job sources for the Teen Job Finder backend.

Each fetcher returns a list of ``RawJob`` dicts in the common shape used by
``main.Job``.  Sources are tried in parallel, results are de-duplicated and
cached for ``CACHE_TTL_SECONDS``.  Nothing here calls Claude - the labour-law
pre-screen in ``main.py`` runs on the merged feed afterwards.

Sources (all HTTPS, JSON):

  Adzuna       https://developer.adzuna.com      free key, LOCAL results in 16+ countries (best fit)
  Arbeitnow    https://www.arbeitnow.com/api/job-board-api   no key, Europe-heavy, includes part-time
  The Muse     https://www.themuse.com/developers/api/v2     no key, internships and entry level
  Jobicy       https://jobicy.com/jobs-rss-feed  no key, remote roles
  Remotive     https://remotive.com/api/remote-jobs          no key, remote roles

Set ADZUNA_APP_ID / ADZUNA_APP_KEY to enable Adzuna.  Set JOB_SOURCES to a
comma-separated subset (e.g. "adzuna,arbeitnow") to restrict which run.
"""

from __future__ import annotations

import asyncio
import hashlib
import html
import logging
import os
import re
import time
from typing import Any, Callable, Awaitable

import httpx2 as httpx

logger = logging.getLogger("teen-job-finder.sources")

CACHE_TTL_SECONDS = int(os.getenv("JOB_CACHE_TTL", "900"))
REQUEST_TIMEOUT = float(os.getenv("JOB_SOURCE_TIMEOUT", "12"))
MAX_PER_SOURCE = int(os.getenv("JOB_MAX_PER_SOURCE", "40"))
USER_AGENT = "FirstShift-TeenJobFinder/1.0 (+https://github.com/tenev535-boop/Job-finder-)"

# Words that usually mean "a teenager could do this".  A job needs at least
# one of them somewhere in its title/description/category to make the feed,
# unless it came from a keyword search that already filtered (Adzuna).
STUDENT_TERMS = [
    "part-time", "part time", "weekend", "student", "junior", "trainee", "intern", "seasonal",
    "summer", "holiday", "saturday", "sunday", "after school", "casual", "minijob", "werkstudent",
    "aushilfe", "cafe", "café", "barista", "retail", "shop assistant", "sales assistant", "tutor",
    "camp", "lifeguard", "library", "crew member", "team member", "helper", "assistant", "no experience",
    "entry level", "entry-level", "school leaver", "16",
]
DEFAULT_QUERY = os.getenv("JOB_DEFAULT_QUERY", "part time student weekend")

RawJob = dict[str, Any]

_cache: dict[str, tuple[float, list[RawJob]]] = {}


def _strip_html(text: str | None, limit: int = 1200) -> str:
    if not text:
        return ""
    text = re.sub(r"<br\s*/?>|</p>|</li>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    return text[:limit]


def _job_id(source: str, unique: str) -> str:
    return f"{source}-{hashlib.sha1(unique.encode('utf-8')).hexdigest()[:10]}"


def _looks_student_friendly(*parts: str) -> bool:
    blob = " ".join(p or "" for p in parts).lower()
    return any(term in blob for term in STUDENT_TERMS)


def _job_type(*parts: str) -> str:
    blob = " ".join(p or "" for p in parts).lower()
    if "intern" in blob:
        return "Internship"
    if any(w in blob for w in ("seasonal", "summer", "holiday", "christmas")):
        return "Seasonal"
    if "weekend" in blob or "saturday" in blob or "sunday" in blob:
        return "Weekend"
    if "full-time" in blob or "full time" in blob or "vollzeit" in blob:
        return "Full-time"
    return "Part-time"


def _hours(text: str) -> int | None:
    m = re.search(r"(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*(?:h|hrs|hours|stunden)\s*(?:per|a|/|pro)\s*(?:week|wk|woche)", text, re.I)
    if not m:
        return None
    return int(m.group(2) or m.group(1))


def _shift_end(text: str) -> str | None:
    """Best-effort latest finish time mentioned in the ad, as HH:MM."""
    latest: int | None = None
    for m in re.finditer(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)", text, re.I):
        h, mi = int(m.group(1)), int(m.group(2) or 0)
        if h > 12:
            continue
        if m.group(3).lower() == "pm" and h != 12:
            h += 12
        if m.group(3).lower() == "am" and h == 12:
            h = 0
        latest = max(latest or 0, h * 60 + mi)
    for m in re.finditer(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", text):
        latest = max(latest or 0, int(m.group(1)) * 60 + int(m.group(2)))
    if latest is None:
        return None
    return f"{latest // 60:02d}:{latest % 60:02d}"


def _base(source: str, unique: str, title: str, company: str, location: str, description: str, url: str,
          pay: str = "", posted_at: str = "", tags: list[str] | None = None, schedule: str = "") -> RawJob:
    desc = _strip_html(description)
    blob = f"{title} {desc} {schedule}"
    return {
        "id": _job_id(source, unique),
        "source": source,
        "title": title.strip()[:120],
        "company": (company or "").strip()[:80],
        "location": (location or "").strip()[:80],
        "pay": pay,
        "schedule": schedule,
        "hours_per_week": _hours(blob),
        "shift_start": None,
        "shift_end": _shift_end(blob),
        "job_type": _job_type(blob),
        "min_age": None,
        "description": desc,
        "tags": [t for t in (tags or []) if t][:8],
        "posted_at": posted_at[:10] if posted_at else "",
        "url": url,
    }


# --------------------------------------------------------------------------
# Fetchers
# --------------------------------------------------------------------------

async def fetch_adzuna(client: httpx.AsyncClient, query: str, location: str, country: str) -> list[RawJob]:
    app_id, app_key = os.getenv("ADZUNA_APP_ID"), os.getenv("ADZUNA_APP_KEY")
    if not (app_id and app_key):
        return []
    country = (country or "gb").lower()
    params = {
        "app_id": app_id, "app_key": app_key, "results_per_page": MAX_PER_SOURCE,
        "what": query or DEFAULT_QUERY, "part_time": "1", "content-type": "application/json",
    }
    if location:
        params["where"] = location
    r = await client.get(f"https://api.adzuna.com/v1/api/jobs/{country}/search/1", params=params)
    r.raise_for_status()
    out = []
    for j in r.json().get("results", []):
        pay = ""
        if j.get("salary_min") or j.get("salary_max"):
            lo, hi = j.get("salary_min"), j.get("salary_max")
            pay = f"{int(lo or hi):,} - {int(hi or lo):,} / year" if lo != hi else f"{int(lo):,} / year"
        out.append(_base(
            "adzuna", str(j.get("id")), j.get("title", ""), (j.get("company") or {}).get("display_name", ""),
            (j.get("location") or {}).get("display_name", ""), j.get("description", ""), j.get("redirect_url", ""),
            pay=pay, posted_at=j.get("created", ""), tags=[(j.get("category") or {}).get("label", "")],
            schedule=j.get("contract_time", "") or "",
        ))
    return out


async def fetch_arbeitnow(client: httpx.AsyncClient, query: str, location: str, country: str) -> list[RawJob]:
    r = await client.get("https://www.arbeitnow.com/api/job-board-api", params={"page": 1})
    r.raise_for_status()
    out = []
    for j in r.json().get("data", []):
        types = [t for t in (j.get("job_types") or []) if t]
        tags = [t for t in (j.get("tags") or []) if t]
        if not _looks_student_friendly(j.get("title", ""), " ".join(types), " ".join(tags), j.get("description", "")[:2000]):
            continue
        out.append(_base(
            "arbeitnow", j.get("slug") or j.get("url", ""), j.get("title", ""), j.get("company_name", ""),
            j.get("location", "") + (" (remote)" if j.get("remote") else ""), j.get("description", ""), j.get("url", ""),
            tags=(types + tags)[:8], schedule=", ".join(types),
            posted_at=time.strftime("%Y-%m-%d", time.gmtime(j["created_at"])) if isinstance(j.get("created_at"), (int, float)) else "",
        ))
    return out[:MAX_PER_SOURCE]


async def fetch_themuse(client: httpx.AsyncClient, query: str, location: str, country: str) -> list[RawJob]:
    params: dict[str, Any] = {"page": 1, "level": "Internship", "descending": "true"}
    if location:
        params["location"] = location
    r = await client.get("https://www.themuse.com/api/public/jobs", params=params)
    r.raise_for_status()
    out = []
    for j in r.json().get("results", []):
        locs = ", ".join(l.get("name", "") for l in (j.get("locations") or [])[:2])
        cats = [c.get("name", "") for c in (j.get("categories") or [])]
        out.append(_base(
            "themuse", str(j.get("id")), j.get("name", ""), (j.get("company") or {}).get("name", ""), locs,
            j.get("contents", ""), (j.get("refs") or {}).get("landing_page", ""), posted_at=j.get("publication_date", ""),
            tags=cats + [l.get("name", "") for l in (j.get("levels") or [])],
        ))
    return out[:MAX_PER_SOURCE]


async def fetch_jobicy(client: httpx.AsyncClient, query: str, location: str, country: str) -> list[RawJob]:
    r = await client.get("https://jobicy.com/api/v2/remote-jobs", params={"count": MAX_PER_SOURCE, "tag": query or "assistant"})
    r.raise_for_status()
    out = []
    for j in r.json().get("jobs", []):
        if not _looks_student_friendly(j.get("jobTitle", ""), j.get("jobType", "") if isinstance(j.get("jobType"), str) else " ".join(j.get("jobType") or []), j.get("jobLevel", ""), j.get("jobExcerpt", "")):
            continue
        job_type = j.get("jobType")
        job_type_txt = job_type if isinstance(job_type, str) else ", ".join(job_type or [])
        pay = ""
        if j.get("annualSalaryMin") or j.get("annualSalaryMax"):
            pay = f"{j.get('annualSalaryMin') or ''}-{j.get('annualSalaryMax') or ''} {j.get('salaryCurrency') or ''}/year".strip()
        out.append(_base(
            "jobicy", str(j.get("id")), j.get("jobTitle", ""), j.get("companyName", ""), (j.get("jobGeo") or "Remote"),
            j.get("jobDescription") or j.get("jobExcerpt", ""), j.get("url", ""), pay=pay, posted_at=j.get("pubDate", ""),
            tags=(j.get("jobIndustry") or [])[:4] + [job_type_txt], schedule=job_type_txt,
        ))
    return out


async def fetch_remotive(client: httpx.AsyncClient, query: str, location: str, country: str) -> list[RawJob]:
    r = await client.get("https://remotive.com/api/remote-jobs", params={"limit": MAX_PER_SOURCE * 2, "search": query or "assistant"})
    r.raise_for_status()
    out = []
    for j in r.json().get("jobs", []):
        if not _looks_student_friendly(j.get("title", ""), j.get("job_type", ""), j.get("category", ""), j.get("description", "")[:2000]):
            continue
        out.append(_base(
            "remotive", str(j.get("id")), j.get("title", ""), j.get("company_name", ""),
            j.get("candidate_required_location") or "Remote", j.get("description", ""), j.get("url", ""),
            pay=j.get("salary", "") or "", posted_at=j.get("publication_date", ""),
            tags=[j.get("category", ""), j.get("job_type", "")] + (j.get("tags") or [])[:4], schedule=j.get("job_type", "") or "",
        ))
    return out[:MAX_PER_SOURCE]


FETCHERS: dict[str, Callable[[httpx.AsyncClient, str, str, str], Awaitable[list[RawJob]]]] = {
    "adzuna": fetch_adzuna,
    "arbeitnow": fetch_arbeitnow,
    "themuse": fetch_themuse,
    "jobicy": fetch_jobicy,
    "remotive": fetch_remotive,
}


def enabled_sources() -> list[str]:
    wanted = [s.strip().lower() for s in os.getenv("JOB_SOURCES", ",".join(FETCHERS)).split(",") if s.strip()]
    return [s for s in wanted if s in FETCHERS]


async def fetch_all(query: str = "", location: str = "", country: str = "gb") -> tuple[list[RawJob], dict[str, str]]:
    """Fetch every enabled source concurrently.  Returns (jobs, per-source status)."""
    key = f"{query}|{location}|{country}|{','.join(enabled_sources())}"
    now = time.time()
    if key in _cache and now - _cache[key][0] < CACHE_TTL_SECONDS:
        return _cache[key][1], {"cache": "hit"}

    status: dict[str, str] = {}
    jobs: list[RawJob] = []
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}, follow_redirects=True) as client:
        names = enabled_sources()
        results = await asyncio.gather(*(FETCHERS[n](client, query, location, country) for n in names), return_exceptions=True)
    seen: set[str] = set()
    for name, res in zip(names, results):
        if isinstance(res, BaseException):
            status[name] = f"error: {type(res).__name__}"
            logger.warning("Job source %s failed: %s", name, res)
            continue
        status[name] = f"{len(res)} jobs"
        for j in res:
            dedupe = (j["title"].lower(), j["company"].lower())
            if dedupe in seen or not j["title"]:
                continue
            seen.add(dedupe)
            jobs.append(j)
    if jobs:
        _cache[key] = (now, jobs)
    return jobs, status
