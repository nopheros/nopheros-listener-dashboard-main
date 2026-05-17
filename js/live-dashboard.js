/**
 * Nopheros Listener Dashboard - Live Dashboard Controller
 *
 * Handles all live page functionality including:
 * - Real-time tower status updates
 * - Embedded Tower 3 player with resync
 * - Live chart visualization
 * - Pi health monitoring
 */

const LiveDashboard = {
    // State
    chart: null,
    currentRange: "24h",
    refreshInterval: null,
    nowPlayingInterval: null,
    currentPlayerTower: "tower3",
    playerRecoveryAt: 0,
    liveTailPoints: [],
    liveTailWindowMinutes: 20,

    // DOM element cache
    elements: {},

    /**
     * Initialize the dashboard
     */
    init() {
        this.cacheElements();
        this.setupPlayer();
        this.setupEventListeners();
        this.updateScheduleHighlight();
        this.loadInitialData();
        this.startRefreshLoop();
    },

    /**
     * Cache DOM elements for performance
     */
    cacheElements() {
        this.elements = {
            // Player
            player: document.getElementById("tower-player"),
            playerSource: document.getElementById("tower-player-source"),
            playerReload: document.getElementById("player-reload"),
            playerNowPlaying: document.getElementById("player-now-playing"),
            playerSelect: document.getElementById("player-stream-select"),
            playerPopupWindow: document.getElementById("player-popup-window"),
            playerPopupModal: document.getElementById("player-popup-modal"),
            playerTower1Btn: document.getElementById("player-tower1-btn"),
            playerTower3Btn: document.getElementById("player-tower3-btn"),
            playerLiveTotal: document.getElementById("player-live-total"),
            playerLivePeak: document.getElementById("player-live-peak"),
            playerListeners: document.getElementById("player-listeners"),
            playerPeak: document.getElementById("player-peak"),
            tower3PlayBtn: document.getElementById("tower3-play-btn"),

            // Tower cards
            tower3Listeners: document.getElementById("tower3-listeners"),
            tower3Peak: document.getElementById("tower3-peak"),
            tower3Np: document.getElementById("tower3-np"),
            tower3StreamName: document.getElementById("tower3-stream-name"),
            tower3StreamDesc: document.getElementById("tower3-stream-desc"),
            tower3DescItem: document.getElementById("tower3-desc-item"),
            totalListeners: document.getElementById("total-listeners"),
            memorialPlaque: document.getElementById("memorial-plaque"),
            memorialSecret: document.getElementById("memorial-secret"),

            // Chart
            chartCanvas: document.getElementById("listeners-chart"),
            refreshChart: document.getElementById("refresh-chart"),
            rangeButtons: document.querySelectorAll(".range-btn[data-range]"),

            // Header
            lastUpdated: document.getElementById("last-updated"),
            scheduleTimeline: document.getElementById("schedule-timeline"),
            signalHonors: document.getElementById("signal-honors"),
            signalPeakLegacy: document.getElementById("signal-peak-legacy"),
            signalPeakTower3: document.getElementById("signal-peak-tower3")
        };
    },

    /**
     * Highlight the next upcoming schedule item in the timeline
     */
    updateScheduleHighlight() {
        const timeline = this.elements.scheduleTimeline;
        if (!timeline) return;

        const entries = Array.from(timeline.querySelectorAll(".schedule-timeline-item"));
        if (!entries.length) return;

        const now = new Date();
        const nowDay = now.getDay();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        let bestEntry = null;
        let bestDelta = Number.POSITIVE_INFINITY;

        entries.forEach((entry) => {
            const entryDay = Number(entry.dataset.day);
            const entryHour = Number(entry.dataset.hour || 0);
            const entryMinute = Number(entry.dataset.minute || 0);

            if (Number.isNaN(entryDay)) return;

            const entryMinutes = entryHour * 60 + entryMinute;
            let dayDelta = entryDay - nowDay;
            if (dayDelta < 0 || (dayDelta === 0 && entryMinutes < nowMinutes)) {
                dayDelta += 7;
            }

            const minuteDelta = dayDelta * 1440 + (entryMinutes - nowMinutes);
            if (minuteDelta < bestDelta) {
                bestDelta = minuteDelta;
                bestEntry = entry;
            }
        });

        entries.forEach((entry) => entry.classList.remove("is-upcoming"));
        if (bestEntry) {
            bestEntry.classList.add("is-upcoming");
        }
    },

    /**
     * Setup the embedded audio player
     */
    setupPlayer() {
        this.setPlayerSource(this.currentPlayerTower);
        this.bindPlayerRecovery();
        this.bindPlayerStateTracking();

        document.querySelectorAll("[data-radio-action]").forEach(button => {
            button.addEventListener("click", (e) => {
                e.preventDefault();
                this.handleRadioControl(button.dataset.radioAction, button.dataset.tower);
            });
        });

        this.syncRadioControls();
    },

    /**
     * Handle radio control button interactions
     * @param {string} action
     * @param {string} towerId
     */
    handleRadioControl(action, towerId) {
        switch (action) {
            case "pause":
                this.pauseStream();
                break;
            case "live":
            case "play":
            default:
                this.playTower(towerId || this.currentPlayerTower);
                break;
        }
    },

    /**
     * Play a tower stream in the embedded player
     * @param {string} towerId
     */
    openTowerStream(towerId) {
        this.playTower(towerId);
    },

    /**
     * Select a tower and start playback in the embedded player
     * @param {string} towerId
     */
    playTower(towerId) {
        const player = this.elements.player;
        if (!player) return;

        const streamUrl = IcecastAPI.getStreamUrl(towerId);
        if (this.isMixedContentBlocked(streamUrl)) {
            this.openMixedContentFallback(streamUrl, towerId);
            return;
        }

        this.setPlayerSource(towerId);
        this.currentPlayerTower = towerId;

        player.play().catch(err => {
            console.warn("[Player] Playback could not start:", err.message);
        });

        this.syncRadioControls();
        this.focusPlayerSection(towerId);
    },

    /**
     * Detect browser-mixed-content playback blocks (HTTPS page -> HTTP stream)
     * @param {string|null} streamUrl
     * @returns {boolean}
     */
    isMixedContentBlocked(streamUrl) {
        if (!streamUrl || typeof window === "undefined") return false;
        return window.location.protocol === "https:" && /^http:\/\//i.test(streamUrl);
    },

    /**
     * Fallback when mixed-content blocks in-page playback
     * @param {string} streamUrl
     * @param {string} towerId
     */
    openMixedContentFallback(streamUrl, towerId) {
        console.warn(`[Player] ${towerId} stream is HTTP-only while dashboard is HTTPS. Opening direct stream.`);
        window.open(streamUrl, "_blank", "noopener,noreferrer");
    },

    /**
     * Pause the embedded player without changing the selected tower
     */
    pauseStream() {
        const player = this.elements.player;
        if (!player) return;

        player.pause();
        this.syncRadioControls();
    },

    /**
     * Keep play/pause/live button state in sync with the audio element
     */
    bindPlayerStateTracking() {
        const player = this.elements.player;
        if (!player || this.playerStateTrackingBound) return;

        this.playerStateTrackingBound = true;

        const sync = () => this.syncRadioControls();
        player.addEventListener("play", sync);
        player.addEventListener("pause", sync);
        player.addEventListener("ended", sync);
        player.addEventListener("emptied", sync);
    },

    /**
     * Update play/pause/live button styling and accessibility state
     */
    syncRadioControls() {
        const player = this.elements.player;
        const isPlaying = !!player && !player.paused && !player.ended && !!player.currentSrc;
        const selectedTower = this.currentPlayerTower;

        document.querySelectorAll("[data-radio-action]").forEach(button => {
            const action = button.dataset.radioAction;
            const towerId = button.dataset.tower;
            const towerMatches = towerId === selectedTower;
            const active = towerMatches && ((action === "pause" && !isPlaying) || (action !== "pause" && isPlaying));

            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
    },

    /**
     * Focus the embedded player area after a tower selection
     */
    focusPlayerSection(towerId) {
        const towerCard = document.querySelector(`.tower-card[data-tower="${towerId}"]`);
        if (!towerCard) return;

        towerCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },

    /**
     * Keep the stream alive when browsers stall or reconnect late
     */
    bindPlayerRecovery() {
        const player = this.elements.player;
        if (!player || this.playerRecoveryBound) return;

        this.playerRecoveryBound = true;

        const recover = () => {
            const now = Date.now();
            if (now - this.playerRecoveryAt < 5000) return;
            this.playerRecoveryAt = now;
            this.resyncPlayer();
        };

        player.addEventListener("stalled", recover);
        player.addEventListener("waiting", recover);
        player.addEventListener("error", recover);
        player.addEventListener("ended", recover);
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

        this.syncRadioControls();
    },

    /**
     * Play Tower 3 stream
     */
    playTower3() {
        this.playTower("tower3");
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
        // Pop-out player - new window
        if (this.elements.playerPopupWindow) {
            this.elements.playerPopupWindow.addEventListener("click", () => {
                this.playTower(this.currentPlayerTower);
            });
        }

        // Pop-out player - modal overlay
        if (this.elements.playerPopupModal) {
            this.elements.playerPopupModal.addEventListener("click", () => {
                this.playTower(this.currentPlayerTower);
            });
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
                this.refreshLiveAndChart();
            });
        }

    },

    /**
     * Load initial data on page load
     */
    async loadInitialData() {
        await Promise.all([
            this.refreshLiveAndChart(),
            this.updatePiHealth(),
            this.updateLiveTotals(),
            this.updateMemorialStatus()
        ]);
    },

    /**
     * Refresh live status first, then chart so live-tail overlay has current samples
     */
    async refreshLiveAndChart() {
        await this.updateTowerStatus();
        await this.loadChartData();
    },

    /**
     * Start the refresh loop
     */
    startRefreshLoop() {
        // Tower status and chart refresh
        this.refreshInterval = setInterval(() => {
            this.refreshLiveAndChart();
            this.updatePiHealth();
            this.updateLiveTotals();
            this.updateMemorialStatus();
            this.updateScheduleHighlight();
        }, CONFIG.LIVE_REFRESH_INTERVAL_MS);

        // Now playing updates (more frequent)
        this.nowPlayingInterval = setInterval(() => {
            this.updateNowPlaying();
        }, CONFIG.NOW_PLAYING_REFRESH_INTERVAL_MS);

        // Initial now playing update
        this.updateNowPlaying();
        this.updateScheduleHighlight();
    },

    /**
     * Load and display current & upcoming events from schedule
     */
    async loadEvents() {
        const eventsList = document.getElementById("events-list");
        if (!eventsList) return;

        try {
            // DJ Twitch URL mapping
            const djTwitchUrls = {
                "Sabellwind": "https://www.twitch.tv/sabellwind",
                "Whiski": "https://twitch.tv/DJWhiski",
                "Sheal": "https://twitch.tv/DJ_Sheal"
            };

            const schedule = [
                { day: 1, show: "Treehab", dj: "Sabellwind", startHour: 11, startMin: 0, endHour: 16, endMin: 0 },
                { day: 1, show: "Living in the Past", dj: "Leto", startHour: 18, startMin: 0, endHour: 23, endMin: 0 },
                { day: 2, show: "Groovin' Graveyard", dj: "Crustman", startHour: 15, startMin: 0, endHour: 20, endMin: 0 },
                { day: 3, show: "Deeprun Classix", dj: "Kando", startHour: 16, startMin: 0, endHour: 21, endMin: 0 },
                { day: 5, show: "Pilgrim of Signal", dj: "Sabellwind", startHour: 20, startMin: 0, endHour: 25, endMin: 0 },
                { day: 6, show: "Tavern Talks", dj: "Sheal", startHour: 15, startMin: 0, endHour: 20, endMin: 0 },
                { day: 0, show: "The Whiski Lounge", dj: "Whiski", startHour: 19, startMin: 0, endHour: 24, endMin: 0 }
            ];

            const now = new Date();
            const currentDay = now.getDay();
            const currentHour = now.getHours();
            const currentTime = currentHour * 60 + now.getMinutes();

            const events = [];
            const currentEvent = schedule.find(e => {
                if (e.day !== currentDay) return false;
                const startTime = e.startHour * 60 + e.startMin;
                const endTime = e.endHour * 60 + e.endMin;
                return currentTime >= startTime && currentTime < endTime;
            });

            if (currentEvent) {
                events.push({ ...currentEvent, isCurrent: true, date: now });
            }

            for (let dayOffset = 0; dayOffset <= 3; dayOffset++) {
                const checkDate = new Date(now);
                checkDate.setDate(checkDate.getDate() + dayOffset);
                const checkDay = checkDate.getDay();

                schedule.filter(e => e.day === checkDay).forEach(event => {
                    const eventDate = new Date(checkDate);
                    eventDate.setHours(event.startHour, event.startMin, 0, 0);
                    if (dayOffset === 0 && currentTime >= event.startHour * 60 + event.startMin) return;
                    events.push({ ...event, isCurrent: false, date: eventDate });
                });
            }

            events.sort((a, b) => a.date - b.date);
            const displayEvents = events.slice(0, 5);

            if (displayEvents.length === 0) {
                eventsList.innerHTML = '<p class="events-loading">No upcoming events</p>';
                return;
            }

            eventsList.innerHTML = displayEvents.map(event => {
                const timeStr = this.formatEventTime(event.date, event.startHour, event.endHour);
                const badge = event.isCurrent ? '<span class="event-badge">Live Now</span>' : '';
                const currentClass = event.isCurrent ? ' current' : '';
                
                // Add Twitch link if DJ has one
                const djDisplay = djTwitchUrls[event.dj] 
                    ? `<a href="${djTwitchUrls[event.dj]}" target="_blank" class="dj-link">DJ ${event.dj}</a>`
                    : `DJ ${event.dj}`;
                
                return `<div class="event-item${currentClass}">
                    <div class="event-info">
                        <div class="event-show">${event.show}${badge}</div>
                        <div class="event-dj">${djDisplay}</div>
                    </div>
                    <div class="event-time">${timeStr}</div>
                </div>`;
            }).join('');
        } catch (error) {
            console.error("[Dashboard] Failed to load events:", error);
            eventsList.innerHTML = '<p class="events-loading">Unable to load events</p>';
        }
    },

    formatEventTime(date, startHour, endHour) {
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const dayName = dayNames[date.getDay()];
        const formatHour = (h) => {
            const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
            const ampm = h >= 12 ? "PM" : "AM";
            return `${hour12}:00 ${ampm}`;
        };
        
        // Convert EST to UK time (EST + 5 hours) in 24-hour format
        const ukHour = (startHour + 5) % 24;
        const ukFormatted = `${String(ukHour).padStart(2, '0')}:00`;
        
        return `${dayName} ${formatHour(startHour)} EST<br>${ukFormatted} ST`;
    },

    /**
     * Update live total and peak listener badges in player header
     */
    async updateLiveTotals() {
        try {
            const status = await IcecastAPI.getAllTowerStatus();
            const total = status?.towers?.tower3?.listeners ?? 0;
            if (this.elements.playerLiveTotal) {
                this.setText(this.elements.playerLiveTotal, `${total} Live`);
            }

            this.setText(this.elements.totalListeners, total);

            // Prefer a Tower 3 archive peak, otherwise fall back to the live listener peak
            let peak = null;
            try {
                const url = CONFIG.getArchiveUrl("data24h");
                const response = await fetch(url, { cache: "no-store" });
                if (response.ok) {
                    const payload = await response.json();
                    const tower3Series = (payload.series || []).find(s => (s.name || "").toLowerCase() === "tower 3");
                    if (tower3Series && Array.isArray(tower3Series.points)) {
                        const points = this.filterDataByRange(tower3Series.points);
                        peak = points.length ? Math.max(...points.map(([_, y]) => y)) : 0;
                    }
                }
            } catch {}

            if (peak == null) {
                peak = status?.towers?.tower3?.listenerPeak ?? null;
            }

            if (this.elements.playerLivePeak) {
                this.setText(this.elements.playerLivePeak, `Peak: ${peak ?? "--"}`);
            }
        } catch (error) {
            // Non-fatal
        }
    },

    /**
     * Update tower status from Icecast
     */
    async updateTowerStatus() {
        try {
            const status = await IcecastAPI.getAllTowerStatus();

            if (!status || !status.towers) {
                console.warn("[Dashboard] No tower status data available");
                return;
            }

            if (status.towers.tower3) {
                const t3 = status.towers.tower3;
                const tower3Config = CONFIG.TOWERS.tower3;
                this.recordLiveTailPoint(t3.listeners ?? 0, status.fetchedAt || Date.now());

                // Only show listener stats if configured to show live status
                if (tower3Config.showLiveStatus) {
                    this.setText(this.elements.tower3Listeners, t3.listeners ?? "--");
                    this.setText(this.elements.tower3Peak, t3.listenerPeak ?? "--");
                }
                this.setText(this.elements.tower3Np, t3.title || "(no metadata)");
                this.setText(this.elements.tower3StreamName, t3.serverName || "--");

                // Only show description if it exists and is not generic
                const desc = t3.description || "";
                if (desc && desc.toLowerCase() !== "unspecified description" && desc !== "--") {
                    this.setText(this.elements.tower3StreamDesc, desc);
                    if (this.elements.tower3DescItem) {
                        this.elements.tower3DescItem.style.display = "flex";
                    }
                } else {
                    if (this.elements.tower3DescItem) {
                        this.elements.tower3DescItem.style.display = "none";
                    }
                }

                this.setText(this.elements.totalListeners, t3.listeners ?? "--");
            }

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

            if (status.towers.tower3) {
                const title = status.towers.tower3.title || "(no metadata)";
                this.setText(this.elements.tower3Np, title);
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
            console.log("[Dashboard] loadChartData() called, range:", this.currentRange);
            const targetRange = this.currentRange;
            
            // Always prefer all-time data so Tower 3 historical derivation is available.
            const url = CONFIG.getArchiveUrl("dataAll");

            let payload;
            try {
                const response = await fetch(url, { cache: "no-store" });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                payload = await response.json();
            } catch (err) {
                console.warn("[Dashboard] all-time dataset unavailable, falling back to 24h", err?.message);
                const fallbackResponse = await fetch(CONFIG.getArchiveUrl("data24h"), { cache: "no-store" });
                if (!fallbackResponse.ok) {
                    throw new Error(`HTTP ${fallbackResponse.status}`);
                }
                payload = await fallbackResponse.json();
            }

            const hasSeries = Array.isArray(payload.series) && payload.series.some(s => Array.isArray(s.points) && s.points.length);
            if (!hasSeries) {
                console.warn("[Dashboard] chart dataset empty");
            }

            this.renderChart(payload);
            this.updateSignalHonors();

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
        
           // Filter to 2026 and later only
           const jan1_2026 = new Date(2026, 0, 1).getTime();
           const filteredByYear = points.filter(([timestamp]) => timestamp >= jan1_2026);
       
           // Then apply time range filter
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
                   return filteredByYear; // Only year filtering
           }
       
           return filteredByYear.filter(([timestamp]) => timestamp >= cutoff);
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
     * Build a timestamp->value map from a points array
     * @param {Array} points
     * @returns {Map<number, number>}
     */
    buildPointMap(points) {
        const map = new Map();
        (points || []).forEach(([ts, value]) => {
            map.set(ts, Number(value) || 0);
        });
        return map;
    },

    /**
     * Convert a point map to sorted Chart.js points
     * @param {Map<number, number>} map
     * @returns {Array<{x:number,y:number}>}
     */
    mapToDatasetPoints(map) {
        return Array.from(map.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([x, y]) => ({ x, y }));
    },

    /**
     * Record the latest Tower 3 listeners for short-term live-tail chart overlay
     * @param {number} listeners
     * @param {number} timestamp
     */
    recordLiveTailPoint(listeners, timestamp = Date.now()) {
        const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
        const value = Number.isFinite(Number(listeners)) ? Number(listeners) : 0;

        const lastPoint = this.liveTailPoints[this.liveTailPoints.length - 1];
        if (lastPoint && Math.abs(ts - lastPoint.x) < 15000) {
            lastPoint.x = ts;
            lastPoint.y = value;
        } else {
            this.liveTailPoints.push({ x: ts, y: value });
        }

        const cutoff = Date.now() - (this.liveTailWindowMinutes * 60 * 1000);
        this.liveTailPoints = this.liveTailPoints.filter((point) => point.x >= cutoff);
    },

    /**
     * Get live-tail points filtered to active range for chart rendering
     * @returns {Array<{x:number,y:number}>}
     */
    getLiveTailDatasetPoints() {
        const points = this.liveTailPoints.map((point) => [point.x, point.y]);
        return this.filterDataByRange(points).map(([x, y]) => ({ x, y }));
    },

    /**
     * Extract a named series from payload and return a timestamp->value map
     * @param {Object} payload
     * @param {string} name
     * @returns {Map<number, number>}
     */
    getSeriesMap(payload, name) {
        const series = (payload?.series || []).find((entry) => (entry.name || "").toLowerCase() === name.toLowerCase());
        return this.buildPointMap(series?.points || []);
    },

    /**
     * Build a Tower 3 historical map.
     * If explicit Tower 3 data exists, use it. Otherwise derive it as Total - (Tower1 + Tower2).
     * @param {Object} payload
     * @returns {Map<number, number>}
     */
    buildTower3HistoricalMap(payload) {
        const tower3Map = this.getSeriesMap(payload, "tower 3");
        if (tower3Map.size > 0) {
            return tower3Map;
        }

        const totalMap = this.getSeriesMap(payload, "total");
        const tower1Map = this.getSeriesMap(payload, "tower 1");
        const tower2Map = this.getSeriesMap(payload, "tower 2");
        const derivedMap = new Map();

        for (const [timestamp, totalValue] of totalMap.entries()) {
            const t1 = tower1Map.get(timestamp) || 0;
            const t2 = tower2Map.get(timestamp) || 0;
            derivedMap.set(timestamp, Math.max(0, totalValue - t1 - t2));
        }

        return derivedMap;
    },

    /**
     * Refresh the Hall of Peaks line with combined Tower 1+2 and Tower 3 record values
     */
    async updateSignalHonors() {
        if (!this.elements.signalHonors) return;

        try {
            const response = await fetch(CONFIG.getArchiveUrl("dataAll"), { cache: "no-store" });
            if (!response.ok) {
                this.setText(this.elements.signalHonors, "Hall of Peaks: unavailable");
                return;
            }

            const payload = await response.json();
            const tower1 = this.getSeriesMap(payload, "tower 1");
            const tower2 = this.getSeriesMap(payload, "tower 2");
            const tower3 = this.buildTower3HistoricalMap(payload);

            let combinedPeak = { value: 0, ts: null };
            const allCombinedTimestamps = new Set([...tower1.keys(), ...tower2.keys()]);
            for (const ts of allCombinedTimestamps) {
                const combined = (tower1.get(ts) || 0) + (tower2.get(ts) || 0);
                if (combined > combinedPeak.value) {
                    combinedPeak = { value: combined, ts };
                }
            }

            let tower3Peak = { value: 0, ts: null };
            for (const [ts, value] of tower3.entries()) {
                if (value > tower3Peak.value) {
                    tower3Peak = { value, ts };
                }
            }

            const combinedDate = combinedPeak.ts ? new Date(combinedPeak.ts).toLocaleDateString() : "--";
            const tower3Date = tower3Peak.ts ? new Date(tower3Peak.ts).toLocaleDateString() : "--";

            if (this.elements.signalPeakLegacy && this.elements.signalPeakTower3) {
                this.setText(this.elements.signalPeakLegacy, `${combinedPeak.value} listeners (${combinedDate})`);
                this.setText(this.elements.signalPeakTower3, `${tower3Peak.value} listeners (${tower3Date})`);
            } else {
                const text = `Hall of Peaks: Tower 1+2 ${combinedPeak.value} (${combinedDate}) | Tower 3 ${tower3Peak.value} (${tower3Date})`;
                this.setText(this.elements.signalHonors, text);
            }
        } catch (error) {
            if (this.elements.signalPeakLegacy && this.elements.signalPeakTower3) {
                this.setText(this.elements.signalPeakLegacy, "Unavailable");
                this.setText(this.elements.signalPeakTower3, "Unavailable");
            } else {
                this.setText(this.elements.signalHonors, "Hall of Peaks: unavailable");
            }
        }
    },

    /**
     * Render the listeners chart
     * @param {Object} payload - Chart data payload
     */
    renderChart(payload) {
        if (!this.elements.chartCanvas) return;

        const ctx = this.elements.chartCanvas.getContext("2d");

        const tower3HistoryMap = this.buildTower3HistoricalMap(payload);
        const activePoints = this.filterDataByRange(this.mapToDatasetPoints(tower3HistoryMap).map((point) => [point.x, point.y]));
        const historyHasSignal = activePoints.some(([_, y]) => Number(y) > 0);
        const liveTailOverlay = this.getLiveTailDatasetPoints();

        const datasets = [
            {
                label: "Tower 3",
                data: activePoints.map(([x, y]) => ({ x, y })),
                borderColor: CONFIG.TOWERS.tower3.color,
                backgroundColor: CONFIG.TOWERS.tower3.color,
                borderWidth: 3,
                borderDash: [],
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.24,
                fill: false
            }
        ];

        // Keep archive data as source-of-record, but show a short live overlay while archive is still zero.
        if (!historyHasSignal && liveTailOverlay.length > 0) {
            datasets.push({
                label: `Live Tail (${this.liveTailWindowMinutes}m)`,
                data: liveTailOverlay,
                borderColor: "#78f2ad",
                backgroundColor: "#78f2ad",
                borderWidth: 2,
                borderDash: [4, 4],
                pointRadius: 2,
                pointHoverRadius: 4,
                tension: 0.18,
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
                    mode: "index",
                    axis: "x",
                    intersect: false
                },
                scales: {
                    x: {
                        type: "time",
                        time: {
                            unit: this.getTimeUnit()
                        },
                        ticks: {
                            color: CONFIG.CHART_COLORS.text,
                            autoSkip: true,
                            maxRotation: 0
                        },
                        grid: { color: CONFIG.CHART_COLORS.grid }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: CONFIG.CHART_COLORS.text,
                            callback: (value) => `${value}`
                        },
                        grid: { color: CONFIG.CHART_COLORS.grid }
                    }
                },
                plugins: {
                    decimation: {
                        enabled: true,
                        algorithm: "min-max"
                    },
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
                            },
                            label: (context) => `${context.dataset.label}: ${context.parsed.y} listeners`
                        }
                    },
                    zoom: {
                        pan: {
                            enabled: true,
                            mode: "x",
                            modifierKey: "shift"
                        },
                        zoom: {
                            wheel: {
                                enabled: true
                            },
                            pinch: {
                                enabled: true
                            },
                            mode: "x"
                        },
                        limits: {
                            x: {
                                min: "original",
                                max: "original"
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
     * Update the memorial plaque's hidden reawakening state
     */
    async updateMemorialStatus() {
        if (!this.elements.memorialPlaque) return;

        try {
            const signal = await IcecastAPI.getRetiredTowerSignals();
            const nextState = signal.anyOnline ? "reawakened" : "dormant";
            this.elements.memorialPlaque.dataset.memorialState = nextState;

            if (this.elements.memorialSecret) {
                this.elements.memorialSecret.hidden = !signal.anyOnline;
            }
        } catch (error) {
            this.elements.memorialPlaque.dataset.memorialState = "dormant";
            if (this.elements.memorialSecret) {
                this.elements.memorialSecret.hidden = true;
            }
        }
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
