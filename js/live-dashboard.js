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
    currentPlayerTower: "tower1",

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
            playerNowPlaying: document.getElementById("player-now-playing"),
            playerSelect: document.getElementById("player-stream-select"),
            playerPopupWindow: document.getElementById("player-popup-window"),
            playerPopupModal: document.getElementById("player-popup-modal"),

            // Tower cards
            tower1Listeners: document.getElementById("tower1-listeners"),
            tower1Peak: document.getElementById("tower1-peak"),
            tower1Np: document.getElementById("tower1-np"),
            tower2Listeners: document.getElementById("tower2-listeners"),
            tower2Peak: document.getElementById("tower2-peak"),
            tower2Np: document.getElementById("tower2-np"),
            tower3Listeners: document.getElementById("tower3-listeners"),
            tower3Peak: document.getElementById("tower3-peak"),
            tower3Np: document.getElementById("tower3-np"),
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
        this.setPlayerSource(this.currentPlayerTower);

        // Hook tower selector
        if (this.elements.playerSelect) {
            this.elements.playerSelect.value = this.currentPlayerTower;
            this.elements.playerSelect.addEventListener("change", (e) => {
                const nextTower = e.target.value || "tower1";
                this.setPlayerSource(nextTower);
                this.updateNowPlaying();
            });
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
        const streamUrl = IcecastAPI.getStreamUrl(this.currentPlayerTower);

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
     * Set player stream by tower ID
     * @param {string} towerId
     */
    setPlayerSource(towerId) {
        const player = this.elements.player;
        const source = this.elements.playerSource;
        if (!player || !source) return;

        const streamUrl = IcecastAPI.getStreamUrl(towerId);
        if (!streamUrl) return;

        const wasPlaying = !player.paused;
        player.pause();
        source.src = streamUrl;
        player.load();

        this.currentPlayerTower = towerId;

        if (wasPlaying) {
            player.play().catch(() => {});
        }
    },

    /**
     * Play Tower 3 stream
     */
    playTower3() {
        const streamUrl = CONFIG.getStreamUrl("tower3");
        if (!streamUrl) {
            console.error("[Dashboard] Failed to get Tower 3 stream URL");
            return;
        }

        // Switch player to Tower 3
        this.setPlayerSource("tower3");

        // Start playing
        const player = this.elements.player;
        if (player) {
            player.play().catch(error => {
                console.error("[Dashboard] Failed to play Tower 3:", error);
            });
        }

        // Update the player selector dropdown
        if (this.elements.playerSelect) {
            this.elements.playerSelect.value = "tower3";
        }
    },

    /**
     * Open the current stream in a new browser window
     */
    openPlayerWindow() {
        const streamUrl = CONFIG.getStreamUrl(this.currentPlayerTower);
        if (!streamUrl) return;

        window.open(streamUrl, "elbc_player", "width=500,height=300,noopener,noreferrer");
    },

    /**
     * Open a modal overlay player window
     */
    openPlayerModal() {
        const streamUrl = CONFIG.getStreamUrl(this.currentPlayerTower);
        if (!streamUrl) return;

        const towerId = this.currentPlayerTower;
        const tower = CONFIG.TOWERS[towerId];
        const towerName = tower?.name || "Unknown Tower";

        // Create modal HTML
        const modalHTML = `
            <div id="player-modal-overlay" class="modal-overlay">
                <div class="modal-player">
                    <div class="modal-header">
                        <h3>${towerName} - Pop-out Player</h3>
                        <button class="modal-close" id="modal-close-btn" title="Close">✕</button>
                    </div>
                    <div class="modal-body">
                        <audio controls autoplay style="width: 100%;">
                            <source src="${streamUrl}" type="audio/mpeg">
                            Your browser does not support the audio element.
                        </audio>
                        <div class="modal-info">
                            <p><strong>Now Playing:</strong> <span id="modal-np">(loading...)</span></p>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Remove any existing modal
        const existingModal = document.getElementById("player-modal-overlay");
        if (existingModal) existingModal.remove();

        // Add modal to DOM
        document.body.insertAdjacentHTML("beforeend", modalHTML);

        // Get close button and add listener
        const closeBtn = document.getElementById("modal-close-btn");
        const overlay = document.getElementById("player-modal-overlay");

        closeBtn?.addEventListener("click", () => overlay.remove());
        overlay?.addEventListener("click", (e) => {
            if (e.target === overlay) overlay.remove();
        });

        // Update now playing
        this.updateModalNowPlaying(towerId);
        this.modalNowPlayingInterval = setInterval(() => {
            this.updateModalNowPlaying(towerId);
        }, CONFIG.NOW_PLAYING_REFRESH_INTERVAL_MS);
    },

    /**
     * Update now playing text in modal
     */
    async updateModalNowPlaying(towerId) {
        const npElement = document.getElementById("modal-np");
        if (!npElement) return;

        try {
            const status = await IcecastAPI.getAllTowerStatus();
            const towerStatus = status.towers[towerId];
            const title = towerStatus?.title || "(no metadata)";
            this.setText(npElement, title);
        } catch (error) {
            console.error("[Dashboard] Failed to update modal now playing:", error);
        }
    },

    /**
     * Close any open modal player
     */
    closePlayerModal() {
        const modal = document.getElementById("player-modal-overlay");
        if (modal) modal.remove();
        if (this.modalNowPlayingInterval) {
            clearInterval(this.modalNowPlayingInterval);
        }
    },

    /**
     * Set active state on range buttons
     */
    setRangeButtonActive(range) {
        this.elements.rangeButtons.forEach(b => {
            if (b.dataset.range === range) {
                b.classList.add("active");
            } else {
                b.classList.remove("active");
            }
        });
        this.currentRange = range;
    },

    /**
     * Update now playing label for the selected tower
     */
    updatePlayerNowPlayingFromStatus(towers) {
        const current = towers?.[this.currentPlayerTower];
        const title = current?.title || "(no metadata)";
        this.setPlayerNowPlaying(title);
    },

    /**
     * Set the player now playing text
     */
    setPlayerNowPlaying(title) {
        if (!this.elements.playerNowPlaying) return;
        this.setText(
            this.elements.playerNowPlaying,
            title ? `Now Playing: ${title}` : "Now Playing: (no metadata)"
        );
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

        // Pop-out player - new window
        if (this.elements.playerPopupWindow) {
            this.elements.playerPopupWindow.addEventListener("click", () => {
                this.openPlayerWindow();
            });
        }

        // Pop-out player - modal overlay
        if (this.elements.playerPopupModal) {
            this.elements.playerPopupModal.addEventListener("click", () => {
                this.openPlayerModal();
            });
        }

        // Tower 3 play button
        const tower3PlayBtn = document.getElementById("tower3-play-btn");
        if (tower3PlayBtn) {
            tower3PlayBtn.addEventListener("click", (e) => {
                e.preventDefault();
                console.log("[Dashboard] Tower 3 play button clicked");
                this.playTower3();
            });
        } else {
            console.warn("[Dashboard] Tower 3 play button not found");
        }

        // Chart range buttons
        this.elements.rangeButtons.forEach(btn => {
            btn.addEventListener("click", () => {
                this.setRangeButtonActive(btn.dataset.range);
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

        // Theme toggle
        // Download JSON
        if (this.elements.downloadJson) {
            this.elements.downloadJson.addEventListener("click", () => {
                this.downloadAsJSON();
            });
        }

        // Theme toggle
        const themeToggle = document.getElementById("theme-toggle");
        if (themeToggle) {
            const savedTheme = localStorage.getItem("theme") || "dark";
            document.documentElement.setAttribute("data-theme", savedTheme);
            this.updateThemeIcon(savedTheme);

            themeToggle.addEventListener("click", () => {
                const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
                const newTheme = currentTheme === "dark" ? "light" : "dark";
                document.documentElement.setAttribute("data-theme", newTheme);
                localStorage.setItem("theme", newTheme);
                this.updateThemeIcon(newTheme);
            });
        }
    },

    /**
     * Update theme toggle icon based on current theme
     */
    updateThemeIcon(theme) {
        const themeIcon = document.querySelector(".theme-icon");
        if (themeIcon) {
            themeIcon.textContent = theme === "dark" ? "🌙" : "☀️";
        }
    },

    /**
     * Load initial data on page load
     */
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
            }

            // Update Tower 2
            if (status.towers.tower2) {
                const t2 = status.towers.tower2;
                this.setText(this.elements.tower2Listeners, t2.listeners ?? "--");
                this.setText(this.elements.tower2Peak, t2.listenerPeak ?? "--");
                this.setText(this.elements.tower2Np, t2.title || "(no metadata)");
            }

            // Update Tower 3 (now with live listener data + now playing)
            if (status.towers.tower3) {
                const t3 = status.towers.tower3;
                const tower3Config = CONFIG.TOWERS.tower3;
                
                // Only show listener stats if configured to show live status
                if (tower3Config.showLiveStatus) {
                    this.setText(this.elements.tower3Listeners, t3.listeners ?? "--");
                    this.setText(this.elements.tower3Peak, t3.listenerPeak ?? "--");
                }
                this.setText(this.elements.tower3Np, t3.title || "(no metadata)");
            }

            // Update Total (Tower 1 + Tower 2 only)
            this.setText(this.elements.totalListeners, status.chartTowersTotal);

            // Sync player now playing with current selection
            this.updatePlayerNowPlayingFromStatus(status.towers);

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
            const status = await IcecastAPI.getAllTowerStatus();
            if (!status || !status.towers) return;

            for (const [towerId, towerStatus] of Object.entries(status.towers)) {
                const title = towerStatus?.title || "(no metadata)";

                switch (towerId) {
                    case "tower1":
                        this.setText(this.elements.tower1Np, title);
                        break;
                    case "tower2":
                        this.setText(this.elements.tower2Np, title);
                        break;
                    case "tower3":
                        this.setText(this.elements.tower3Np, title);
                        break;
                }
            }

            this.updatePlayerNowPlayingFromStatus(status.towers);
        } catch (error) {
            // Silently fail for now playing updates
        }
    },

    /**
     * Load and render chart data
     */
    async loadChartData() {
        try {
            const targetRange = this.currentRange;
            
            // Map range to data file
            let url;
            switch (targetRange) {
                case "2h":
                case "24h":
                    url = CONFIG.getArchiveUrl("data24h");
                    break;
                case "3d":
                case "week":
                    url = CONFIG.getArchiveUrl("dataAll");
                    break;
                default:
                    url = CONFIG.getArchiveUrl("data24h");
            }

            let payload;
            try {
                const response = await fetch(url, { cache: "no-store" });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                payload = await response.json();
            } catch (err) {
                // If all-time or week fails, fall back to 24h
                if (targetRange === "week" || targetRange === "3d") {
                    console.warn(`[Dashboard] ${targetRange} data unavailable, falling back to 24h`, err?.message);
                    this.setRangeButtonActive("24h");
                    return this.loadChartData();
                }
                throw err;
            }

            const hasSeries = Array.isArray(payload.series) && payload.series.some(s => Array.isArray(s.points) && s.points.length);
            if (!hasSeries && (targetRange === "week" || targetRange === "3d")) {
                console.warn(`[Dashboard] ${targetRange} dataset empty, falling back to 24h`);
                this.setRangeButtonActive("24h");
                return this.loadChartData();
            }

            this.renderChart(payload);

        } catch (error) {
            console.error("[Dashboard] Failed to load chart data:", error);
        }
    },

    /**
     * Filter data points based on selected time range
     * @param {Array} points - Array of [timestamp, value] pairs
     * @returns {Array} - Filtered array
     */
    filterDataByRange(points) {
        if (!Array.isArray(points) || points.length === 0) return [];
        
        const now = Date.now();
        let cutoff;
        
        switch (this.currentRange) {
            case "2h":
                cutoff = now - (2 * 60 * 60 * 1000); // 2 hours
                break;
            case "24h":
                cutoff = now - (24 * 60 * 60 * 1000); // 24 hours
                break;
            case "3d":
                cutoff = now - (3 * 24 * 60 * 60 * 1000); // 3 days
                break;
            case "week":
                cutoff = now - (7 * 24 * 60 * 60 * 1000); // 7 days
                break;
            default:
                return points; // No filtering
        }
        
        return points.filter(([timestamp]) => timestamp >= cutoff);
    },

    /**
     * Get appropriate Chart.js time unit for current range
     * @returns {string} - Time unit (minute, hour, day)
     */
    getTimeUnit() {
        switch (this.currentRange) {
            case "2h":
                return "minute";
            case "24h":
                return "hour";
            case "3d":
                return "hour";
            case "week":
                return "day";
            default:
                return "hour";
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
                data: this.filterDataByRange(series.points || []).map(([x, y]) => ({ x, y })),
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
                data: this.filterDataByRange(totalSeries.points || []).map(([x, y]) => ({ x, y })),
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
                            unit: this.getTimeUnit()
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
