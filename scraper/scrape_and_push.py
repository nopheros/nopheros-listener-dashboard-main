#!/usr/bin/env python3
"""
Nopheros Listener Dashboard - Icecast Scraper

Scrapes listener counts from Icecast status pages and pushes JSON time series
into the /data/ folder. Then commits and pushes to GitHub.

Designed for use on a Raspberry Pi via cron every ~15–30 minutes.

Features:
- Scrapes specific mountpoints (Tower 1, Tower 2) for charts/history
- Tower 3 is excluded from all historical data
- Captures per-mount listeners and peak listeners when available
- Writes multiple JSON files:
  - data_24h.json: Last 24 hours
  - data_all.json: Full history
  - Monthly/yearly archives
- Keeps a local CSV backup
- Optional Pi health telemetry

Configuration via environment variables:
    ICECAST_BASE_URL    - Base URL of Icecast server (e.g., http://***REMOVED***:8000)
    LISTENER_LABELS     - Optional comma-separated labels (default: Tower 1,Tower 2)
    WINDOW_HOURS        - Hours for 24h view (default: 24)
    SKIP_GIT            - Set to "1" to skip git commit/push
    ARCHIVE_CUTOFF_YEAR - Filter data_all.json to this year and later
    ENABLE_PI_HEALTH    - Set to "1" to write Pi health telemetry
"""

import os
import re
import csv
import json
import time
import subprocess
from datetime import datetime, timedelta, timezone
import shutil
from typing import List, Tuple, Dict, Any, Optional
import requests

# Try to import BeautifulSoup for HTML fallback parsing
try:
    from bs4 import BeautifulSoup
    HAS_BS4 = True
except ImportError:
    HAS_BS4 = False
    print("[info] BeautifulSoup not available, JSON-only mode")

# --------------------------- Configuration ---------------------------

# Icecast server base URL
ICECAST_BASE_URL = os.getenv("ICECAST_BASE_URL", "http://***REMOVED***:8000")

# Mountpoints to track (Tower 1 and Tower 2 ONLY - Tower 3 excluded from history)
TRACKED_MOUNTPOINTS = {
    "tower1": {
        "mountpoint": "/tower1",
        "label": "Tower 1",
        "include_in_charts": True,
        "include_in_history": True
    },
    "tower2": {
        "mountpoint": "/tower2",
        "label": "Tower 2",
        "include_in_charts": True,
        "include_in_history": True
    }
    # Tower 3 intentionally excluded - INFO ONLY, no history
}

# Labels for output (override with env if needed)
_default_labels = ",".join(cfg["label"] for cfg in TRACKED_MOUNTPOINTS.values())
LISTENER_LABELS = [s.strip() for s in os.getenv("LISTENER_LABELS", _default_labels).split(",") if s.strip()]

# Base path of the repo
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITE_DATA_DIR = os.path.join(REPO_ROOT, "data")
HISTORY_CSV = os.path.join(REPO_ROOT, "scraper", "history.csv")

# Time window for 24h view
WINDOW_HOURS = int(os.getenv("WINDOW_HOURS", "24"))

# Git options
SKIP_GIT = os.getenv("SKIP_GIT", "0") == "1"

# Archive cutoff year (filter data_all to only include this year and later)
ARCHIVE_CUTOFF_YEAR = os.getenv("ARCHIVE_CUTOFF_YEAR")

# Pi health telemetry
ENABLE_PI_HEALTH = os.getenv("ENABLE_PI_HEALTH", "0") == "1"

# Archive directories
ARCHIVE_MONTHLY_DIR = os.path.join(SITE_DATA_DIR, "monthly")
ARCHIVE_YEARLY_DIR = os.path.join(SITE_DATA_DIR, "yearly")

# --------------------------- Helpers ---------------------------

