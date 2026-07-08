// Generates an RFC 5545 .ics feed of blocked/booked dates for one GCR
// business — meant to be pasted into Airbnb/VRBO/Google Calendar's "import
// calendar" field so those platforms auto-block whatever GCR has booked.

function icalEscape(str) {
    return String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// RFC 5545 requires content lines folded at 75 octets — most consumers
// tolerate long lines, but Google Calendar and some strict parsers don't.
function foldLine(line) {
    if (line.length <= 75) return line;
    let result = line.slice(0, 75);
    let rest = line.slice(75);
    while (rest.length > 0) {
        result += '\r\n ' + rest.slice(0, 74);
        rest = rest.slice(74);
    }
    return result;
}

function toIcalDate(dateStr) {
    return String(dateStr).replace(/-/g, '');
}

function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function nowStamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}

// events: [{ uid, date_from, date_to (inclusive), summary }]
function generateAvailabilityIcs(calendarName, events) {
    const stamp = nowStamp();
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Gulf Coast Radar//Availability Feed//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:' + icalEscape(calendarName),
    ];
    events.forEach((ev, i) => {
        lines.push('BEGIN:VEVENT');
        lines.push('UID:' + (ev.uid || ('gcr-' + i + '-' + stamp)) + '@gulfcoastradar.com');
        lines.push('DTSTAMP:' + stamp);
        lines.push('DTSTART;VALUE=DATE:' + toIcalDate(ev.date_from));
        // All-day DTEND is exclusive per RFC 5545 — add a day past the last blocked date
        lines.push('DTEND;VALUE=DATE:' + toIcalDate(addDays(ev.date_to, 1)));
        lines.push('SUMMARY:' + icalEscape(ev.summary));
        lines.push('TRANSP:OPAQUE');
        lines.push('STATUS:CONFIRMED');
        lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = { generateAvailabilityIcs };
