#!/usr/bin/env python3
"""
Scrape listener counts from one or more Icecast status pages and push JSON time series
into the /site/data/ folder of the same Git repo. Then commit and push.

Designed for use on a Raspberry Pi (or any Linux host) via cron every ~15–30 minutes.

Features
- Supports multiple URLs (env LISTENER_URLS, comma-separated)
- Robust HTML parsing for status.xsl (BeautifulSoup) and optional JSON parsing for status-json.xsl
- Writes two files:
  - data_24h.json: last 24 hours for the dashboard
  - data_all.json: full history (compact)
- Keeps a local CSV archive at scraper/history.csv for redundancy
- Auto-creates Git commits and pushes; assumes this repo was cloned with an authenticated remote
"""

import os
import re
import csv
import json
import time
import subprocess
from datetime import datetime, timedelta, timezone
from typing import List, Tuple, Dict, Any
import requests
from bs4 import BeautifulSoup

# --------------------------- Configuration via environment ---------------------------
# REQUIRED: one or more URLs (comma separated). Example:
#   export LISTENER_URLS="https://radio.turtle-music.org/status.xsl,https://sgradio.turtle-music.org/status.xsl"
LISTENER_URLS = [u.strip() for u in os.getenv("LISTENER_URLS", "").split(",") if u.strip()]

# # Optional human-readable labels for the series; must match the number/order of LISTENER_URLS
# #   export LISTENER_LABELS="Tower 1,Tower 2"
LISTENER_LABELS = [s.strip() for s in os.getenv("LISTENER_LABELS", "").split(",") if s.strip()]

# LISTENER_URLS="https://radio.turtle-music.org/status.xsl,https://sgradio.turtle-music.org/status.xsl"
# LISTENER_LABELS="Tower 1,Tower 2" 

# Base path of the repo (this script assumes it lives in <repo>/scraper/)
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITE_DATA_DIR = os.path.join(REPO_ROOT, "data")
HISTORY_CSV = os.path.join(REPO_ROOT, "scraper", "history.csv")

# How far back the 24h view should include (hours)
WINDOW_HOURS = int(os.getenv("WINDOW_HOURS", "24"))

# If set to "1", the script will skip the git commit/push (useful for testing)
SKIP_GIT = os.getenv("SKIP_GIT", "0") == "1"

# --------------------------- Helpers ---------------------------

def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()

def ts_now_ms() -> int:
    return int(time.time() * 1000)

def parse_status_xsl(html: str) -> Dict[str, int]:
    """
    Parse an Icecast status.xsl HTML page and return a dict of mountpoint -> listeners.
    Falls back to a single aggregate if only a total is detectable.
    """
    soup = BeautifulSoup(html, "lxml")

    # Strategy 1: table rows that contain mount and listeners
    results: Dict[str, int] = {}
    try:
        tables = soup.find_all("table")
        for table in tables:
            headers = [th.get_text(strip=True).lower() for th in table.find_all("th")]
            if not headers:
                continue
            # Common headers include: "Mount Point", "Listeners", etc.
            if "listeners" in headers and any("mount" in h for h in headers):
                # determine column indices
                idx_mount = None
                idx_listeners = headers.index("listeners") if "listeners" in headers else None
                for i, h in enumerate(headers):
                    if "mount" in h:
                        idx_mount = i
                        break
                if idx_mount is not None and idx_listeners is not None:
                    for tr in table.find_all("tr"):
                        cells = [td.get_text(strip=True) for td in tr.find_all(["td","th"])]
                        if len(cells) <= max(idx_mount, idx_listeners):
                            continue
                        mount = cells[idx_mount]
                        listeners_str = cells[idx_listeners]
                        if not mount or mount.lower() == "mount point":
                            continue
                        try:
                            listeners = int(re.sub(r"[^0-9]", "", listeners_str))
                            results[mount] = listeners
                        except ValueError:
                            pass
    except Exception:
        pass

    # Strategy 2: look for a "Listeners" total somewhere in the page
    if not results:
        text = soup.get_text(" ", strip=True)
        m = re.search(r"\bListeners?\b[: ]+([0-9]+)", text, re.IGNORECASE)
        if m:
            try:
                results["_total"] = int(m.group(1))
            except ValueError:
                pass

    return results

def parse_status_json(data: Dict[str, Any]) -> Dict[str, int]:
    """
    Parse Icecast status-json.xsl JSON structure.
    """
    results: Dict[str, int] = {}
    try:
        sources = data.get("icestats", {}).get("source", [])
        if isinstance(sources, dict):
            sources = [sources]
        for src in sources:
            mount = src.get("listenurl") or src.get("server_name") or src.get("listenurl", "_unknown")
            listeners = int(src.get("listeners", 0))
            # Normalize mount to just the path if it's a full URL
            if isinstance(mount, str) and "://" in mount:
                try:
                    from urllib.parse import urlparse
                    p = urlparse(mount)
                    mount = p.path or mount
                except Exception:
                    pass
            results[mount] = listeners
    except Exception:
        pass
    return results