def iso_now() -> str:
    """Get current time as ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()

def ts_now_ms() -> int:
    """Get current time as Unix timestamp in milliseconds."""
    return int(time.time() * 1000)

def safe_int(value: Any, default: Optional[int] = None) -> Optional[int]:
    """Safely parse an integer."""
    if value is None:
        return default
    try:
        return int(value)
    except (ValueError, TypeError):
        return default

# --------------------------- Icecast Parsing ---------------------------

def fetch_icecast_status_json() -> Optional[Dict[str, Any]]:
    """
    Fetch and parse Icecast status-json.xsl endpoint.
    Returns dict with per-mount data or None on failure.
    """
    url = f"{ICECAST_BASE_URL}/status-json.xsl"

    try:
        response = requests.get(
            url,
            timeout=15,
            headers={"User-Agent": "NopherosListenerScraper/2.0"}
        )
        response.raise_for_status()

        # Check content type
        content_type = response.headers.get("Content-Type", "")
        if "json" not in content_type.lower():
            print(f"[warn] Unexpected content type: {content_type}")
            # Try parsing anyway

        data = response.json()
        return parse_icecast_json(data)

    except requests.RequestException as e:
        print(f"[warn] Failed to fetch Icecast JSON status: {e}")
        return None
    except json.JSONDecodeError as e:
        print(f"[warn] Failed to parse Icecast JSON: {e}")
        return None

def parse_icecast_json(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Parse Icecast status-json.xsl response.

    Handles varying Icecast configurations where source may be:
    - A single object
    - An array of objects
    - Missing entirely

    Returns dict with:
        mounts: {mountpoint: {listeners, peak, title, ...}}
    """
    result = {
        "mounts": {},
        "fetched_at": iso_now()
    }

    try:
        icestats = data.get("icestats", {})
        sources = icestats.get("source")

        if sources is None:
            return result

        # Normalize to list
        if isinstance(sources, dict):
            sources = [sources]
        elif not isinstance(sources, list):
            return result

        for source in sources:
            mount_info = parse_mount_source(source)
            if mount_info and mount_info.get("mountpoint"):
                result["mounts"][mount_info["mountpoint"]] = mount_info

    except Exception as e:
        print(f"[warn] Error parsing Icecast status: {e}")

    return result

