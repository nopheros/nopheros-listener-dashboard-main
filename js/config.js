/**
 * Nopheros Listener Dashboard - Configuration
 *
 * All configurable values in one place for easy maintenance.
 * Update these values to match your Icecast server setup.
 */

const CONFIG = {
    // =========================================================================
    // ICECAST SERVER CONFIGURATION
    // =========================================================================

    // Base URL for the Icecast server (no trailing slash)
    ICECAST_BASE_URL: "https://radio.turtle-music.org", //"http://***REMOVED***:8000",

    // Icecast status endpoints
    get ICECAST_STATUS_JSON() {
        return `${this.ICECAST_BASE_URL}/status-json.xsl`;
    },
    get ICECAST_STATUS_HTML() {
        return `${this.ICECAST_BASE_URL}/status.xsl`;
    },

    // =========================================================================
    // TOWER / MOUNTPOINT CONFIGURATION
    // =========================================================================

    // Tower definitions - mountpoint paths as they appear in Icecast
    TOWERS: {
        tower1: {
            id: "tower1",
            name: "Tower 1",
            mountpoint: "/stream",
            description: "Primary Broadcast Tower",
            includeInCharts: true,
            includeInHistory: true,
            color: "#3498db"  // Blue
        },
        tower2: {
            id: "tower2",
            name: "Tower 2",
            mountpoint: "/stream",
            description: "Secondary Relay Tower",
            includeInCharts: true,
            includeInHistory: true,
            color: "#9b59b6"  // Purple
        },
        tower3: {
            id: "tower3",
            name: "Tower 3",
            mountpoint: "/tower3",
            description: "Atlantean Testing Relay",
            flavorText: "That rickety old tower those skeezy Gnomes wouldn't even touch...",
            includeInCharts: false,  // INFO ONLY - no charts
            includeInHistory: false, // INFO ONLY - no history
            color: "#27ae60"  // Green
        }
    },

    // Get stream URL for a tower (public playable stream, NOT admin URL)
    getStreamUrl(towerId) {
        const tower = this.TOWERS[towerId];
        if (!tower) return null;
        return `${this.ICECAST_BASE_URL}${tower.mountpoint}`;
    },

    // Get towers that should appear in charts
    getChartTowers() {
        return Object.values(this.TOWERS).filter(t => t.includeInCharts);
    },

    // Get towers that should be archived in history
    getHistoryTowers() {
        return Object.values(this.TOWERS).filter(t => t.includeInHistory);
    },

    // =========================================================================
    // DATA ARCHIVE CONFIGURATION
    // =========================================================================

    // Base URL for archived JSON data (can be changed to offload to CDN later)
    // This MUST be configurable in one place for future-proofing
    ARCHIVE_BASE_URL: "data/",

    // Archive file paths (relative to ARCHIVE_BASE_URL)
    ARCHIVE_PATHS: {
        data24h: "data_24h.json",
        dataAll: "data_all.json",
        piHealth: "pi_health.json",
        monthlyIndex: "monthly_index.json",
        yearlyIndex: "yearly_index.json",
        monthly: "monthly/",   // Append YYYY-MM.json
        yearly: "yearly/"      // Append YYYY.json
    },

    // Build full archive URL
    getArchiveUrl(pathKey, suffix = "") {
        const path = this.ARCHIVE_PATHS[pathKey];
        if (!path) return null;
        return `${this.ARCHIVE_BASE_URL}${path}${suffix}`;
    },

    // =========================================================================
    // CRASH/DIP DETECTION CONFIGURATION
    // =========================================================================

    // Crash detection rule: Drop from >= CRASH_THRESHOLD_HIGH to < CRASH_THRESHOLD_LOW
    // within CRASH_TIME_WINDOW_MS milliseconds
    CRASH_THRESHOLD_HIGH: 200,  // Must have been at least this many listeners
    CRASH_THRESHOLD_LOW: 10,    // Must drop below this
    CRASH_TIME_WINDOW_MS: 5 * 60 * 1000,  // 5 minutes in milliseconds

    // =========================================================================
    // TIMEZONE CONFIGURATION
    // =========================================================================

    TIMEZONES: {
        est: {
            id: "est",
            label: "EST",
            fullName: "Eastern Standard Time",
            ianaName: "America/New_York"
        },
        uk: {
            id: "uk",
            label: "UK London",
            fullName: "Greenwich Mean Time / British Summer Time",
            ianaName: "Europe/London"
        }
    },

    // Default timezone
    DEFAULT_TIMEZONE: "est",

    // =========================================================================
    // REFRESH INTERVALS
    // =========================================================================

    // How often to refresh live data (milliseconds)
    LIVE_REFRESH_INTERVAL_MS: 60 * 1000,  // 60 seconds

    // How often to refresh now playing metadata (milliseconds)
    NOW_PLAYING_REFRESH_INTERVAL_MS: 30 * 1000,  // 30 seconds

    // =========================================================================
    // UI CONFIGURATION
    // =========================================================================

    // Chart colors
    CHART_COLORS: {
        total: "#f1c40f",      // Yellow/Gold for total
        grid: "#222",
        text: "#aaa",
        legend: "#ddd"
    },

    // Overlay colors for historical view
    OVERLAY_COLORS: {
        djShow: "rgba(46, 204, 113, 0.2)",      // Green tint for DJ shows
        djShowBorder: "rgba(46, 204, 113, 0.8)",
        crash: "rgba(231, 76, 60, 0.3)",         // Red tint for crashes
        crashBorder: "rgba(231, 76, 60, 1)"
    }
};

// Freeze config to prevent accidental modification
Object.freeze(CONFIG);
Object.freeze(CONFIG.TOWERS);
Object.freeze(CONFIG.ARCHIVE_PATHS);
Object.freeze(CONFIG.TIMEZONES);
Object.freeze(CONFIG.CHART_COLORS);
Object.freeze(CONFIG.OVERLAY_COLORS);

// Export for use in modules (if using ES modules)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
}
