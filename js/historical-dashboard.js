/**
 * Nopheros Listener Dashboard - Historical Dashboard Controller
 *
 * Handles all historical page ("Annals of the Signal") functionality:
 * - Year/Month archive selection
 * - Deep chart view with DJ show overlays
 * - Crash/dip detection and markers
 * - Timezone toggle (EST / UK London)
 */

const HistoricalDashboard = {
    // State
    chart: null,
    currentData: null,
    currentTimezone: "est",
    selectedYear: null,
    selectedMonth: null,
    detectedCrashes: [],
    showInstances: [],

    // DOM element cache
    elements: {},

    /**
     * Initialize the historical dashboard
     */
    init() {
        this.cacheElements();
        this.setupEventListeners();
        this.loadArchiveIndexes();
    },

    /**
     * Cache DOM elements
     */
    cacheElements() {
        this.elements = {
            yearSelect: document.getElementById("year-select"),
            monthSelect: document.getElementById("month-select"),
            loadDataBtn: document.getElementById("load-data"),
            tzButtons: document.querySelectorAll(".tz-btn[data-tz]"),
            chartCanvas: document.getElementById("historical-chart"),
            noDataMessage: document.getElementById("no-data-message"),
            currentViewLabel: document.getElementById("current-view-label"),
            crashEventsList: document.getElementById("crash-events-list"),
            djShowsList: document.getElementById("dj-shows-list"),
            exportCsvBtn: document.getElementById("export-historical-csv"),
            exportJsonBtn: document.getElementById("export-historical-json")
        };
    },

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Load data button
        if (this.elements.loadDataBtn) {
            this.elements.loadDataBtn.addEventListener("click", () => {
                this.loadSelectedData();
            });
        }

        // Year select change - also allow direct load
        if (this.elements.yearSelect) {
            this.elements.yearSelect.addEventListener("change", () => {
                // Clear month when year changes
                if (this.elements.monthSelect) {
                    this.elements.monthSelect.value = "";
                }
            });
        }

        // Timezone toggle
        this.elements.tzButtons.forEach(btn => {
            btn.addEventListener("click", () => {
                this.elements.tzButtons.forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                this.currentTimezone = btn.dataset.tz;

                // Re-render chart with new timezone if data loaded
                if (this.currentData) {
                    this.renderChart(this.currentData);
                    this.updateEventsDisplay();
                }
            });
        });

        // Export buttons
        if (this.elements.exportCsvBtn) {
            this.elements.exportCsvBtn.addEventListener("click", () => {
                this.exportCSV();
            });
        }

        if (this.elements.exportJsonBtn) {
            this.elements.exportJsonBtn.addEventListener("click", () => {
                this.exportJSON();
            });
        }
    },

    /**
     * Load archive indexes to populate dropdowns
     */
    async loadArchiveIndexes() {
        try {
            // Load yearly index
            const yearlyRes = await fetch(CONFIG.getArchiveUrl("yearlyIndex"), { cache: "no-store" });
            if (yearlyRes.ok) {
                const yearlyData = await yearlyRes.json();
                this.populateYearSelect(yearlyData.years || []);
            }

            // Load monthly index
            const monthlyRes = await fetch(CONFIG.getArchiveUrl("monthlyIndex"), { cache: "no-store" });
            if (monthlyRes.ok) {
                const monthlyData = await monthlyRes.json();
                this.populateMonthSelect(monthlyData.months || []);
            }
        } catch (error) {
            console.error("[Historical] Failed to load archive indexes:", error);
        }
    },

    /**
     * Populate year dropdown
     * @param {Array<number>} years - Available years
     */
    populateYearSelect(years) {
        if (!this.elements.yearSelect) return;

        // Clear existing options except placeholder
        while (this.elements.yearSelect.options.length > 1) {
            this.elements.yearSelect.remove(1);
        }

        // Add years in descending order (most recent first)
        const sortedYears = [...years].sort((a, b) => b - a);
        for (const year of sortedYears) {
            const opt = document.createElement("option");
            opt.value = year;
            opt.textContent = year;
            this.elements.yearSelect.appendChild(opt);
        }
    },

    /**
     * Populate month dropdown
     * @param {Array<string>} months - Available months (YYYY-MM format)
     */
    populateMonthSelect(months) {
        if (!this.elements.monthSelect) return;

        // Clear existing options except placeholder
        while (this.elements.monthSelect.options.length > 1) {
            this.elements.monthSelect.remove(1);
        }

        // Add months in descending order (most recent first)
        const sortedMonths = [...months].sort().reverse();
        for (const month of sortedMonths) {
            const opt = document.createElement("option");
            opt.value = month;
            // Format as "January 2026" etc
            const [year, monthNum] = month.split("-");
            const monthName = new Date(parseInt(year), parseInt(monthNum) - 1, 1)
                .toLocaleString("en-US", { month: "long" });
            opt.textContent = `${monthName} ${year}`;
            this.elements.monthSelect.appendChild(opt);
        }
    },

    /**
     * Load data based on current selection
     */
    async loadSelectedData() {
        const year = this.elements.yearSelect?.value;
        const month = this.elements.monthSelect?.value;

        let url = null;
        let viewLabel = "";

        // Month takes precedence over year
        if (month) {
            url = CONFIG.getArchiveUrl("monthly", `${month}.json`);
            const [y, m] = month.split("-");
            const monthName = new Date(parseInt(y), parseInt(m) - 1, 1)
                .toLocaleString("en-US", { month: "long" });
            viewLabel = `${monthName} ${y}`;
            this.selectedMonth = month;
            this.selectedYear = null;
        } else if (year) {
            url = CONFIG.getArchiveUrl("yearly", `${year}.json`);
            viewLabel = `Year ${year}`;
            this.selectedYear = year;
            this.selectedMonth = null;
        }

        if (!url) {
            alert("Please select a year or month");
            return;
        }

        try {
            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            this.currentData = data;

            // Update view label
            if (this.elements.currentViewLabel) {
                this.elements.currentViewLabel.textContent = viewLabel;
            }

            // Hide no-data message, show chart
            this.showChart(true);

            // Detect events BEFORE rendering chart (so annotations are ready)
            this.detectCrashes(data);
            this.findDJShows(data);

            // Now render chart with annotations
            this.renderChart(data);
            this.updateEventsDisplay();

        } catch (error) {
            console.error("[Historical] Failed to load data:", error);
            alert("Failed to load data: " + error.message);
        }
    },

    /**
     * Show or hide the chart
     * @param {boolean} show - True to show chart, false to show no-data message
     */
    showChart(show) {
        if (this.elements.chartCanvas) {
            this.elements.chartCanvas.style.display = show ? "block" : "none";
        }
        if (this.elements.noDataMessage) {
            this.elements.noDataMessage.style.display = show ? "none" : "flex";
        }
    },

    /**
     * Render historical chart with overlays
     * @param {Object} data - Chart data payload
     */
    renderChart(data) {
        if (!this.elements.chartCanvas) return;

        const ctx = this.elements.chartCanvas.getContext("2d");

        // Filter to only Tower 1, Tower 2, and Total (exclude Tower 3)
        const allowedNames = ["Tower 1", "Tower 2", "Total"];
        const filteredSeries = (data.series || []).filter(s =>
            allowedNames.some(name => s.name.toLowerCase() === name.toLowerCase())
        );

        // Build datasets
        const datasets = [];
        const totalSeries = filteredSeries.find(s => s.name.toLowerCase() === "total");
        const otherSeries = filteredSeries.filter(s => s !== totalSeries);

        // Add tower lines with reduced opacity (so Total stands out)
        for (const series of otherSeries) {
            const tower = Object.values(CONFIG.TOWERS).find(
                t => t.name.toLowerCase() === series.name.toLowerCase()
            );

            // Convert hex color to rgba with 0.5 opacity
            const hexColor = tower?.color || "#888888";
            const rgbaColor = this.hexToRgba(hexColor, 0.5);

            datasets.push({
                label: series.name,
                data: (series.points || []).map(([x, y]) => ({ x, y })),
                borderColor: rgbaColor,
                backgroundColor: rgbaColor,
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.2,
                fill: false,
                order: 2  // Higher order = rendered first (behind)
            });
        }

        // Add Total line LAST so it renders on top
        if (totalSeries) {
            datasets.push({
                label: "Total",
                data: (totalSeries.points || []).map(([x, y]) => ({ x, y })),
                borderColor: CONFIG.CHART_COLORS.total,
                backgroundColor: CONFIG.CHART_COLORS.total,
                borderWidth: 3,
                pointRadius: 0,
                tension: 0.2,
                fill: false,
                order: 1  // Lower order = rendered last (on top)
            });
        }

        // Build annotations for DJ shows and crashes
        const annotations = this.buildAnnotations();

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
                            unit: this.selectedMonth ? "day" : "month",
                            displayFormats: {
                                hour: this.getTimeFormat(),
                                day: "MMM d",
                                month: "MMM yyyy"
                            }
                        },
                        ticks: {
                            color: CONFIG.CHART_COLORS.text,
                            callback: (value) => this.formatTimestamp(value)
                        },
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
                                    return this.formatTimestamp(items[0].parsed.x, true);
                                }
                                return "";
                            }
                        }
                    },
                    annotation: {
                        annotations: annotations
                    }
                }
            }
        };

        // Destroy existing and create new
        if (this.chart) {
            this.chart.destroy();
        }
        this.chart = new Chart(ctx, config);
    },

    /**
     * Build Chart.js annotations for overlays
     * @returns {Object} Annotations config
     */
    buildAnnotations() {
        const annotations = {};

        // DJ Show overlays
        this.showInstances.forEach((show, index) => {
            annotations[`djShow${index}`] = {
                type: "box",
                xMin: show.startTime,
                xMax: show.endTime,
                backgroundColor: show.color || CONFIG.OVERLAY_COLORS.djShow,
                borderColor: show.borderColor || CONFIG.OVERLAY_COLORS.djShowBorder,
                borderWidth: 1,
                label: {
                    display: true,
                    content: show.name,
                    position: { x: "start", y: "start" },
                    color: "#fff",
                    font: { size: 9, weight: "bold" },
                    padding: 2
                }
            };
        });

        // Crash markers
        this.detectedCrashes.forEach((crash, index) => {
            annotations[`crash${index}`] = {
                type: "line",
                xMin: crash.timestamp,
                xMax: crash.timestamp,
                borderColor: CONFIG.OVERLAY_COLORS.crashBorder,
                borderWidth: 2,
                borderDash: [5, 5],
                label: {
                    display: true,
                    content: "CRASH",
                    position: "start",
                    backgroundColor: CONFIG.OVERLAY_COLORS.crash,
                    color: "#fff",
                    font: { size: 9, weight: "bold" }
                }
            };
        });

        return annotations;
    },

    /**
     * Detect crash events in the data
     * Crash: >=200 listeners dropping to <10 within 5 minutes
     * @param {Object} data - Chart data
     */
    detectCrashes(data) {
        this.detectedCrashes = [];

        // Get total series
        const totalSeries = (data.series || []).find(
            s => s.name.toLowerCase() === "total"
        );

        if (!totalSeries || !totalSeries.points || totalSeries.points.length < 2) {
            return;
        }

        const points = totalSeries.points;
        const windowMs = CONFIG.CRASH_TIME_WINDOW_MS;
        const thresholdHigh = CONFIG.CRASH_THRESHOLD_HIGH;
        const thresholdLow = CONFIG.CRASH_THRESHOLD_LOW;

        for (let i = 1; i < points.length; i++) {
            const [prevTs, prevVal] = points[i - 1];
            const [currTs, currVal] = points[i];

            // Check if this is a crash transition
            if (prevVal >= thresholdHigh && currVal < thresholdLow) {
                const timeDiff = currTs - prevTs;

                if (timeDiff <= windowMs) {
                    this.detectedCrashes.push({
                        timestamp: currTs,
                        prevListeners: prevVal,
                        afterListeners: currVal,
                        timeDiffMs: timeDiff,
                        timeDiffMinutes: Math.round(timeDiff / 60000)
                    });
                }
            }
        }
    },

    /**
     * Find DJ shows in the current data range
     * @param {Object} data - Chart data
     */
    findDJShows(data) {
        this.showInstances = [];

        // Determine date range from data
        let minTs = Infinity;
        let maxTs = -Infinity;

        for (const series of (data.series || [])) {
            for (const [ts] of (series.points || [])) {
                if (ts < minTs) minTs = ts;
                if (ts > maxTs) maxTs = ts;
            }
        }

        if (minTs === Infinity || maxTs === -Infinity) {
            return;
        }

        const startDate = new Date(minTs);
        const endDate = new Date(maxTs);

        // Get shows from DJ_SHOWS configuration
        if (typeof DJ_SHOWS !== "undefined" && DJ_SHOWS.getShowsInRange) {
            this.showInstances = DJ_SHOWS.getShowsInRange(
                startDate,
                endDate,
                this.currentTimezone
            );
        }
    },

    /**
     * Update the events display panels
     */
    updateEventsDisplay() {
        this.updateCrashEventsList();
        this.updateDJShowsList();
    },

    /**
     * Update crash events list
     */
    updateCrashEventsList() {
        const list = this.elements.crashEventsList;
        if (!list) return;

        list.innerHTML = "";

        if (this.detectedCrashes.length === 0) {
            list.innerHTML = `
                <li class="event-item no-events">
                    <span class="event-details">No crashes detected in selected period</span>
                </li>
            `;
            return;
        }

        for (const crash of this.detectedCrashes) {
            const li = document.createElement("li");
            li.className = "event-item";
            li.innerHTML = `
                <span class="event-marker crash"></span>
                <div class="event-details">
                    <div class="event-time">${this.formatTimestamp(crash.timestamp, true)}</div>
                    <div class="event-description">
                        Dropped from ${crash.prevListeners} to ${crash.afterListeners} listeners
                        in ${crash.timeDiffMinutes} minutes
                    </div>
                </div>
            `;
            list.appendChild(li);
        }
    },

    /**
     * Update DJ shows list
     */
    updateDJShowsList() {
        const list = this.elements.djShowsList;
        if (!list) return;

        list.innerHTML = "";

        if (this.showInstances.length === 0) {
            list.innerHTML = `
                <li class="event-item no-events">
                    <span class="event-details">No DJ shows configured for selected period</span>
                </li>
            `;
            return;
        }

        // Group by date for cleaner display
        const byDate = {};
        for (const show of this.showInstances) {
            const dateKey = this.formatTimestamp(show.startTime, false);
            if (!byDate[dateKey]) {
                byDate[dateKey] = [];
            }
            byDate[dateKey].push(show);
        }

        for (const [date, shows] of Object.entries(byDate)) {
            for (const show of shows) {
                const li = document.createElement("li");
                li.className = "event-item";
                li.innerHTML = `
                    <span class="event-marker dj-show" style="background-color: ${show.borderColor || CONFIG.OVERLAY_COLORS.djShowBorder}"></span>
                    <div class="event-details">
                        <div class="event-time">${date}</div>
                        <div class="event-description">
                            <strong>${show.name}</strong> with ${show.dj}
                            (${Math.round(show.durationMinutes / 60)}h)
                        </div>
                    </div>
                `;
                list.appendChild(li);
            }
        }
    },

    /**
     * Get time format based on timezone
     * @returns {string}
     */
    getTimeFormat() {
        return "h:mm a";
    },

    /**
     * Format timestamp according to selected timezone
     * @param {number} timestamp - Unix timestamp in ms
     * @param {boolean} includeTime - Include time in output
     * @returns {string}
     */
    formatTimestamp(timestamp, includeTime = false) {
        const date = new Date(timestamp);
        const tz = this.currentTimezone === "uk"
            ? CONFIG.TIMEZONES.uk.ianaName
            : CONFIG.TIMEZONES.est.ianaName;

        const options = {
            timeZone: tz,
            year: "numeric",
            month: "short",
            day: "numeric"
        };

        if (includeTime) {
            options.hour = "numeric";
            options.minute = "2-digit";
            options.hour12 = true;
        }

        try {
            return date.toLocaleString("en-US", options);
        } catch {
            return date.toLocaleString();
        }
    },

    /**
     * Export current data as CSV
     */
    exportCSV() {
        if (!this.currentData) {
            alert("No data loaded");
            return;
        }

        try {
            const tsSet = new Set();
            const seriesNames = this.currentData.series.map(s => s.name);
            const seriesMap = {};

            this.currentData.series.forEach(s => {
                seriesMap[s.name] = s.points;
                s.points.forEach(([x]) => tsSet.add(x));
            });

            const timestamps = Array.from(tsSet).sort((a, b) => a - b);
            const rows = [];

            // Header
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
            const filename = this.selectedMonth
                ? `historical_${this.selectedMonth}.csv`
                : `historical_${this.selectedYear}.csv`;

            this.downloadFile(csv, filename, "text/csv");
        } catch (error) {
            alert("Failed to export: " + error.message);
        }
    },

    /**
     * Export current data as JSON
     */
    exportJSON() {
        if (!this.currentData) {
            alert("No data loaded");
            return;
        }

        const filename = this.selectedMonth
            ? `historical_${this.selectedMonth}.json`
            : `historical_${this.selectedYear}.json`;

        this.downloadFile(
            JSON.stringify(this.currentData, null, 2),
            filename,
            "application/json"
        );
    },

    /**
     * Helper: Download a file
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
    },

    /**
     * Helper: Convert hex color to rgba
     * @param {string} hex - Hex color (e.g., "#2ecc71")
     * @param {number} alpha - Alpha value (0-1)
     * @returns {string} - rgba color string
     */
    hexToRgba(hex, alpha) {
        // Remove # if present
        hex = hex.replace(/^#/, "");

        // Parse hex values
        let r, g, b;
        if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
        } else {
            r = parseInt(hex.substring(0, 2), 16);
            g = parseInt(hex.substring(2, 4), 16);
            b = parseInt(hex.substring(4, 6), 16);
        }

        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
};

// Initialize when DOM ready
document.addEventListener("DOMContentLoaded", () => {
    HistoricalDashboard.init();
});
