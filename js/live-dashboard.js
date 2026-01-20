/**
 * Nopheros Listener Dashboard - Live Dashboard Controller
 *
 * Handles all live page functionality including:
 * - Real-time tower status updates
 * - Tower 1 embedded player with resync
 * - Live chart visualization
 * - Pi health monitoring
 */

const LiveDashboard = {
    // State
    chart: null,
    currentRange: "24h",
    refreshInterval: null,
    nowPlayingInterval: null,

    // DOM element cache
    elements: {},

    /**
     * Initialize the dashboard
     */
    init() {
        this.cacheElements();
        this.setupPlayer();
        this.setupEventListeners();
        this.loadInitialData();
        this.startRefreshLoop();
    },

    /**
     * Cache DOM elements for performance
     */
    cacheElements() {
        this.elements = {
            // Player
            player: document.getElementById("tower1-player"),
            playerSource: document.getElementById("tower1-source"),
            playerReload: document.getElementById("player-reload"),
            tower1NowPlaying: document.getElementById("tower1-now-playing"),

            // Tower cards
            tower1Listeners: document.getElementById("tower1-listeners"),
            tower1Peak: document.getElementById("tower1-peak"),
            tower1Np: document.getElementById("tower1-np"),
            tower2Listeners: document.getElementById("tower2-listeners"),
            tower2Peak: document.getElementById("tower2-peak"),
            tower2Np: document.getElementById("tower2-np"),
            tower3Np: document.getElementById("tower3-np"),
            tower1PlayLink: document.getElementById("tower1-play-link"),
            tower2PlayLink: document.getElementById("tower2-play-link"),
            tower3PlayLink: document.getElementById("tower3-play-link"),
            totalListeners: document.getElementById("total-listeners"),

            // Chart
            chartCanvas: document.getElementById("listeners-chart"),
            refreshChart: document.getElementById("refresh-chart"),
            exportCsv: document.getElementById("export-csv"),
            downloadJson: document.getElementById("download-json"),
            rangeButtons: document.querySelectorAll(".range-btn[data-range]"),

            // Header
            lastUpdated: document.getElementById("last-updated"),

            // Pi health
            piTemp: document.getElementById("pi-temp"),
            piDisk: document.getElementById("pi-disk"),
            piMem: document.getElementById("pi-mem"),
            piLoad: document.getElementById("pi-load"),
            piHealthUpdated: document.getElementById("pi-health-updated"),
            piStatusIndicator: document.getElementById("pi-status-indicator")
        };
    },

    /**
     * Setup the Tower 1 audio player
     */
    setupPlayer() {
        const streamUrl = IcecastAPI.getStreamUrl("tower1");
        if (streamUrl && this.elements.playerSource) {
            this.elements.playerSource.src = streamUrl;
        }

        // Setup tower play links
        const tower1Url = IcecastAPI.getStreamUrl("tower1");
        if (tower1Url && this.elements.tower1PlayLink) {
            this.elements.tower1PlayLink.href = tower1Url;
        }

        const tower2Url = IcecastAPI.getStreamUrl("tower2");
        if (tower2Url && this.elements.tower2PlayLink) {
            this.elements.tower2PlayLink.href = tower2Url;
        }

        const tower3Url = IcecastAPI.getStreamUrl("tower3");
        if (tower3Url && this.elements.tower3PlayLink) {
            this.elements.tower3PlayLink.href = tower3Url;
        }
    },

    /**
     * Force reload/resync the player to live stream
     */
    resyncPlayer() {
        const player = this.elements.player;
        const source = this.elements.playerSource;

        if (!player || !source) return;

        const wasPlaying = !player.paused;
        const streamUrl = IcecastAPI.getStreamUrl("tower1");

        // Add cache-busting parameter
        const bustUrl = `${streamUrl}?_t=${Date.now()}`;

        player.pause();
        source.src = bustUrl;
        player.load();

        if (wasPlaying) {
            player.play().catch(err => {
                console.warn("[Player] Autoplay blocked:", err.message);
            });
        }
    },

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Player reload button
        if (this.elements.playerReload) {
            this.elements.playerReload.addEventListener("click", () => {
                this.resyncPlayer();
            });
        }

        // Chart range buttons
        this.elements.rangeButtons.forEach(btn => {
            btn.addEventListener("click", () => {
                this.elements.rangeButtons.forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                this.currentRange = btn.dataset.range;
                this.loadChartData();
            });
        });

        // Refresh chart button
        if (this.elements.refreshChart) {
            this.elements.refreshChart.addEventListener("click", () => {
                this.loadChartData();
                this.updateTowerStatus();
            });
        }

        // Export CSV
        if (this.elements.exportCsv) {
            this.elements.exportCsv.addEventListener("click", () => {
                this.exportAsCSV();
            });
        }

        // Download JSON
        if (this.elements.downloadJson) {
            this.elements.downloadJson.addEventListener("click", () => {
                this.downloadAsJSON();
            });
        }
    },

    /**
     * Load initial data on page load
     */
    async loadInitialData() {
        await Promise.all([
            this.updateTowerStatus(),
            this.loadChartData(),
            this.updatePiHealth()
        ]);
    },

    /**
     * Start the refresh loop
     */
    startRefreshLoop() {
        // Tower status and chart refresh
        this.refreshInterval = setInterval(() => {
            this.updateTowerStatus();
            this.loadChartData();
            this.updatePiHealth();
        }, CONFIG.LIVE_REFRESH_INTERVAL_MS);

        // Now playing updates (more frequent)
        this.nowPlayingInterval = setInterval(() => {
            this.updateNowPlaying();
        }, CONFIG.NOW_PLAYING_REFRESH_INTERVAL_MS);

        // Initial now playing update
        this.updateNowPlaying();
    },

    /**
     * Update tower status from Icecast
     */
    async updateTowerStatus() {
        try {
            const status = await IcecastAPI.getAllTowerStatus();

            // Update Tower 1
            if (status.towers.tower1) {
                const t1 = status.towers.tower1;
                this.setText(this.elements.tower1Listeners, t1.listeners ?? "--");
                this.setText(this.elements.tower1Peak, t1.listenerPeak ?? "--");
                this.setText(this.elements.tower1Np, t1.title || "(no metadata)");
                this.setText(this.elements.tower1NowPlaying,
                    t1.title ? `Now Playing: ${t1.title}` : "Now Playing: (no metadata)");
            }

            // Update Tower 2
            if (status.towers.tower2) {
                const t2 = status.towers.tower2;
                this.setText(this.elements.tower2Listeners, t2.listeners ?? "--");
                this.setText(this.elements.tower2Peak, t2.listenerPeak ?? "--");
                this.setText(this.elements.tower2Np, t2.title || "(no metadata)");
            }

            // Update Tower 3 (info only - just now playing)
            if (status.towers.tower3) {
                const t3 = status.towers.tower3;
                this.setText(this.elements.tower3Np, t3.title || "(no metadata)");
            }

            // Update Total (Tower 1 + Tower 2 only)
            this.setText(this.elements.totalListeners, status.chartTowersTotal);

            // Update timestamp
            this.updateLastUpdated();

        } catch (error) {
            console.error("[Dashboard] Failed to update tower status:", error);
        }
    },

    /**
     * Update just the now playing info (lightweight update)
     */
    async updateNowPlaying() {
        try {
            const status = await IcecastAPI.fetchStatus();
            if (!status || !status.mounts) return;

            for (const [towerId, tower] of Object.entries(CONFIG.TOWERS)) {
                const mount = status.mounts[tower.mountpoint];
                const title = mount?.title || "(no metadata)";

                switch (towerId) {
                    case "tower1":
                        this.setText(this.elements.tower1Np, title);
                        this.setText(this.elements.tower1NowPlaying,
                            mount?.title ? `Now Playing: ${title}` : "Now Playing: (no metadata)");
                        break;
                    case "tower2":
                        this.setText(this.elements.tower2Np, title);
                        break;
                    case "tower3":
                        this.setText(this.elements.tower3Np, title);
                        break;
                }
            }
        } catch (error) {
            // Silently fail for now playing updates
        }
    },

    /**
     * Load and render chart data
     */
    async loadChartData() {
        try {
            const url = this.currentRange === "24h"
                ? CONFIG.getArchiveUrl("data24h")
                : CONFIG.getArchiveUrl("dataAll");

            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const payload = await response.json();
            this.renderChart(payload);

        } catch (error) {
            console.error("[Dashboard] Failed to load chart data:", error);
        }
    },

    /**
     * Render the listeners chart
     * @param {Object} payload - Chart data payload
     */
    renderChart(payload) {
        if (!this.elements.chartCanvas) return;

        const ctx = this.elements.chartCanvas.getContext("2d");

        // Filter to only Tower 1, Tower 2, and Total (exclude Tower 3)
        const allowedNames = ["Tower 1", "Tower 2", "Total"];
        const filteredSeries = (payload.series || []).filter(s =>
            allowedNames.some(name => s.name.toLowerCase() === name.toLowerCase())
        );

        // Find total series
        const totalSeries = filteredSeries.find(s => s.name.toLowerCase() === "total");
        const otherSeries = filteredSeries.filter(s => s !== totalSeries);

        // Build datasets
        const datasets = [];

        // Add Tower 1 and Tower 2
        for (const series of otherSeries) {
            const tower = Object.values(CONFIG.TOWERS).find(
                t => t.name.toLowerCase() === series.name.toLowerCase()
            );

            datasets.push({
                label: series.name,
                data: (series.points || []).map(([x, y]) => ({ x, y })),
                borderColor: tower?.color || "#888",
                backgroundColor: tower?.color || "#888",
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.2,
                fill: false
            });
        }

        // Add Total as bold line
        if (totalSeries) {
            datasets.push({
                label: "Total",
                data: (totalSeries.points || []).map(([x, y]) => ({ x, y })),
                borderColor: CONFIG.CHART_COLORS.total,
                backgroundColor: CONFIG.CHART_COLORS.total,
                borderWidth: 3,
                pointRadius: 0,
                tension: 0.2,
                fill: false
            });
        }

        // Chart configuration
        const config = {
            type: "line",
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                parsing: false,
                interaction: {
                    mode: "nearest",
                    axis: "x",
                    intersect: false
                },
                scales: {
                    x: {
                        type: "time",
                        time: {
                            unit: this.currentRange === "24h" ? "hour" : "day"
                        },
                        ticks: { color: CONFIG.CHART_COLORS.text },
                        grid: { color: CONFIG.CHART_COLORS.grid }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: { color: CONFIG.CHART_COLORS.text },
                        grid: { color: CONFIG.CHART_COLORS.grid }
                    }
                },
                plugins: {
                    legend: {
                        labels: { color: CONFIG.CHART_COLORS.legend }
                    },
                    tooltip: {
                        mode: "index",
                        intersect: false,
                        callbacks: {
                            title: (items) => {
                                if (items.length > 0) {
                                    return new Date(items[0].parsed.x).toLocaleString();
                                }
                                return "";
                            }
                        }
                    }
                }
            }
        };

        // Destroy existing chart and create new one
        if (this.chart) {
            this.chart.destroy();
        }
        this.chart = new Chart(ctx, config);
    },

    /**
     * Export current chart data as CSV
     */
    async exportAsCSV() {
        try {
            const url = this.currentRange === "24h"
                ? CONFIG.getArchiveUrl("data24h")
                : CONFIG.getArchiveUrl("dataAll");

            const response = await fetch(url, { cache: "no-store" });
            const payload = await response.json();

            // Build timestamp index
            const tsSet = new Set();
            const seriesNames = payload.series.map(s => s.name);
            const seriesMap = {};

            payload.series.forEach(s => {
                seriesMap[s.name] = s.points;
                s.points.forEach(([x]) => tsSet.add(x));
            });

            const timestamps = Array.from(tsSet).sort((a, b) => a - b);

            // Build CSV
            const rows = [];
            rows.push(["timestamp_ms", "timestamp_iso", ...seriesNames]);

            const lookup = {};
            for (const name of seriesNames) {
                lookup[name] = new Map(seriesMap[name]);
            }

            for (const ts of timestamps) {
                const row = [ts, new Date(ts).toISOString()];
                for (const name of seriesNames) {
                    row.push(lookup[name].get(ts) ?? "");
                }
                rows.push(row);
            }

            const csv = rows.map(r => r.join(",")).join("\n");

            // Download
            this.downloadFile(csv, `listeners_${this.currentRange}.csv`, "text/csv");

        } catch (error) {
            alert("Failed to export CSV: " + error.message);
        }
    },

    /**
     * Download current chart data as JSON
     */
    async downloadAsJSON() {
        try {
            const url = this.currentRange === "24h"
                ? CONFIG.getArchiveUrl("data24h")
                : CONFIG.getArchiveUrl("dataAll");

            const response = await fetch(url, { cache: "no-store" });
            const payload = await response.json();

            this.downloadFile(
                JSON.stringify(payload, null, 2),
                `listeners_${this.currentRange}.json`,
                "application/json"
            );

        } catch (error) {
            alert("Failed to download JSON: " + error.message);
        }
    },

    /**
     * Update Pi health display
     */
    async updatePiHealth() {
        try {
            const url = CONFIG.getArchiveUrl("piHealth");
            const response = await fetch(url, { cache: "no-store" });

            if (!response.ok) {
                this.setPiHealthOffline();
                return;
            }

            const data = await response.json();

            this.setText(this.elements.piTemp,
                data.temp_c != null ? `${data.temp_c}°C` : "--");

            this.setText(this.elements.piDisk,
                (data.disk_free_gb != null && data.disk_total_gb != null)
                    ? `${data.disk_free_gb}GB free / ${data.disk_total_gb}GB`
                    : "--");

            this.setText(this.elements.piMem,
                (data.mem_available_mb != null && data.mem_total_mb != null)
                    ? `${data.mem_available_mb}MB free / ${data.mem_total_mb}MB`
                    : "--");

            const loadavg = data.loadavg || {};
            this.setText(this.elements.piLoad,
                (loadavg["1"] != null)
                    ? `${loadavg["1"]} / ${loadavg["5"]} / ${loadavg["15"]}`
                    : "--");

            this.setText(this.elements.piHealthUpdated, data.timestamp_iso || "--");

            // Update status indicator
            if (this.elements.piStatusIndicator) {
                let statusClass = "good";
                if (data.temp_c > 70) statusClass = "critical";
                else if (data.temp_c > 60) statusClass = "warning";

                this.elements.piStatusIndicator.className = `health-indicator ${statusClass}`;
            }

        } catch (error) {
            this.setPiHealthOffline();
        }
    },

    /**
     * Set Pi health display to offline state
     */
    setPiHealthOffline() {
        ["piTemp", "piDisk", "piMem", "piLoad", "piHealthUpdated"].forEach(key => {
            this.setText(this.elements[key], "--");
        });

        if (this.elements.piStatusIndicator) {
            this.elements.piStatusIndicator.className = "health-indicator";
        }
    },

    /**
     * Update the last updated timestamp in header
     */
    updateLastUpdated() {
        const now = new Date();
        this.setText(this.elements.lastUpdated,
            `Updated: ${now.toLocaleTimeString()}`);
    },

    /**
     * Helper: Set text content safely
     * @param {Element|null} element
     * @param {string|number} text
     */
    setText(element, text) {
        if (element) {
            element.textContent = String(text);
        }
    },

    /**
     * Helper: Download a file
     * @param {string} content - File content
     * @param {string} filename - Download filename
     * @param {string} mimeType - MIME type
     */
    downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
};

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    LiveDashboard.init();
});
