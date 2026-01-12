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
import shutil
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

# If set (e.g., 2026), data_all.json will only include rows from that year onward.
ARCHIVE_CUTOFF_YEAR = os.getenv("ARCHIVE_CUTOFF_YEAR")

# If set to "1", write Pi health telemetry to data/pi_health.json on each run.
ENABLE_PI_HEALTH = os.getenv("ENABLE_PI_HEALTH", "0") == "1"

# Paths for archive outputs
ARCHIVE_MONTHLY_DIR = os.path.join(SITE_DATA_DIR, "monthly")
ARCHIVE_YEARLY_DIR = os.path.join(SITE_DATA_DIR, "yearly")

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

def _row_year(row: Dict[str, Any]) -> int:
    try:
        return int(str(row.get("timestamp_iso", ""))[:4])
    except Exception:
        try:
            # Fallback: derive from ms
            ms = int(row.get("timestamp_ms"))
            return datetime.fromtimestamp(ms/1000.0, tz=timezone.utc).year
        except Exception:
            return datetime.now(timezone.utc).year

def build_series_map_from_rows(rows: List[Dict[str, Any]], names: List[str]) -> Dict[str, List[Tuple[int, int]]]:
    series_map: Dict[str, List[Tuple[int, int]]] = {name: [] for name in names}
    for r in rows:
        ts = int(r.get("timestamp_ms"))
        for name in names:
            if name in r:
                try:
                    series_map[name].append((ts, int(r[name])))
                except Exception:
                    pass
    return series_map

def filter_series_map_by_year(series_map: Dict[str, List[Tuple[int, int]]], cutoff_year: int) -> Dict[str, List[Tuple[int, int]]]:
    filtered: Dict[str, List[Tuple[int, int]]] = {k: [] for k in series_map}
    for name, pts in series_map.items():
        for (ts, val) in pts:
            y = datetime.fromtimestamp(ts/1000.0, tz=timezone.utc).year
            if y >= cutoff_year:
                filtered[name].append((ts, val))
    return filtered

