/**
 * Nopheros Listener Dashboard - DJ Shows Configuration
 *
 * Configure DJ shows that will be overlaid on historical charts.
 * Each show is defined with a time range and metadata.
 *
 * Times should be specified in EST (America/New_York) timezone.
 * The system will automatically convert for UK London display.
 */

const DJ_SHOWS = {
    /**
     * Recurring weekly shows
     * These are matched by day of week and time
     */
    recurring: [
        {
            id: "treehab",
            name: "Treehab with DJ Nopheros",
            dj: "Nopheros",
            dayOfWeek: 1, // Monday (0=Sunday)
            startHour: 11,
            startMinute: 0,
            durationMinutes: 120, // default 2h slot
            color: "rgba(52, 152, 219, 0.25)",
            borderColor: "rgba(52, 152, 219, 0.9)"
        },
        {
            id: "living-in-the-past",
            name: "Living in the Past",
            dj: "Leto",
            dayOfWeek: 1, // Monday
            startHour: 18,
            startMinute: 0,
            durationMinutes: 120,
            color: "rgba(241, 196, 15, 0.25)",
            borderColor: "rgba(241, 196, 15, 0.9)"
        },
        {
            id: "groovin-in-the-graveyard",
            name: "Groovin' in the Graveyard",
            dj: "Crustman",
            dayOfWeek: 2, // Tuesday
            startHour: 15,
            startMinute: 0,
            durationMinutes: 120,
            color: "rgba(155, 89, 182, 0.25)",
            borderColor: "rgba(155, 89, 182, 0.9)"
        },
        {
            id: "the-whiski-lounge",
            name: "The Whiski Lounge",
            dj: "Whiski",
            dayOfWeek: 2, // Tuesday
            startHour: 21,
            startMinute: 0,
            durationMinutes: 120,
            color: "rgba(230, 126, 34, 0.25)",
            borderColor: "rgba(230, 126, 34, 0.9)"
        },
        {
            id: "deeprun-classix",
            name: "The Deeprun Classix & Mashups with Kando",
            dj: "Kando",
            dayOfWeek: 3, // Wednesday
            startHour: 16,
            startMinute: 0,
            durationMinutes: 120,
            color: "rgba(46, 204, 113, 0.25)",
            borderColor: "rgba(46, 204, 113, 0.9)"
        },
        {
            id: "pilgrim-of-the-signal",
            name: "Pilgrim of the Signal",
            dj: "Nopheros",
            dayOfWeek: 5, // Friday
            startHour: 18,
            startMinute: 0,
            durationMinutes: 120,
            color: "rgba(231, 76, 60, 0.25)",
            borderColor: "rgba(231, 76, 60, 0.9)"
        },
        {
            id: "tavern-talks",
            name: "Tavern Talks with Sheal",
            dj: "Sheal",
            dayOfWeek: 6, // Saturday
            startHour: 15,
            startMinute: 0,
            durationMinutes: 120,
            color: "rgba(26, 188, 156, 0.25)",
            borderColor: "rgba(26, 188, 156, 0.9)"
        }
    ],

    /**
     * Special one-time events
     * Define specific dates and times for special broadcasts
     * Format: YYYY-MM-DD
     */
    special: [
        // Example:
        // {
        //     id: "new-years-special-2026",
        //     name: "New Year's Eve Special",
        //     dj: "All DJs",
        //     date: "2025-12-31",
        //     startHour: 22,
        //     startMinute: 0,
        //     durationMinutes: 240,
        //     color: "rgba(255, 215, 0, 0.4)",
        //     borderColor: "rgba(255, 215, 0, 1)"
        // }
    ],

    /**
     * Get all shows that overlap with a given time range
     * @param {Date} startDate - Start of time range
     * @param {Date} endDate - End of time range
     * @param {string} timezone - 'est' or 'uk'
     * @returns {Array} Array of show instances with start/end timestamps
     */
    getShowsInRange(startDate, endDate, timezone = 'est') {
        const shows = [];
        const tzName = timezone === 'uk'
            ? CONFIG.TIMEZONES.uk.ianaName
            : CONFIG.TIMEZONES.est.ianaName;

        // Check each day in the range
        const current = new Date(startDate);
        current.setHours(0, 0, 0, 0);

        while (current <= endDate) {
            const dayOfWeek = current.getDay();

            // Check recurring shows
            for (const show of this.recurring) {
                if (show.dayOfWeek === dayOfWeek) {
                    const showStart = new Date(current);
                    showStart.setHours(show.startHour, show.startMinute, 0, 0);

                    const showEnd = new Date(showStart);
                    showEnd.setMinutes(showEnd.getMinutes() + show.durationMinutes);

                    // Only include if show overlaps with requested range
                    if (showEnd >= startDate && showStart <= endDate) {
                        shows.push({
                            ...show,
                            startTime: showStart.getTime(),
                            endTime: showEnd.getTime(),
                            startDate: showStart,
                            endDate: showEnd
                        });
                    }
                }
            }

            // Check special events
            const dateStr = current.toISOString().split('T')[0];
            for (const event of this.special) {
                if (event.date === dateStr) {
                    const eventStart = new Date(current);
                    eventStart.setHours(event.startHour, event.startMinute, 0, 0);

                    const eventEnd = new Date(eventStart);
                    eventEnd.setMinutes(eventEnd.getMinutes() + event.durationMinutes);

                    if (eventEnd >= startDate && eventStart <= endDate) {
                        shows.push({
                            ...event,
                            startTime: eventStart.getTime(),
                            endTime: eventEnd.getTime(),
                            startDate: eventStart,
                            endDate: eventEnd,
                            isSpecial: true
                        });
                    }
                }
            }

            // Move to next day
            current.setDate(current.getDate() + 1);
        }

        return shows;
    },

    /**
     * Convert Chart.js annotation format for DJ shows
     * @param {Array} shows - Array of show instances
     * @returns {Object} Chart.js annotations config
     */
    toChartAnnotations(shows) {
        const annotations = {};

        shows.forEach((show, index) => {
            annotations[`djShow${index}`] = {
                type: 'box',
                xMin: show.startTime,
                xMax: show.endTime,
                backgroundColor: show.color || CONFIG.OVERLAY_COLORS.djShow,
                borderColor: show.borderColor || CONFIG.OVERLAY_COLORS.djShowBorder,
                borderWidth: 1,
                label: {
                    display: true,
                    content: show.name,
                    position: 'start',
                    color: '#fff',
                    font: {
                        size: 10
                    }
                }
            };
        });

        return annotations;
    }
};

// Freeze configuration
Object.freeze(DJ_SHOWS.recurring);
Object.freeze(DJ_SHOWS.special);
