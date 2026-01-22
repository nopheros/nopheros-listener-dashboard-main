/**
 * Nopheros Listener Dashboard - Icecast API Module
 *
 * Handles all communication with Icecast2 status endpoints.
 * Provides defensive parsing for varying Icecast configurations.
 */

const IcecastAPI = {
    /**
     * Fetch and parse status from Icecast status-json.xsl endpoint
     * @param {string} baseUrl - Optional base URL to fetch from (defaults to CONFIG.ICECAST_BASE_URL)
     * @returns {Promise<Object>} Parsed status data by mountpoint
     */
    async fetchStatus(baseUrl = null) {
        try {
            const url = baseUrl
                ? `${baseUrl}/status-json.xsl`
                : CONFIG.ICECAST_STATUS_JSON;
            console.log("[Icecast] Fetching status from:", url);

            const response = await fetch(url, {
                cache: "no-store",
                mode: "cors"
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            console.log("[Icecast] Parsed status successfully");
            return this.parseStatusJSON(data);
        } catch (error) {
            console.warn("[Icecast] Failed to fetch status from", baseUrl || CONFIG.ICECAST_BASE_URL, ":", error.message);
            return null;
        }
    },

    /**
     * Get all unique base URLs from tower configuration
     * @returns {string[]} Array of unique base URLs
     */
    getUniqueBaseUrls() {
        const urls = new Set();
        for (const tower of Object.values(CONFIG.TOWERS)) {
            urls.add(tower.baseUrl || CONFIG.ICECAST_BASE_URL);
        }
        return Array.from(urls);
    },

    /**
     * Fetch status from all configured Icecast servers
     * @returns {Promise<Object>} Combined status with mounts from all servers
     */
    async fetchAllServersStatus() {
        const baseUrls = this.getUniqueBaseUrls();
        const results = await Promise.all(
            baseUrls.map(url => this.fetchStatus(url))
        );

        // Combine all mounts into a single result
        const combined = {
            mounts: {},
            serverInfo: null,
            fetchedAt: Date.now()
        };

        for (const result of results) {
            if (result && result.mounts) {
                Object.assign(combined.mounts, result.mounts);
            }
            if (result && result.serverInfo && !combined.serverInfo) {
                combined.serverInfo = result.serverInfo;
            }
        }

        return combined;
    },

    /**
     * Parse Icecast status-json.xsl response
     * Handles both single source and array of sources
     * @param {Object} data - Raw JSON from Icecast
     * @returns {Object} Normalized status object
     */
    parseStatusJSON(data) {
        const result = {
            mounts: {},
            serverInfo: null,
            fetchedAt: Date.now()
        };

        try {
            const icestats = data?.icestats;
            if (!icestats) {
                console.warn("[Icecast] No icestats in response");
                return result;
            }

            // Server info (may not always be present)
            result.serverInfo = {
                admin: icestats.admin || null,
                host: icestats.host || null,
                location: icestats.location || null,
                serverId: icestats.server_id || null
            };

            // Sources can be a single object or an array
            let sources = icestats.source;
            if (!sources) {
                return result;
            }

            if (!Array.isArray(sources)) {
                sources = [sources];
            }

            // Parse each source/mount
            for (const source of sources) {
                const mountInfo = this.parseMountSource(source);
                if (mountInfo && mountInfo.mountpoint) {
                    result.mounts[mountInfo.mountpoint] = mountInfo;
                }
            }

        } catch (error) {
            console.error("[Icecast] Error parsing status:", error);
        }

        return result;
    },

    /**
     * Parse a single mount source object
     * @param {Object} source - Source object from Icecast
     * @returns {Object|null} Parsed mount info
     */
    parseMountSource(source) {
        if (!source) return null;

        try {
            // Extract mountpoint from listenurl or use directly
            let mountpoint = null;

            if (source.listenurl) {
                // listenurl is typically full URL like "http://host:port/mountpoint"
                try {
                    const url = new URL(source.listenurl);
                    mountpoint = url.pathname;
                } catch {
                    // If URL parsing fails, try to extract path manually
                    const match = source.listenurl.match(/\/[^\/]+$/);
                    mountpoint = match ? match[0] : source.listenurl;
                }
            } else if (source.mount) {
                mountpoint = source.mount;
            }

            if (!mountpoint) {
                return null;
            }

            return {
                mountpoint: mountpoint,
                listeners: this.safeInt(source.listeners, 0),
                listenerPeak: this.safeInt(source.listener_peak, null),
                title: source.title || source.yp_currently_playing || null,
                description: source.server_description || source.description || null,
                genre: source.genre || null,
                bitrate: this.safeInt(source.bitrate, null),
                samplerate: this.safeInt(source.samplerate, null),
                channels: this.safeInt(source.channels, null),
                audioCodecId: source.audio_codecid || source.subtype || null,
                streamUrl: source.listenurl || `${CONFIG.ICECAST_BASE_URL}${mountpoint}`,
                serverName: source.server_name || null,
                serverType: source.server_type || null,
                streamStart: source.stream_start || null,
                streamStartIso: source.stream_start_iso8601 || null,
                connected: this.safeInt(source.connected, null),
                maxListeners: this.safeInt(source.max_listeners, null),
                public: source.public === 1 || source.public === true,
                slowListeners: this.safeInt(source.slow_listeners, 0),
                sourceIp: source.source_ip || null,
                userAgent: source.user_agent || null
            };
        } catch (error) {
            console.warn("[Icecast] Error parsing mount source:", error);
            return null;
        }
    },

    /**
     * Get status for a specific tower by ID
     * @param {string} towerId - Tower ID from CONFIG
     * @returns {Promise<Object|null>} Mount status or null
     */
    async getTowerStatus(towerId) {
        const tower = CONFIG.TOWERS[towerId];
        if (!tower) {
            console.warn(`[Icecast] Unknown tower: ${towerId}`);
            return null;
        }

        // Fetch from the tower's specific server
        const baseUrl = tower.baseUrl || CONFIG.ICECAST_BASE_URL;
        const status = await this.fetchStatus(baseUrl);
        if (!status || !status.mounts) {
            return null;
        }

        // Find mount matching this tower's mountpoint
        const mount = status.mounts[tower.mountpoint];
        if (mount) {
            return {
                ...mount,
                towerId: towerId,
                towerName: tower.name
            };
        }

        return null;
    },

    /**
     * Get status for all configured towers
     * Fetches from each tower's specific server to handle multi-server setups
     * @returns {Promise<Object>} Status keyed by tower ID
     */
    async getAllTowerStatus() {
        console.log("[Icecast] getAllTowerStatus() called");
        const result = {
            towers: {},
            totalListeners: 0,
            chartTowersTotal: 0,
            fetchedAt: Date.now()
        };

        // Group towers by their base URL to minimize requests
        const towersByUrl = {};
        for (const [towerId, tower] of Object.entries(CONFIG.TOWERS)) {
            const baseUrl = tower.baseUrl || CONFIG.ICECAST_BASE_URL;
            if (!towersByUrl[baseUrl]) {
                towersByUrl[baseUrl] = [];
            }
            towersByUrl[baseUrl].push({ towerId, tower });
        }

        // Fetch status from each unique server in parallel
        const fetchPromises = Object.entries(towersByUrl).map(async ([baseUrl, towers]) => {
            const status = await this.fetchStatus(baseUrl);
            return { baseUrl, towers, status };
        });

        const serverResults = await Promise.all(fetchPromises);
        console.log("[Icecast] Server results:", serverResults);

        // Process results from each server
        for (const { towers, status } of serverResults) {
            console.log("[Icecast] Processing server results, towers:", towers.length, "status:", status);
            for (const { towerId, tower } of towers) {
                const mount = status?.mounts?.[tower.mountpoint];
                console.log(`[Icecast] Tower ${towerId}: mount found =`, !!mount, "mountpoint:", tower.mountpoint);

                if (mount) {
                    result.towers[towerId] = {
                        ...mount,
                        towerId: towerId,
                        towerName: tower.name,
                        includeInCharts: tower.includeInCharts,
                        includeInHistory: tower.includeInHistory
                    };

                    result.totalListeners += mount.listeners || 0;

                    // Only count towers marked for charts in chart total
                    if (tower.includeInCharts) {
                        result.chartTowersTotal += mount.listeners || 0;
                    }
                } else {
                    // Mount not found - tower may be offline
                    result.towers[towerId] = {
                        towerId: towerId,
                        towerName: tower.name,
                        mountpoint: tower.mountpoint,
                        listeners: 0,
                        listenerPeak: null,
                        title: null,
                        offline: true,
                        includeInCharts: tower.includeInCharts,
                        includeInHistory: tower.includeInHistory
                    };
                }
            }
        }

        console.log("[Icecast] Final result:", result);
        return result;
    },

    /**
     * Safely parse an integer with fallback
     * @param {*} value - Value to parse
     * @param {*} fallback - Fallback if parsing fails
     * @returns {number|null}
     */
    safeInt(value, fallback = null) {
        if (value === null || value === undefined || value === "") {
            return fallback;
        }
        const parsed = parseInt(value, 10);
        return isNaN(parsed) ? fallback : parsed;
    },

    /**
     * Get stream URL for a tower (public playable URL)
     * @param {string} towerId - Tower ID
     * @returns {string|null}
     */
    getStreamUrl(towerId) {
        return CONFIG.getStreamUrl(towerId);
    }
};

// Freeze to prevent modification
Object.freeze(IcecastAPI);
