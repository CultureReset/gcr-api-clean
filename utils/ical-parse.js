// Minimal RFC 5545 .ics parser — enough to read the all-day VEVENT date
// ranges that Airbnb/VRBO-style calendar export feeds produce. Not a
// general-purpose iCal parser (no recurrence rules, no timezone database).

function unfoldIcs(text) {
    // Folded lines are continued on the next line starting with a space/tab
    return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function parseIcsDate(raw) {
    const m = String(raw || '').match(/(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
}

// Returns [{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' (exclusive, per RFC 5545 all-day DTEND) }]
function parseIcsEvents(icsText) {
    const unfolded = unfoldIcs(icsText);
    const events = [];
    const blocks = unfolded.split('BEGIN:VEVENT').slice(1);
    blocks.forEach(block => {
        const body = block.split('END:VEVENT')[0];
        const statusMatch = body.match(/\nSTATUS:(\S+)/);
        if (statusMatch && /CANCELLED/i.test(statusMatch[1])) return;
        const dtStartMatch = body.match(/\nDTSTART[^:\n]*:(\S+)/);
        const dtEndMatch = body.match(/\nDTEND[^:\n]*:(\S+)/);
        const start = dtStartMatch && parseIcsDate(dtStartMatch[1]);
        const end = dtEndMatch && parseIcsDate(dtEndMatch[1]);
        if (start) events.push({ start, end: end || start });
    });
    return events;
}

// Expands a [start, endExclusive) range into individual YYYY-MM-DD dates
function datesInRange(start, endExclusive) {
    const dates = [];
    let cur = new Date(start + 'T12:00:00Z');
    const end = new Date(endExclusive + 'T12:00:00Z');
    while (cur < end) {
        dates.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return dates.length ? dates : [start];
}

module.exports = { parseIcsEvents, datesInRange };
