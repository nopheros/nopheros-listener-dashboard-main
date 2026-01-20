/**
 * Nopheros Listener Dashboard - Icecast API Module
 *
 * Handles all communication with Icecast2 status endpoints.
 * Provides defensive parsing for varying Icecast configurations.
 */

const IcecastAPI = {
    /**
     * Fetch and parse status from Icecast status-json.xsl endpoint
     * @returns {Promise<Object>} Parsed status data by mountpoint
     */
    async fetchStatus() {
        try {
            const response = await fetch(CONFIG.ICECAST_STATUS_JSON, {
                cache: "no-store",
                mode: "cors"
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            return this.parseStatusJSON(data);
        } catch (error) {
            console.warn("[Icecast] Failed to fetch status:", error.message);
            return null;
        }
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

        const status = await this.fetchStatus();
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
     * @returns {Promise<Object>} Status keyed by tower ID
     */
    async getAllTowerStatus() {
        const status = await this.fetchStatus();
        const result = {
            towers: {},
            totalListeners: 0,
            chartTowersTotal: 0,
            fetchedAt: status?.fetchedAt || Date.now()
        };

        if (!status || !status.mounts) {
            return result;
        }

        for (const [towerId, tower] of Object.entries(CONFIG.TOWERS)) {
            const mount = status.mounts[tower.mountpoint];

            if (mount) {
                result.towers[towerId] = {
                    ...mount,
                    towerId: towerId,
                    towerName: tower.name,
                    includeInCharts: tower.includeInCharts,
                    includeInHistory: tower.includeInHistory
                };

                result.totalListeners += mount.listeners || 0;

                // Only count Tower 1 + Tower 2 for chart total
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