def fetch_listeners_for_url(url: str) -> int:
    """
    Return an integer listener count for a given Icecast status URL.
    Tries JSON endpoint first (status-json.xsl), then HTML (status.xsl).
    Aggregates over all mounts if multiple are found.
    """
    session = requests.Session()
    session.headers.update({"User-Agent": "ListenerScraper/1.0 (+https://example.com)"})
    timeout = 15

    # Try JSON endpoint variant automatically
    try_json = None
    if url.endswith("status.xsl"):
        try_json = url.replace("status.xsl", "status-json.xsl")
    elif url.endswith("status-json.xsl"):
        try_json = url

    if try_json:
        try:
            rj = session.get(try_json, timeout=timeout)
            if rj.ok and "application/json" in rj.headers.get("Content-Type", ""):
                data = rj.json()
                mounts = parse_status_json(data)
                if mounts:
                    return sum(mounts.values())
        except Exception:
            pass

    # Fallback: HTML
    try:
        r = session.get(url, timeout=timeout)
        r.raise_for_status()
        mounts = parse_status_xsl(r.text)
        if mounts:
            return sum(mounts.values())
    except Exception as e:
        print(f"[warn] Failed to fetch/parse {url}: {e}")
    return 0

def load_history() -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    if os.path.exists(HISTORY_CSV):
        with open(HISTORY_CSV, "r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                # coerce numbers
                for k in row:
                    if k not in ("timestamp_iso", "timestamp_ms"):
                        try:
                            row[k] = int(row[k])
                        except Exception:
                            pass
                row["timestamp_ms"] = int(row["timestamp_ms"])
                rows.append(row)
    return rows

def save_history(rows: List[Dict[str, Any]], fieldnames: List[str]) -> None:
    with open(HISTORY_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)

def write_json(series_map: Dict[str, List[Tuple[int, int]]]) -> None:
    os.makedirs(SITE_DATA_DIR, exist_ok=True)

    now_iso = iso_now()
    payload = {
        "generated_at": now_iso,
        "series": [
            {"name": name, "points": pts} for name, pts in series_map.items()
        ],
    }

    # data_all.json (full history)
    with open(os.path.join(SITE_DATA_DIR, "data_all.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    # data_24h.json (filter to last WINDOW_HOURS)
    cutoff = int((datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)).timestamp() * 1000)
    clipped = {
        name: [(ts, val) for (ts, val) in pts if ts >= cutoff]
        for name, pts in series_map.items()
    }
    payload_24h = {
        "generated_at": now_iso,
        "series": [
            {"name": name, "points": pts} for name, pts in clipped.items()
        ],
    }
    with open(os.path.join(SITE_DATA_DIR, "data_24h.json"), "w", encoding="utf-8") as f:
        json.dump(payload_24h, f, ensure_ascii=False)

def git_commit_and_push(files: List[str], message: str) -> None:
    try:
        subprocess.run(["git", "-C", REPO_ROOT, "add"] + files, check=True)
        subprocess.run(["git", "-C", REPO_ROOT, "commit", "-m", message], check=True)
        subprocess.run(["git", "-C", REPO_ROOT, "push"], check=True)
    except subprocess.CalledProcessError as e:
        print("[warn] git operation failed:", e)

def main():
    if not LISTENER_URLS:
        raise SystemExit("Please set LISTENER_URLS env var (comma-separated Icecast status URLs).")

    labels = LISTENER_LABELS if LISTENER_LABELS and len(LISTENER_LABELS) == len(LISTENER_URLS) \
             else [f"Stream {i+1}" for i in range(len(LISTENER_URLS))]

    # Fetch counts
    counts: List[int] = []
    for url in LISTENER_URLS:
        count = fetch_listeners_for_url(url)
        counts.append(count)

    # Build record
    ts_ms = ts_now_ms()
    record = {
        "timestamp_iso": iso_now(),
        "timestamp_ms": ts_ms,
    }
    for label, cnt in zip(labels, counts):
        record[label] = int(cnt)
    record["Total"] = int(sum(counts))

    # Update CSV history
    rows = load_history()
    fieldnames = ["timestamp_iso", "timestamp_ms"] + labels + ["Total"]
    rows.append(record)
    save_history(rows, fieldnames)

    # Convert to time-series map for JSON (one series per label + Total)
    series_map: Dict[str, List[Tuple[int, int]]] = {name: [] for name in (labels + ["Total"])}
    for r in rows:
        for name in series_map:
            if name in r:
                try:
                    series_map[name].append((int(r["timestamp_ms"]), int(r[name])))
                except Exception:
                    pass

    write_json(series_map)

    if not SKIP_GIT:
        files_to_commit = [
            os.path.relpath(os.path.join(SITE_DATA_DIR, "data_all.json"), REPO_ROOT),
            os.path.relpath(os.path.join(SITE_DATA_DIR, "data_24h.json"), REPO_ROOT),
            os.path.relpath(HISTORY_CSV, REPO_ROOT),
        ]
        git_commit_and_push(files_to_commit, f"Update listener data @ {record['timestamp_iso']}")

if __name__ == "__main__":
    main()