def parse_mount_source(source: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Parse a single mount source object from Icecast.

    Extracts:
    - mountpoint (path only, e.g., /tower1)
    - listeners (current count)
    - listener_peak (peak count, may not exist in all configs)
    - title (now playing metadata)
    """
    if not source or not isinstance(source, dict):
        return None

    try:
        # Extract mountpoint from listenurl
        mountpoint = None
        listenurl = source.get("listenurl")

        if listenurl:
            # listenurl is typically "http://host:port/mountpoint"
            try:
                from urllib.parse import urlparse
                parsed = urlparse(listenurl)
                mountpoint = parsed.path
            except Exception:
                # Fallback: extract path manually
                match = re.search(r"(/[^/]+)$", listenurl)
                if match:
                    mountpoint = match.group(1)

        if not mountpoint:
            mountpoint = source.get("mount")

        if not mountpoint:
            return None

        return {
            "mountpoint": mountpoint,
            "listeners": safe_int(source.get("listeners"), 0),
            "listener_peak": safe_int(source.get("listener_peak")),
            "title": source.get("title") or source.get("yp_currently_playing"),
            "description": source.get("server_description"),
            "bitrate": safe_int(source.get("bitrate")),
            "genre": source.get("genre"),
            "stream_start": source.get("stream_start_iso8601"),
            "connected": safe_int(source.get("connected"))
        }

    except Exception as e:
        print(f"[warn] Error parsing mount source: {e}")
        return None

def fetch_icecast_status_html() -> Optional[Dict[str, Any]]:
    """
    Fallback: Fetch and parse Icecast status.xsl HTML page.
    Less reliable than JSON but works as backup.
    """
    if not HAS_BS4:
        return None

    url = f"{ICECAST_BASE_URL}/status.xsl"

    try:
        response = requests.get(
            url,
            timeout=15,
            headers={"User-Agent": "NopherosListenerScraper/2.0"}
        )
        response.raise_for_status()

        return parse_icecast_html(response.text)

    except requests.RequestException as e:
        print(f"[warn] Failed to fetch Icecast HTML status: {e}")
        return None

def parse_icecast_html(html: str) -> Dict[str, Any]:
    """
    Parse Icecast status.xsl HTML page.
    Returns similar structure to JSON parser.
    """
    result = {
        "mounts": {},
        "fetched_at": iso_now()
    }

    if not HAS_BS4:
        return result

    try:
        soup = BeautifulSoup(html, "lxml")

        # Look for tables with mount/listeners info
        tables = soup.find_all("table")
        for table in tables:
            headers = [th.get_text(strip=True).lower() for th in table.find_all("th")]

            if not headers:
                continue

            # Find relevant column indices
            idx_mount = None
            idx_listeners = None
            idx_peak = None

            for i, h in enumerate(headers):
                if "mount" in h:
                    idx_mount = i
                elif h == "listeners":
                    idx_listeners = i
                elif "peak" in h:
                    idx_peak = i

            if idx_mount is None or idx_listeners is None:
                continue

            # Parse rows
            for tr in table.find_all("tr"):
                cells = [td.get_text(strip=True) for td in tr.find_all(["td", "th"])]

                if len(cells) <= max(idx_mount, idx_listeners):
                    continue

                mount = cells[idx_mount]
                if not mount or mount.lower() == "mount point":
                    continue

                # Ensure mount starts with /
                if not mount.startswith("/"):
                    mount = "/" + mount

                listeners_str = cells[idx_listeners]
                listeners = safe_int(re.sub(r"[^0-9]", "", listeners_str), 0)

                peak = None
                if idx_peak is not None and len(cells) > idx_peak:
                    peak = safe_int(re.sub(r"[^0-9]", "", cells[idx_peak]))

                result["mounts"][mount] = {
                    "mountpoint": mount,
                    "listeners": listeners,
                    "listener_peak": peak,
                    "title": None
                }

    except Exception as e:
        print(f"[warn] Error parsing Icecast HTML: {e}")

    return result

def fetch_listener_data() -> Dict[str, Any]:
    """
    Fetch listener data from Icecast.
    Tries JSON first, falls back to HTML.

    Returns dict with:
        mounts: {mountpoint: {listeners, peak, ...}}
        towers: {tower_id: {label, listeners, peak, ...}} (only tracked towers)
        total: combined listeners for tracked towers
    """
    # Try JSON first
    status = fetch_icecast_status_json()

    # Fallback to HTML
    if not status or not status.get("mounts"):
        status = fetch_icecast_status_html()

    if not status:
        status = {"mounts": {}, "fetched_at": iso_now()}

    # Map to tracked towers
    result = {
        "mounts": status.get("mounts", {}),
        "towers": {},
        "total": 0,
        "fetched_at": status.get("fetched_at", iso_now())
    }

    for tower_id, config in TRACKED_MOUNTPOINTS.items():
        mountpoint = config["mountpoint"]
        mount_data = status.get("mounts", {}).get(mountpoint, {})

        listeners = mount_data.get("listeners", 0)
        peak = mount_data.get("listener_peak")

        result["towers"][tower_id] = {
            "id": tower_id,
            "label": config["label"],
            "mountpoint": mountpoint,
            "listeners": listeners,
            "listener_peak": peak,
            "title": mount_data.get("title"),
            "include_in_charts": config["include_in_charts"],
            "include_in_history": config["include_in_history"]
        }

        # Only count toward total if included in charts
        if config["include_in_charts"]:
            result["total"] += listeners

    return result

# --------------------------- Data Storage ---------------------------

def load_history() -> List[Dict[str, Any]]:
    """Load historical data from CSV."""
    rows: List[Dict[str, Any]] = []

    if not os.path.exists(HISTORY_CSV):
        return rows

    try:
        with open(HISTORY_CSV, "r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                # Coerce numeric fields
                for k in row:
                    if k not in ("timestamp_iso", "timestamp_ms"):
                        try:
                            row[k] = int(row[k])
                        except (ValueError, TypeError):
                            pass
                row["timestamp_ms"] = int(row["timestamp_ms"])
                rows.append(row)
    except Exception as e:
        print(f"[warn] Failed to load history: {e}")

    return rows

def save_history(rows: List[Dict[str, Any]], fieldnames: List[str]) -> None:
    """Save historical data to CSV."""
    try:
        with open(HISTORY_CSV, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for row in rows:
                writer.writerow(row)
    except Exception as e:
        print(f"[error] Failed to save history: {e}")

def build_series_map(rows: List[Dict[str, Any]], names: List[str]) -> Dict[str, List[Tuple[int, int]]]:
    """Build time series map from rows."""
    series_map: Dict[str, List[Tuple[int, int]]] = {name: [] for name in names}

    for row in rows:
        ts = int(row.get("timestamp_ms", 0))
        for name in names:
            if name in row:
                try:
                    series_map[name].append((ts, int(row[name])))
                except (ValueError, TypeError):
                    pass

    return series_map

def filter_series_by_year(series_map: Dict[str, List[Tuple[int, int]]], cutoff_year: int) -> Dict[str, List[Tuple[int, int]]]:
    """Filter series to only include data from cutoff year and later."""
    filtered: Dict[str, List[Tuple[int, int]]] = {k: [] for k in series_map}

    for name, pts in series_map.items():
        for (ts, val) in pts:
            year = datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc).year
            if year >= cutoff_year:
                filtered[name].append((ts, val))

    return filtered

def write_json_outputs(series_map: Dict[str, List[Tuple[int, int]]]) -> None:
    """Write data_24h.json and data_all.json."""
    os.makedirs(SITE_DATA_DIR, exist_ok=True)
    now_iso = iso_now()

    # Optionally filter for data_all
    series_map_for_all = series_map
    if ARCHIVE_CUTOFF_YEAR:
        try:
            cutoff = int(ARCHIVE_CUTOFF_YEAR)
            series_map_for_all = filter_series_by_year(series_map, cutoff)
        except ValueError:
            pass

    # data_all.json
    payload_all = {
        "generated_at": now_iso,
        "series": [{"name": name, "points": pts} for name, pts in series_map_for_all.items()]
    }
    with open(os.path.join(SITE_DATA_DIR, "data_all.json"), "w", encoding="utf-8") as f:
        json.dump(payload_all, f, ensure_ascii=False)

    # data_24h.json
    cutoff_ms = int((datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)).timestamp() * 1000)
    clipped = {
        name: [(ts, val) for (ts, val) in pts if ts >= cutoff_ms]
        for name, pts in series_map.items()
    }
    payload_24h = {
        "generated_at": now_iso,
        "series": [{"name": name, "points": pts} for name, pts in clipped.items()]
    }
    with open(os.path.join(SITE_DATA_DIR, "data_24h.json"), "w", encoding="utf-8") as f:
        json.dump(payload_24h, f, ensure_ascii=False)

def row_year(row: Dict[str, Any]) -> int:
    """Get year from a history row."""
    try:
        return int(str(row.get("timestamp_iso", ""))[:4])
    except (ValueError, TypeError):
        try:
            ms = int(row.get("timestamp_ms", 0))
            return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).year
        except:
            return datetime.now(timezone.utc).year

def write_archives(rows: List[Dict[str, Any]], names: List[str]) -> None:
    """Write monthly and yearly archive files."""
    os.makedirs(ARCHIVE_MONTHLY_DIR, exist_ok=True)
    os.makedirs(ARCHIVE_YEARLY_DIR, exist_ok=True)

    by_year: Dict[int, List[Dict[str, Any]]] = {}
    by_month: Dict[str, List[Dict[str, Any]]] = {}
    years_set = set()
    months_set = set()

    for row in rows:
        year = row_year(row)
        ts_ms = int(row.get("timestamp_ms", 0))
        dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc)
        month_key = f"{dt.year:04d}-{dt.month:02d}"

        by_year.setdefault(year, []).append(row)
        by_month.setdefault(month_key, []).append(row)
        years_set.add(year)
        months_set.add(month_key)

    now_iso = iso_now()

    # Write yearly archives
    for year, year_rows in by_year.items():
        series_map = build_series_map(year_rows, names)
        payload = {
            "generated_at": now_iso,
            "series": [{"name": n, "points": pts} for n, pts in series_map.items()]
        }
        try:
            with open(os.path.join(ARCHIVE_YEARLY_DIR, f"{year}.json"), "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except Exception as e:
            print(f"[warn] Failed to write yearly archive {year}: {e}")

    # Write monthly archives
    for month_key, month_rows in by_month.items():
        series_map = build_series_map(month_rows, names)
        payload = {
            "generated_at": now_iso,
            "series": [{"name": n, "points": pts} for n, pts in series_map.items()]
        }
        try:
            with open(os.path.join(ARCHIVE_MONTHLY_DIR, f"{month_key}.json"), "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except Exception as e:
            print(f"[warn] Failed to write monthly archive {month_key}: {e}")

    # Write indexes
    try:
        with open(os.path.join(SITE_DATA_DIR, "yearly_index.json"), "w", encoding="utf-8") as f:
            json.dump({"years": sorted(list(years_set))}, f, ensure_ascii=False)
        with open(os.path.join(SITE_DATA_DIR, "monthly_index.json"), "w", encoding="utf-8") as f:
            json.dump({"months": sorted(list(months_set))}, f, ensure_ascii=False)
    except Exception as e:
        print(f"[warn] Failed to write archive indexes: {e}")

def write_pi_health() -> None:
    """Collect and write Pi health telemetry."""
    os.makedirs(SITE_DATA_DIR, exist_ok=True)

    payload = {
        "timestamp_iso": iso_now(),
        "temp_c": None,
        "disk_total_gb": None,
        "disk_used_gb": None,
        "disk_free_gb": None,
        "mem_total_mb": None,
        "mem_available_mb": None,
        "loadavg": {"1": None, "5": None, "15": None}
    }

    try:
        # Temperature
        try:
            with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
                payload["temp_c"] = round(int(f.read().strip()) / 1000.0, 2)
        except Exception:
            try:
                out = subprocess.check_output(["vcgencmd", "measure_temp"], text=True).strip()
                match = re.search(r"temp=([0-9.]+)", out)
                if match:
                    payload["temp_c"] = float(match.group(1))
            except Exception:
                pass

        # Disk
        try:
            du = shutil.disk_usage("/")
            payload["disk_total_gb"] = round(du.total / (1024**3), 2)
            payload["disk_used_gb"] = round(du.used / (1024**3), 2)
            payload["disk_free_gb"] = round(du.free / (1024**3), 2)
        except Exception:
            pass

        # Memory
        try:
            with open("/proc/meminfo", "r") as f:
                data = f.read()
            mt = re.search(r"MemTotal:\s+(\d+) kB", data)
            ma = re.search(r"MemAvailable:\s+(\d+) kB", data)
            if mt:
                payload["mem_total_mb"] = round(int(mt.group(1)) / 1024.0, 1)
            if ma:
                payload["mem_available_mb"] = round(int(ma.group(1)) / 1024.0, 1)
        except Exception:
            pass

        # Load averages
        try:
            load1, load5, load15 = os.getloadavg()
            payload["loadavg"] = {
                "1": round(load1, 2),
                "5": round(load5, 2),
                "15": round(load15, 2)
            }
        except Exception:
            pass

        with open(os.path.join(SITE_DATA_DIR, "pi_health.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)

    except Exception as e:
        print(f"[warn] Failed to write pi_health.json: {e}")

def git_commit_and_push(files: List[str], message: str) -> None:
    """Commit and push changes to git."""
    try:
        subprocess.run(["git", "-C", REPO_ROOT, "add"] + files, check=True)
        subprocess.run(["git", "-C", REPO_ROOT, "commit", "-m", message], check=True)
        subprocess.run(["git", "-C", REPO_ROOT, "push"], check=True)
    except subprocess.CalledProcessError as e:
        print(f"[warn] Git operation failed: {e}")

# --------------------------- Main ---------------------------

def main():
    print(f"[{iso_now()}] Starting scrape...")

    # Fetch current listener data
    data = fetch_listener_data()

    print(f"[info] Fetched: {data['total']} total listeners")
    for tower_id, tower in data["towers"].items():
        print(f"  {tower['label']}: {tower['listeners']} (peak: {tower['listener_peak']})")

    # Build record for history
    ts_ms = ts_now_ms()
    record = {
        "timestamp_iso": iso_now(),
        "timestamp_ms": ts_ms
    }

    # Add listener counts (only tracked towers)
    for tower_id, tower in data["towers"].items():
        if tower["include_in_history"]:
            record[tower["label"]] = tower["listeners"]

    record["Total"] = data["total"]

    # Load existing history and append
    rows = load_history()
    names = [t["label"] for t in data["towers"].values() if t["include_in_history"]] + ["Total"]
    fieldnames = ["timestamp_iso", "timestamp_ms"] + names

    rows.append(record)
    save_history(rows, fieldnames)

    # Build series map and write outputs
    series_map = build_series_map(rows, names)
    write_json_outputs(series_map)
    write_archives(rows, names)

    # Pi health
    if ENABLE_PI_HEALTH:
        write_pi_health()

    # Git commit/push
    if not SKIP_GIT:
        files_to_commit = [
            os.path.relpath(os.path.join(SITE_DATA_DIR, "data_all.json"), REPO_ROOT),
            os.path.relpath(os.path.join(SITE_DATA_DIR, "data_24h.json"), REPO_ROOT),
            os.path.relpath(HISTORY_CSV, REPO_ROOT),
            os.path.relpath(os.path.join(SITE_DATA_DIR, "monthly_index.json"), REPO_ROOT),
            os.path.relpath(os.path.join(SITE_DATA_DIR, "yearly_index.json"), REPO_ROOT),
        ]

        if ENABLE_PI_HEALTH:
            files_to_commit.append(
                os.path.relpath(os.path.join(SITE_DATA_DIR, "pi_health.json"), REPO_ROOT)
            )

        # Add archive files
        try:
            for fname in os.listdir(ARCHIVE_MONTHLY_DIR):
                if fname.endswith('.json'):
                    files_to_commit.append(
                        os.path.relpath(os.path.join(ARCHIVE_MONTHLY_DIR, fname), REPO_ROOT)
                    )
        except Exception:
            pass

        try:
            for fname in os.listdir(ARCHIVE_YEARLY_DIR):
                if fname.endswith('.json'):
                    files_to_commit.append(
                        os.path.relpath(os.path.join(ARCHIVE_YEARLY_DIR, fname), REPO_ROOT)
                    )
        except Exception:
            pass

        git_commit_and_push(files_to_commit, f"Update listener data @ {record['timestamp_iso']}")

    print(f"[{iso_now()}] Scrape complete!")

if __name__ == "__main__":
    main()
