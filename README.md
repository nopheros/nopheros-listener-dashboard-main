<<<<<<< HEAD
# Listener Dashboard (Icecast)

A tiny, free-to-host listener-count dashboard. Scrape one or more Icecast `status.xsl` pages every ~15–30 minutes,
commit JSON timeseries into this repo, and render a static Chart.js dashboard on GitHub Pages.

## How it works

- **scraper/**: Python script `scrape_and_push.py` runs on a Raspberry Pi (or any always-on machine).
  It fetches each URL, parses the current listener count, appends to a CSV history, and writes two JSON files:
    - `site/data/data_24h.json` — only the last 24 hours
    - `site/data/data_all.json` — the entire history
  Then it commits and pushes these to your GitHub repo.

- **site/**: A static site (Chart.js) that visualizes the JSON. Host this on GitHub Pages (Settings → Pages →
  deploy from `main` branch / `site` folder). The site auto-refreshes every 60 seconds.

## Quick start

1. **Create a new, private GitHub repo** (or public if you like). Clone it onto your Pi:
   ```bash
   git clone https://github.com/<you>/listener-dashboard.git
   cd listener-dashboard
   ```

2. Copy this folder's contents into the repo root so paths match:
   ```bash
   # If you're reading this README locally, ensure the structure is:
   scraper/
   site/
   README.md
   ```

3. **Install Python deps** on the Pi:
   ```bash
   sudo apt-get update && sudo apt-get install -y python3-pip
   pip3 install -r scraper/requirements.txt
   ```

4. **Set environment variables** (edit `~/.bashrc` or export inline in cron):
   ```bash
   export LISTENER_URLS="https://radio.turtle-music.org/status.xsl,https://sgradio.turtle-music.org/status.xsl"
   export LISTENER_LABELS="Tower 1,Tower 2"
   # Optional: export WINDOW_HOURS=24
   ```

5. **Test run**:
   ```bash
   python3 scraper/scrape_and_push.py
   ```
   You should see `site/data/data_*.json` update and a `scraper/history.csv` appear. Commit/push happens automatically.

6. **Schedule with cron (every 30 min)**:
   ```bash
   crontab -e
   # Add a line like (adjust paths):
   */30 * * * * LISTENER_URLS="https://radio.turtle-music.org/status.xsl,https://sgradio.turtle-music.org/status.xsl" LISTENER_LABELS="Tower 1,Tower 2" /usr/bin/python3 /home/pi/listener-dashboard/scraper/scrape_and_push.py >> /home/pi/listener-dashboard/scraper/cron.log 2>&1
   ```

7. **Enable GitHub Pages**:
   - On GitHub: Settings → Pages → Build and deployment
   - Source: **Deploy from a branch**
   - Branch: `main` (or your default) / Folder: `/site`
   - Save. Your site will publish at `https://<you>.github.io/<repo>/`

## Authentication notes

The script simply calls `git add/commit/push` in the repo. You have options:

- **SSH keys (recommended)**: Set up SSH on the Pi and clone via `git@github.com:<you>/<repo>.git`.
- **HTTPS + PAT**: Clone using `https://<TOKEN>@github.com/<you>/<repo>.git` (token must have `repo` scope).
- **Skip pushes**: For testing, set `SKIP_GIT=1` to skip commit/push.

## Customization

- Add/remove streams by changing `LISTENER_URLS` and matching `LISTENER_LABELS`.
- Change the 24h window via `WINDOW_HOURS` env var.
- Tweak the look in `site/index.html` (pure static—no build step).

## Local development

You can open `site/index.html` directly in a browser, but some browsers restrict `file://` fetches.
Serving with a tiny HTTP server avoids that:
```bash
cd site
python3 -m http.server 8000
# then open http://localhost:8000
```

## Troubleshooting

- **No data on the chart?** Ensure `scraper/scrape_and_push.py` has run at least once and the JSON files exist.
- **CORS?** Not an issue here—data is served from the same origin (GitHub Pages).
- **status-json.xsl missing?** The scraper falls back to parsing HTML `status.xsl`.
- **Multiple mounts** on one Icecast? The script sums listeners across mounts.
- **Time is wrong**? The scraper timestamps in UTC (ms). Chart uses browser-local time display.

---
Made with ❤️ for simple radio dashboards.
=======
# nopheros-listener-dashboard-main
>>>>>>> 07c34ff (Initial commit)