def write_pi_health() -> None:
    """Collect basic Pi health telemetry and write to data/pi_health.json."""
    try:
        os.makedirs(SITE_DATA_DIR, exist_ok=True)
        # CPU temperature
        temp_c = None
        try:
            with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
                v = f.read().strip()
                temp_c = round(int(v) / 1000.0, 2)
        except Exception:
            # vcgencmd fallback
            try:
                out = subprocess.check_output(["vcgencmd", "measure_temp"], text=True).strip()
                m = re.search(r"temp=([0-9.]+)", out)
                temp_c = float(m.group(1)) if m else None
            except Exception:
                temp_c = None

        # Disk usage
        du = shutil.disk_usage("/")
        disk_total_gb = round(du.total / (1024**3), 2)
        disk_used_gb = round(du.used / (1024**3), 2)
        disk_free_gb = round(du.free / (1024**3), 2)

        # Memory (parse /proc/meminfo)
        mem_total_mb = mem_available_mb = None
        try:
            with open("/proc/meminfo", "r") as f:
                data = f.read()
            mt = re.search(r"MemTotal:\s+(\d+) kB", data)
            ma = re.search(r"MemAvailable:\s+(\d+) kB", data)
            if mt:
                mem_total_mb = round(int(mt.group(1)) / 1024.0, 1)
            if ma:
                mem_available_mb = round(int(ma.group(1)) / 1024.0, 1)
        except Exception:
            pass

        # CPU load averages
        load1 = load5 = load15 = None
        try:
            load1, load5, load15 = os.getloadavg()
        except Exception:
            pass

        payload = {
            "timestamp_iso": iso_now(),
            "temp_c": temp_c,
            "disk_total_gb": disk_total_gb,
            "disk_used_gb": disk_used_gb,
            "disk_free_gb": disk_free_gb,
            "mem_total_mb": mem_total_mb,
            "mem_available_mb": mem_available_mb,
            "loadavg": {"1": load1, "5": load5, "15": load15},
        }

        with open(os.path.join(SITE_DATA_DIR, "pi_health.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    except Exception as e:
        print("[warn] failed writing pi_health.json:", e)

def write_archive_indexes(years: List[int], months: List[str]) -> None:
    try:
        os.makedirs(SITE_DATA_DIR, exist_ok=True)
        with open(os.path.join(SITE_DATA_DIR, "yearly_index.json"), "w", encoding="utf-8") as f:
            json.dump({"years": sorted(list(set(years)))}, f, ensure_ascii=False)
        with open(os.path.join(SITE_DATA_DIR, "monthly_index.json"), "w", encoding="utf-8") as f:
            json.dump({"months": sorted(list(set(months)))}, f, ensure_ascii=False)
    except Exception as e:
        print("[warn] failed writing archive index:", e)

def write_archives(rows: List[Dict[str, Any]], names: List[str]) -> None:
    """Write monthly and yearly archive JSON payloads under data/monthly and data/yearly."""
    try:
        os.makedirs(ARCHIVE_MONTHLY_DIR, exist_ok=True)
        os.makedirs(ARCHIVE_YEARLY_DIR, exist_ok=True)
    except Exception:
        pass

    by_year: Dict[int, List[Dict[str, Any]]] = {}
    by_month: Dict[str, List[Dict[str, Any]]] = {}
    years: List[int] = []
    months: List[str] = []

    for r in rows:
        y = _row_year(r)
        m = datetime.fromtimestamp(int(r["timestamp_ms"]) / 1000.0, tz=timezone.utc)
        key_month = f"{m.year:04d}-{m.month:02d}"
        by_year.setdefault(y, []).append(r)
        by_month.setdefault(key_month, []).append(r)
        years.append(y)
        months.append(key_month)

    # Yearly
    for y, yr_rows in by_year.items():
        series_map = build_series_map_from_rows(yr_rows, names)
        payload = {
            "generated_at": iso_now(),
            "series": [{"name": n, "points": pts} for n, pts in series_map.items()],
        }
        out = os.path.join(ARCHIVE_YEARLY_DIR, f"{y}.json")
        try:
            with open(out, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except Exception as e:
            print(f"[warn] failed writing yearly archive {out}:", e)

    # Monthly
    for key, mo_rows in by_month.items():
        series_map = build_series_map_from_rows(mo_rows, names)
        payload = {
            "generated_at": iso_now(),
            "series": [{"name": n, "points": pts} for n, pts in series_map.items()],
        }
        out = os.path.join(ARCHIVE_MONTHLY_DIR, f"{key}.json")
        try:
            with open(out, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except Exception as e:
            print(f"[warn] failed writing monthly archive {out}:", e)

    write_archive_indexes(years, months)

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

def write_json(series_map_all: Dict[str, List[Tuple[int, int]]]) -> None:
    os.makedirs(SITE_DATA_DIR, exist_ok=True)

    now_iso = iso_now()

    # Optionally filter for data_all to only include cutoff year and onward
    series_map_for_all = series_map_all
    if ARCHIVE_CUTOFF_YEAR:
        try:
            cutoff_year = int(ARCHIVE_CUTOFF_YEAR)
            series_map_for_all = filter_series_map_by_year(series_map_all, cutoff_year)
        except Exception:
            series_map_for_all = series_map_all

    payload_all = {
        "generated_at": now_iso,
        "series": [
            {"name": name, "points": pts} for name, pts in series_map_for_all.items()
        ],
    }
    with open(os.path.join(SITE_DATA_DIR, "data_all.json"), "w", encoding="utf-8") as f:
        json.dump(payload_all, f, ensure_ascii=False)

    # data_24h.json (filter to last WINDOW_HOURS)
    cutoff_ms = int((datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)).timestamp() * 1000)
    clipped = {
        name: [(ts, val) for (ts, val) in pts if ts >= cutoff_ms]
        for name, pts in series_map_all.items()
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
    names = labels + ["Total"]
    series_map_all = build_series_map_from_rows(rows, names)

    # Write primary JSON outputs
    write_json(series_map_all)

    # Write monthly/yearly archives and indices
    write_archives(rows, names)

    # Optionally write Pi health telemetry
    if ENABLE_PI_HEALTH:
        write_pi_health()

    if not SKIP_GIT:
        files_to_commit = [
            os.path.relpath(os.path.join(SITE_DATA_DIR, "data_all.json"), REPO_ROOT),
            os.path.relpath(os.path.join(SITE_DATA_DIR, "data_24h.json"), REPO_ROOT),
            os.path.relpath(HISTORY_CSV, REPO_ROOT),
            os.path.relpath(os.path.join(SITE_DATA_DIR, "pi_health.json"), REPO_ROOT),
            os.path.relpath(os.path.join(SITE_DATA_DIR, "monthly_index.json"), REPO_ROOT),
            os.path.relpath(os.path.join(SITE_DATA_DIR, "yearly_index.json"), REPO_ROOT),
        ]
        # Include monthly/yearly archive files in commit if present
        try:
            for fname in os.listdir(ARCHIVE_MONTHLY_DIR):
                if fname.endswith('.json'):
                    files_to_commit.append(os.path.relpath(os.path.join(ARCHIVE_MONTHLY_DIR, fname), REPO_ROOT))
        except Exception:
            pass
        try:
            for fname in os.listdir(ARCHIVE_YEARLY_DIR):
                if fname.endswith('.json'):
                    files_to_commit.append(os.path.relpath(os.path.join(ARCHIVE_YEARLY_DIR, fname), REPO_ROOT))
        except Exception:
            pass
        git_commit_and_push(files_to_commit, f"Update listener data @ {record['timestamp_iso']}")

if __name__ == "__main__":
    main()
