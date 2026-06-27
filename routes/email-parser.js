/**
 * GCR EMAIL PARSER SYSTEM
 * ========================
 * Receives booking confirmation emails from any platform via:
 *   A) BCC to gcr-[slug]@parse.yourdomain.com (Sendgrid Inbound Parse / Postmark)
 *   B) Gmail OAuth polling (future)
 *   C) Manual import (CSV/bulk)
 *
 * Parses them into a unified business_availability table so GCR can display:
 *   - Real-time spots remaining today
 *   - Last minute deals
 *   - Table seating data (for restaurants)
 *   - Appointment slots used
 *
 * TO ADD A NEW PLATFORM: add one entry to EXTRACTORS below. That's it.
 *
 * POST /api/email-parser/inbound         ← Sendgrid/Postmark webhook
 * POST /api/email-parser/manual          ← Admin manual entry
 * POST /api/email-parser/bulk-import     ← Restaurant bulk daily import (CSV/JSON)
 * GET  /api/email-parser/availability/:slug  ← Frontend reads this
 * GET  /api/email-parser/log             ← Admin views parsed emails
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../db');

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function emailHash(from, subject, text) {
  return crypto.createHash('sha256')
    .update((from||'') + (subject||'') + (text||'').slice(0, 500))
    .digest('hex');
}

// Normalize a date string to YYYY-MM-DD
function parseDate(str) {
  if (!str) return null;
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = new Date(str);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

// Normalize time to HH:MM (24hr)
function parseTime(str) {
  if (!str) return null;
  str = str.trim();
  // Already HH:MM
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  // 12-hour with AM/PM
  const m = str.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)/i);
  if (m) {
    let h = parseInt(m[1]);
    const min = m[2] ? parseInt(m[2]) : 0;
    const pm = /pm/i.test(m[3]);
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
  }
  return null;
}

// Extract entity_slug from the TO address: gcr-[slug]@parse.domain.com
function slugFromTo(toAddress) {
  if (!toAddress) return null;
  const m = (toAddress || '').match(/gcr-([a-z0-9-]+)@/i);
  return m ? m[1] : null;
}

// ─── EXTRACTOR REGISTRY ───────────────────────────────────────────────────────
// Each extractor:
//   detect(from, subject, text, html) → true/false
//   extract(from, subject, text, html) → ParsedBooking | null
//
// ParsedBooking shape:
// {
//   platform        string   fareharbor | peekpro | boatbooker | airbnb | vrbo |
//                            booking_com | opentable | resy | toast | vagaro |
//                            mindbody | square | honeybook | acuity | calendly |
//                            viator | getyourguide | generic
//   booking_type    string   charter | tour | rental | accommodation |
//                            restaurant | appointment | photo_session
//   event_date      string   YYYY-MM-DD
//   event_time      string   HH:MM (24hr)  optional
//   end_time        string   HH:MM (24hr)  optional
//   duration_hours  number   optional
//   party_size      number   guests / passengers / people
//   customer_name   string   optional
//   activity_name   string   what was booked (trip name, service name etc)
//   table_number    string   for restaurants optional
//   seated_time     string   HH:MM when they sat down
//   left_time       string   HH:MM when they left
//   confirmation_no string   booking reference
//   status          string   confirmed | cancelled | modified
//   notes           string   any extra useful info
// }

const EXTRACTORS = [

  // ── FAREHARBOR ──────────────────────────────────────────────────────────────
  {
    name: 'fareharbor',
    detect: (from, subject) =>
      /@fareharbor\.com/i.test(from) ||
      /fareharbor/i.test(subject),
    extract: (from, subject, text) => {
      // FareHarbor email: "New Booking: [Activity] on [Date] at [Time]"
      // "Booking Confirmation #12345 — Dolphin Cruise (6 guests)"
      const dateM = text.match(/(?:Date|Trip Date|Tour Date)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i);
      const timeM = text.match(/(?:Time|Departure|Start Time)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const guestM = text.match(/(?:Guests?|Passengers?|Participants?|Party Size)[:\s]+(\d+)/i);
      const nameM = text.match(/(?:Customer|Guest|Name)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/);
      const actM = subject.match(/(?:New Booking|Booking Confirmation)[:\s–-]+([^(#\n]+)/i);
      const confM = text.match(/(?:Booking|Confirmation|Order)\s*#?:?\s*([A-Z0-9]{4,12})/i);
      const cancelM = /cancel/i.test(subject) || /cancel/i.test(text.slice(0,200));
      return {
        platform: 'fareharbor',
        booking_type: 'tour',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        customer_name: nameM ? nameM[1] : null,
        activity_name: actM ? actM[1].trim() : null,
        confirmation_no: confM ? confM[1] : null,
        status: cancelM ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── PEEK PRO ────────────────────────────────────────────────────────────────
  {
    name: 'peekpro',
    detect: (from, subject) =>
      /@peekpro\.com/i.test(from) ||
      /@peek\.com/i.test(from) ||
      /peekpro|peek pro/i.test(subject),
    extract: (from, subject, text) => {
      const dateM = text.match(/(?:Date|Activity Date)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
      const timeM = text.match(/(?:Time|Start)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const guestM = text.match(/(?:Guests?|Qty|Quantity|Tickets?)[:\s]+(\d+)/i);
      const actM = text.match(/Activity[:\s]+([^\n]+)/i) || subject.match(/Booking[:\s–]+([^\n(]+)/i);
      const confM = text.match(/(?:Order|Booking|Confirmation)\s*#?:?\s*([A-Z0-9]{5,15})/i);
      const cancelM = /cancel/i.test(subject);
      return {
        platform: 'peekpro',
        booking_type: 'tour',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: actM ? actM[1].trim() : null,
        confirmation_no: confM ? confM[1] : null,
        status: cancelM ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── BOATBOOKER ──────────────────────────────────────────────────────────────
  {
    name: 'boatbooker',
    detect: (from, subject) =>
      /@boatbooker\.com/i.test(from) ||
      /boatbooker/i.test(subject),
    extract: (from, subject, text) => {
      const dateM = text.match(/(?:Rental Date|Date)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
      const timeM = text.match(/(?:Start|Pickup|Departure)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const endM  = text.match(/(?:End|Return|Drop.?off)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const guestM = text.match(/(?:Passengers?|Guests?|Party)[:\s]+(\d+)/i);
      const boatM = text.match(/(?:Boat|Vessel|Craft)[:\s]+([^\n]+)/i);
      const confM = text.match(/(?:Booking|Reservation|Ref)\s*#?:?\s*([A-Z0-9]{4,12})/i);
      return {
        platform: 'boatbooker',
        booking_type: 'rental',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        end_time: endM ? parseTime(endM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: boatM ? boatM[1].trim() : 'Boat Rental',
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── WAVEREZ ─────────────────────────────────────────────────────────────────
  {
    name: 'waverez',
    detect: (from, subject) =>
      /@waverez\.com/i.test(from) ||
      /waverez/i.test(subject),
    extract: (from, subject, text) => {
      const dateM = text.match(/Date[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
      const timeM = text.match(/Time[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const guestM = text.match(/(?:Guests?|Riders?|Participants?)[:\s]+(\d+)/i);
      const actM = text.match(/Activity[:\s]+([^\n]+)/i);
      const confM = text.match(/(?:Booking|Reservation)\s*#?:?\s*([A-Z0-9]+)/i);
      return {
        platform: 'waverez',
        booking_type: 'tour',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: actM ? actM[1].trim() : null,
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── REZDY ───────────────────────────────────────────────────────────────────
  {
    name: 'rezdy',
    detect: (from, subject) =>
      /@rezdy\.com/i.test(from) ||
      /rezdy/i.test(subject),
    extract: (from, subject, text) => {
      const dateM = text.match(/(?:Date|Session Date)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
      const timeM = text.match(/(?:Time|Start)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const guestM = text.match(/(?:Qty|Quantity|Participants?|Guests?)[:\s]+(\d+)/i);
      const actM = text.match(/(?:Product|Tour|Activity)[:\s]+([^\n]+)/i);
      const confM = text.match(/(?:Order|Booking)\s*#?:?\s*([A-Z0-9]+)/i);
      return {
        platform: 'rezdy',
        booking_type: 'tour',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: actM ? actM[1].trim() : null,
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── BOKUN ───────────────────────────────────────────────────────────────────
  {
    name: 'bokun',
    detect: (from, subject) =>
      /@bokun\.io/i.test(from) ||
      /@bokun\.com/i.test(from) ||
      /bokun/i.test(subject),
    extract: (from, subject, text) => {
      const dateM = text.match(/(?:Date|Start Date)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
      const timeM = text.match(/(?:Time|Start Time)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const guestM = text.match(/(?:Passengers?|Participants?|Guests?)[:\s]+(\d+)/i);
      const actM = text.match(/(?:Product|Booking)[:\s]+([^\n(]+)/i);
      const confM = text.match(/(?:Booking|Confirmation)\s*#?:?\s*([A-Z0-9]+)/i);
      return {
        platform: 'bokun',
        booking_type: 'tour',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: actM ? actM[1].trim() : null,
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── VIATOR / TRIPADVISOR EXPERIENCES ────────────────────────────────────────
  {
    name: 'viator',
    detect: (from, subject) =>
      /@viator\.com/i.test(from) ||
      /@tripadvisor\.com/i.test(from) ||
      /viator|tripadvisor experiences/i.test(subject),
    extract: (from, subject, text) => {
      const dateM = text.match(/(?:Date|Experience Date)[:\s]+([A-Za-z]+ \d+,? \d{4})/i);
      const timeM = text.match(/(?:Time|Start)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const guestM = text.match(/(?:Travelers?|Guests?|Participants?)[:\s]+(\d+)/i);
      const actM = text.match(/Experience[:\s]+([^\n]+)/i) || subject.match(/booking[:\s]+([^\n]+)/i);
      const confM = text.match(/(?:Booking|Ref|Order)\s*#?:?\s*([A-Z0-9]+)/i);
      return {
        platform: 'viator',
        booking_type: 'tour',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: actM ? actM[1].trim() : null,
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── GETYOURGUIDE ────────────────────────────────────────────────────────────
  {
    name: 'getyourguide',
    detect: (from, subject) =>
      /@getyourguide\.com/i.test(from) ||
      /getyourguide|get your guide/i.test(subject),
    extract: (from, subject, text) => {
      const dateM = text.match(/(?:Date|Activity Date)[:\s]+([A-Za-z]+ \d+,? \d{4})/i);
      const timeM = text.match(/(?:Time|Start)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const guestM = text.match(/(?:Participants?|Travelers?)[:\s]+(\d+)/i);
      const actM = text.match(/(?:Activity|Tour)[:\s]+([^\n]+)/i);
      const confM = text.match(/(?:Booking|Order)\s*#?:?\s*([A-Z0-9]+)/i);
      return {
        platform: 'getyourguide',
        booking_type: 'tour',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: actM ? actM[1].trim() : null,
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── AIRBNB ──────────────────────────────────────────────────────────────────
  {
    name: 'airbnb',
    detect: (from, subject) =>
      /@airbnb\.com/i.test(from) ||
      /airbnb/i.test(subject),
    extract: (from, subject, text) => {
      const checkinM  = text.match(/(?:Check.?in|Arrival)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
      const checkoutM = text.match(/(?:Check.?out|Departure)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
      const guestM    = text.match(/(?:Guests?)[:\s]+(\d+)/i);
      const listingM  = text.match(/(?:Property|Listing|Place)[:\s]+([^\n]+)/i);
      const confM     = text.match(/(?:Confirmation|Reservation)\s*#?:?\s*([A-Z0-9]+)/i);
      return {
        platform: 'airbnb',
        booking_type: 'accommodation',
        event_date: checkinM ? parseDate(checkinM[1]) : null,
        end_date: checkoutM ? parseDate(checkoutM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: listingM ? listingM[1].trim() : 'Airbnb Rental',
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── VRBO ────────────────────────────────────────────────────────────────────
  {
    name: 'vrbo',
    detect: (from, subject) =>
      /@vrbo\.com/i.test(from) ||
      /@homeaway\.com/i.test(from) ||
      /vrbo|homeaway/i.test(subject),
    extract: (from, subject, text) => {
      const checkinM  = text.match(/(?:Check.?in|Arrival)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
      const checkoutM = text.match(/(?:Check.?out|Departure)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
      const guestM    = text.match(/(?:Guests?|Travelers?)[:\s]+(\d+)/i);
      const propM     = text.match(/(?:Property|Rental)[:\s]+([^\n]+)/i);
      const confM     = text.match(/(?:Booking|Reservation|Ref)\s*#?:?\s*([A-Z0-9]+)/i);
      return {
        platform: 'vrbo',
        booking_type: 'accommodation',
        event_date: checkinM ? parseDate(checkinM[1]) : null,
        end_date: checkoutM ? parseDate(checkoutM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: propM ? propM[1].trim() : 'VRBO Rental',
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── BOOKING.COM ─────────────────────────────────────────────────────────────
  {
    name: 'booking_com',
    detect: (from, subject) =>
      /@booking\.com/i.test(from) ||
      /booking\.com/i.test(subject),
    extract: (from, subject, text) => {
      const checkinM  = text.match(/(?:Check.?in|Arrival)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
      const checkoutM = text.match(/(?:Check.?out|Departure)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i);
      const guestM    = text.match(/(?:Guests?|Rooms?)[:\s]+(\d+)/i);
      const confM     = text.match(/(?:Booking|PIN|Reservation)\s*#?:?\s*([0-9]{6,12})/i);
      return {
        platform: 'booking_com',
        booking_type: 'accommodation',
        event_date: checkinM ? parseDate(checkinM[1]) : null,
        end_date: checkoutM ? parseDate(checkoutM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: null,
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── OPENTABLE ───────────────────────────────────────────────────────────────
  {
    name: 'opentable',
    detect: (from, subject) =>
      /@opentable\.com/i.test(from) ||
      /opentable/i.test(subject),
    extract: (from, subject, text) => {
      const dateM  = text.match(/(?:Date|Reservation)[:\s]+([A-Za-z]+,? [A-Za-z]+ \d+,? \d{4}|[A-Za-z]+ \d+,? \d{4})/i);
      const timeM  = text.match(/(?:Time)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const guestM = text.match(/(?:Party Size|Guests?|Diners?)[:\s]+(\d+)/i);
      const confM  = text.match(/(?:Confirmation|Reservation)\s*#?:?\s*([A-Z0-9]+)/i);
      return {
        platform: 'opentable',
        booking_type: 'restaurant',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: 'Restaurant Reservation',
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── RESY ────────────────────────────────────────────────────────────────────
  {
    name: 'resy',
    detect: (from, subject) =>
      /@resy\.com/i.test(from) ||
      /resy/i.test(subject),
    extract: (from, subject, text) => {
      const dateM  = text.match(/(?:Date)[:\s]+([A-Za-z]+,? [A-Za-z]+ \d+,? \d{4})/i);
      const timeM  = text.match(/(?:Time)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const guestM = text.match(/(?:Party|Guests?)[:\s]+(\d+)/i);
      const confM  = text.match(/(?:Confirmation|Resy|Ref)\s*#?:?\s*([A-Z0-9]+)/i);
      return {
        platform: 'resy',
        booking_type: 'restaurant',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: 'Restaurant Reservation',
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── TOAST POS (table seating data) ──────────────────────────────────────────
  {
    name: 'toast',
    detect: (from, subject) =>
      /@toasttab\.com/i.test(from) ||
      /toast\s*(?:tab|pos|restaurant)/i.test(subject),
    extract: (from, subject, text) => {
      // Toast sends daily/shift reports with table data
      // "Table 12 | Party of 4 | Seated: 6:45 PM | Left: 8:22 PM"
      const tableM   = text.match(/Table\s*#?:?\s*(\w+)/i);
      const guestM   = text.match(/(?:Party of|Guests?|Covers?)[:\s]+(\d+)/i);
      const seatedM  = text.match(/(?:Seated|Arrived|In)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const leftM    = text.match(/(?:Left|Departed|Out|Closed)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const dateM    = text.match(/(?:Date|Day)[:\s]+([A-Za-z]+ \d+,? \d{4}|\d{4}-\d{2}-\d{2})/i)
                    || subject.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      return {
        platform: 'toast',
        booking_type: 'restaurant',
        event_date: dateM ? parseDate(dateM[1]) : parseDate(new Date().toISOString().slice(0,10)),
        table_number: tableM ? tableM[1] : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        seated_time: seatedM ? parseTime(seatedM[1]) : null,
        left_time: leftM ? parseTime(leftM[1]) : null,
        activity_name: 'Table Seating',
        status: 'confirmed',
      };
    }
  },

  // ── VAGARO (salons, spas, massage) ──────────────────────────────────────────
  {
    name: 'vagaro',
    detect: (from, subject) =>
      /@vagaro\.com/i.test(from) ||
      /vagaro/i.test(subject),
    extract: (from, subject, text) => {
      const dateM  = text.match(/(?:Date|Appointment)[:\s]+([A-Za-z]+,? [A-Za-z]+ \d+,? \d{4})/i);
      const timeM  = text.match(/(?:Time|At)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const serviceM = text.match(/(?:Service|Appointment)[:\s]+([^\n]+)/i);
      const staffM   = text.match(/(?:With|Provider|Stylist|Therapist)[:\s]+([A-Z][a-z]+ ?[A-Z]?[a-z]*)/);
      const confM    = text.match(/(?:Confirmation|Booking|Appt)\s*#?:?\s*([A-Z0-9]+)/i);
      return {
        platform: 'vagaro',
        booking_type: 'appointment',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: 1,
        activity_name: serviceM ? serviceM[1].trim() : 'Appointment',
        notes: staffM ? `With ${staffM[1]}` : null,
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── MINDBODY (gyms, yoga, wellness, massage) ─────────────────────────────────
  {
    name: 'mindbody',
    detect: (from, subject) =>
      /@mindbodyonline\.com/i.test(from) ||
      /mindbody/i.test(subject),
    extract: (from, subject, text) => {
      const dateM    = text.match(/(?:Date|Session)[:\s]+([A-Za-z]+,? [A-Za-z]+ \d+,? \d{4})/i);
      const timeM    = text.match(/(?:Time|Class Start)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const classM   = text.match(/(?:Class|Service|Session)[:\s]+([^\n]+)/i);
      const guestM   = text.match(/(?:Clients?|Guests?)[:\s]+(\d+)/i);
      return {
        platform: 'mindbody',
        booking_type: 'appointment',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : 1,
        activity_name: classM ? classM[1].trim() : 'Class/Session',
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── SQUARE APPOINTMENTS ──────────────────────────────────────────────────────
  {
    name: 'square',
    detect: (from, subject) =>
      /@squareup\.com/i.test(from) ||
      /square\s*appointment/i.test(subject),
    extract: (from, subject, text) => {
      const dateM    = text.match(/(?:Date|Appointment Date)[:\s]+([A-Za-z]+,? [A-Za-z]+ \d+,? \d{4})/i);
      const timeM    = text.match(/(?:Time)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const serviceM = text.match(/(?:Service|Appointment)[:\s]+([^\n]+)/i);
      const confM    = text.match(/(?:Confirmation)\s*#?:?\s*([A-Z0-9]+)/i);
      return {
        platform: 'square',
        booking_type: 'appointment',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: 1,
        activity_name: serviceM ? serviceM[1].trim() : 'Appointment',
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── HONEYBOOK (photographers, event planners, creatives) ─────────────────────
  {
    name: 'honeybook',
    detect: (from, subject) =>
      /@honeybook\.com/i.test(from) ||
      /honeybook/i.test(subject),
    extract: (from, subject, text) => {
      const dateM    = text.match(/(?:Session Date|Event Date|Date)[:\s]+([A-Za-z]+,? [A-Za-z]+ \d+,? \d{4})/i);
      const timeM    = text.match(/(?:Time|Session Time)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const sessionM = text.match(/(?:Session|Package|Project)[:\s]+([^\n]+)/i);
      const clientM  = text.match(/(?:Client|Name)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/);
      return {
        platform: 'honeybook',
        booking_type: 'photo_session',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: 1,
        activity_name: sessionM ? sessionM[1].trim() : 'Photo Session',
        customer_name: clientM ? clientM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── ACUITY SCHEDULING (photographers, consultants) ───────────────────────────
  {
    name: 'acuity',
    detect: (from, subject) =>
      /@acuityscheduling\.com/i.test(from) ||
      /acuity\s*scheduling/i.test(subject),
    extract: (from, subject, text) => {
      const dateM    = text.match(/(?:Date|Appointment)[:\s]+([A-Za-z]+,? [A-Za-z]+ \d+(?:st|nd|rd|th)?,? \d{4})/i);
      const timeM    = text.match(/(?:Time|At)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const typeM    = text.match(/(?:Type|Appointment Type|Service)[:\s]+([^\n]+)/i);
      const clientM  = text.match(/(?:Name|Client)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/);
      const confM    = text.match(/(?:Confirmation|ID)\s*#?:?\s*([0-9]+)/i);
      return {
        platform: 'acuity',
        booking_type: 'appointment',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: 1,
        activity_name: typeM ? typeM[1].trim() : 'Appointment',
        customer_name: clientM ? clientM[1] : null,
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── CALENDLY ────────────────────────────────────────────────────────────────
  {
    name: 'calendly',
    detect: (from, subject) =>
      /@calendly\.com/i.test(from) ||
      /calendly/i.test(subject),
    extract: (from, subject, text) => {
      const dateM    = text.match(/([A-Za-z]+,? [A-Za-z]+ \d+,? \d{4})/i);
      const timeM    = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const eventM   = text.match(/(?:Event|Meeting)[:\s]+([^\n]+)/i) || subject.match(/Calendly:\s*([^\n]+)/i);
      return {
        platform: 'calendly',
        booking_type: 'appointment',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        end_time: timeM ? parseTime(timeM[2]) : null,
        party_size: 1,
        activity_name: eventM ? eventM[1].trim() : 'Appointment',
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── BOOKSY (barbers, salons) ─────────────────────────────────────────────────
  {
    name: 'booksy',
    detect: (from, subject) =>
      /@booksy\.com/i.test(from) ||
      /booksy/i.test(subject),
    extract: (from, subject, text) => {
      const dateM    = text.match(/(?:Date)[:\s]+([A-Za-z]+,? [A-Za-z]+ \d+,? \d{4})/i);
      const timeM    = text.match(/(?:Time)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const serviceM = text.match(/(?:Service)[:\s]+([^\n]+)/i);
      return {
        platform: 'booksy',
        booking_type: 'appointment',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: 1,
        activity_name: serviceM ? serviceM[1].trim() : 'Appointment',
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── GLOSSGENIUS (beauty pros) ─────────────────────────────────────────────────
  {
    name: 'glossgenius',
    detect: (from, subject) =>
      /@glossgenius\.com/i.test(from) ||
      /glossgenius/i.test(subject),
    extract: (from, subject, text) => {
      const dateM    = text.match(/([A-Za-z]+,? [A-Za-z]+ \d+,? \d{4})/i);
      const timeM    = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const serviceM = text.match(/(?:Service|Appointment)[:\s]+([^\n]+)/i);
      return {
        platform: 'glossgenius',
        booking_type: 'appointment',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: 1,
        activity_name: serviceM ? serviceM[1].trim() : 'Appointment',
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── YELP RESERVATIONS ───────────────────────────────────────────────────────
  {
    name: 'yelp',
    detect: (from, subject) =>
      /@yelp\.com/i.test(from) ||
      /yelp\s*reservation/i.test(subject),
    extract: (from, subject, text) => {
      const dateM  = text.match(/(?:Date)[:\s]+([A-Za-z]+,? [A-Za-z]+ \d+,? \d{4})/i);
      const timeM  = text.match(/(?:Time)[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const guestM = text.match(/(?:Party|Guests?)[:\s]+(\d+)/i);
      return {
        platform: 'yelp',
        booking_type: 'restaurant',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        activity_name: 'Restaurant Reservation',
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

  // ── GENERIC FALLBACK ─────────────────────────────────────────────────────────
  // Catches any booking/confirmation email not matched above
  {
    name: 'generic',
    detect: (from, subject) =>
      /booking|reservation|confirmation|appointment|scheduled/i.test(subject),
    extract: (from, subject, text) => {
      // Try common patterns across any format
      const dateM    = text.match(/(\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/i);
      const timeM    = text.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i);
      const guestM   = text.match(/\b(\d+)\s+(?:guests?|people|passengers?|party|diners?|participants?)/i);
      const confM    = text.match(/(?:#|no\.?|number)[:\s]*([A-Z0-9]{4,15})/i);
      const tableM   = text.match(/table\s*#?:?\s*(\w+)/i);
      const seatedM  = text.match(/seated[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      const leftM    = text.match(/left[:\s]+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      return {
        platform: 'generic',
        booking_type: tableM ? 'restaurant' : 'tour',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        table_number: tableM ? tableM[1] : null,
        seated_time: seatedM ? parseTime(seatedM[1]) : null,
        left_time: leftM ? parseTime(leftM[1]) : null,
        activity_name: null,
        confirmation_no: confM ? confM[1] : null,
        status: /cancel/i.test(subject) ? 'cancelled' : 'confirmed',
      };
    }
  },

]; // end EXTRACTORS

// Run through all extractors, return first match
function detectAndExtract(from, subject, text, html) {
  const content = text || html || '';
  for (const ext of EXTRACTORS) {
    if (ext.detect(from, subject, content)) {
      try {
        const result = ext.extract(from, subject, content, html || '');
        if (result) return { extractor: ext.name, ...result };
      } catch (e) {
        console.warn(`[email-parser] Extractor ${ext.name} threw:`, e.message);
      }
    }
  }
  return null;
}

// ─── WRITE TO business_availability ──────────────────────────────────────────

async function upsertAvailability(entitySlug, parsed, emailLogId) {
  if (!entitySlug || !parsed.event_date) return;

  // Fetch business capacity config
  const { data: cap } = await db
    .from('entity')
    .select('daily_capacity, capacity_per_slot')
    .eq('slug', entitySlug)
    .maybeSingle();

  const totalCapacity = cap?.daily_capacity || null;

  // Count confirmed bookings for this date
  const { data: existing } = await db
    .from('business_availability')
    .select('id, booked_count, total_capacity')
    .eq('entity_slug', entitySlug)
    .eq('availability_date', parsed.event_date)
    .eq('time_slot', parsed.event_time || '00:00')
    .maybeSingle();

  const partySize  = parsed.party_size || 1;
  const isCancelled = parsed.status === 'cancelled';

  if (existing) {
    const newBooked = isCancelled
      ? Math.max(0, (existing.booked_count || 0) - partySize)
      : (existing.booked_count || 0) + partySize;

    const tc = existing.total_capacity || totalCapacity;
    const remaining = tc ? Math.max(0, tc - newBooked) : null;
    const status = !tc ? 'unknown'
      : remaining === 0 ? 'full'
      : remaining <= 3 ? 'limited'
      : 'available';

    await db
      .from('business_availability')
      .update({
        booked_count: newBooked,
        remaining_spots: remaining,
        status,
        last_updated: new Date().toISOString(),
        last_email_log_id: emailLogId,
      })
      .eq('id', existing.id);
  } else if (!isCancelled) {
    const remaining = totalCapacity ? Math.max(0, totalCapacity - partySize) : null;
    const status = !totalCapacity ? 'unknown'
      : remaining === 0 ? 'full'
      : remaining <= 3 ? 'limited'
      : 'available';

    await db
      .from('business_availability')
      .insert({
        entity_slug: entitySlug,
        availability_date: parsed.event_date,
        time_slot: parsed.event_time || null,
        end_time: parsed.end_time || null,
        total_capacity: totalCapacity,
        booked_count: partySize,
        remaining_spots: remaining,
        status,
        booking_type: parsed.booking_type,
        source_platform: parsed.platform,
        last_updated: new Date().toISOString(),
        last_email_log_id: emailLogId,
      });
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/**
 * POST /api/email-parser/inbound
 * Sendgrid Inbound Parse / Postmark webhook
 * Body (urlencoded or JSON): from, to, subject, text, html
 */
router.post('/inbound', express.urlencoded({ extended: false }), async (req, res) => {
  // Always return 200 fast so webhook doesn't retry
  res.status(200).json({ received: true });

  try {
    const from    = req.body.from    || req.body.From    || '';
    const to      = req.body.to      || req.body.To      || '';
    const subject = req.body.subject || req.body.Subject || '';
    const text    = req.body.text    || req.body.Text    || '';
    const html    = req.body.html    || req.body.Html    || '';

    const hash = emailHash(from, subject, text);

    // Dedup check
    const { data: dupe } = await db
      .from('email_parser_log')
      .select('id')
      .eq('email_hash', hash)
      .maybeSingle();

    if (dupe) return; // already processed

    // Determine entity slug from TO address
    const entitySlug = slugFromTo(to);

    // Parse
    const parsed = detectAndExtract(from, subject, text, html);

    // Log it
    const { data: logRow } = await db
      .from('email_parser_log')
      .insert({
        entity_slug: entitySlug,
        from_email: from,
        to_email: to,
        subject,
        raw_text: text.slice(0, 5000),
        platform: parsed?.platform || 'unknown',
        booking_type: parsed?.booking_type || null,
        event_date: parsed?.event_date || null,
        event_time: parsed?.event_time || null,
        end_time: parsed?.end_time || null,
        party_size: parsed?.party_size || null,
        customer_name: parsed?.customer_name || null,
        activity_name: parsed?.activity_name || null,
        table_number: parsed?.table_number || null,
        seated_time: parsed?.seated_time || null,
        left_time: parsed?.left_time || null,
        confirmation_no: parsed?.confirmation_no || null,
        status: parsed?.status || 'unknown',
        parsed: !!parsed,
        email_hash: hash,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    // Update availability
    if (entitySlug && parsed && parsed.event_date) {
      await upsertAvailability(entitySlug, parsed, logRow?.id);
    }

  } catch (err) {
    console.error('[email-parser] inbound error:', err.message);
  }
});

/**
 * POST /api/email-parser/manual
 * Admin manually enters a booking (when a business calls in / texts)
 * Body: { entity_slug, platform, booking_type, event_date, event_time,
 *         party_size, activity_name, table_number, seated_time, left_time,
 *         status, notes }
 */
router.post('/manual', async (req, res) => {
  try {
    const {
      entity_slug, platform = 'manual', booking_type = 'tour',
      event_date, event_time, end_time, party_size,
      customer_name, activity_name, table_number, seated_time,
      left_time, confirmation_no, status = 'confirmed', notes,
    } = req.body;

    if (!entity_slug || !event_date) {
      return res.status(400).json({ error: 'entity_slug and event_date required' });
    }

    const parsed = {
      platform, booking_type, event_date: parseDate(event_date),
      event_time: event_time ? parseTime(event_time) : null,
      end_time: end_time ? parseTime(end_time) : null,
      party_size: party_size ? parseInt(party_size) : 1,
      customer_name, activity_name, table_number,
      seated_time: seated_time ? parseTime(seated_time) : null,
      left_time: left_time ? parseTime(left_time) : null,
      confirmation_no, status, notes,
    };

    const { data: logRow } = await db
      .from('email_parser_log')
      .insert({ entity_slug, platform, ...parsed, parsed: true, manual: true, created_at: new Date().toISOString() })
      .select('id').single();

    await upsertAvailability(entity_slug, parsed, logRow?.id);

    res.json({ success: true, parsed, log_id: logRow?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/email-parser/bulk-import
 * Restaurant or business sends a bulk daily report
 * Accepts JSON array of seating/booking records
 * [{ table_number, party_size, seated_time, left_time, event_date }, ...]
 */
router.post('/bulk-import', async (req, res) => {
  try {
    const { entity_slug, records, booking_type = 'restaurant', event_date } = req.body;

    if (!entity_slug || !Array.isArray(records)) {
      return res.status(400).json({ error: 'entity_slug and records[] required' });
    }

    const results = [];
    const today = event_date || new Date().toISOString().slice(0,10);

    for (const rec of records) {
      const parsed = {
        platform: rec.platform || 'bulk',
        booking_type,
        event_date: parseDate(rec.event_date || rec.date || today),
        event_time: rec.event_time ? parseTime(rec.event_time) : (rec.seated_time ? parseTime(rec.seated_time) : null),
        end_time: rec.end_time ? parseTime(rec.end_time) : (rec.left_time ? parseTime(rec.left_time) : null),
        party_size: rec.party_size || rec.covers || rec.guests || 1,
        table_number: rec.table_number || rec.table || null,
        seated_time: rec.seated_time ? parseTime(rec.seated_time) : null,
        left_time: rec.left_time ? parseTime(rec.left_time) : null,
        customer_name: rec.customer_name || rec.name || null,
        activity_name: rec.activity_name || rec.service || null,
        confirmation_no: rec.confirmation_no || rec.ticket || null,
        status: rec.status || 'confirmed',
      };

      const { data: logRow } = await db
        .from('email_parser_log')
        .insert({ entity_slug, ...parsed, parsed: true, bulk: true, created_at: new Date().toISOString() })
        .select('id').single();

      await upsertAvailability(entity_slug, parsed, logRow?.id);
      results.push({ ok: true, log_id: logRow?.id, table: parsed.table_number, date: parsed.event_date });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/email-parser/availability/:slug
 * Frontend reads real-time availability for a business
 * Returns today + next 14 days of availability data
 */
router.get('/availability/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const today = new Date().toISOString().slice(0,10);
    const future = new Date(Date.now() + 14 * 86400000).toISOString().slice(0,10);

    const { data, error } = await db
      .from('business_availability')
      .select('*')
      .eq('entity_slug', slug)
      .gte('availability_date', today)
      .lte('availability_date', future)
      .order('availability_date')
      .order('time_slot');

    if (error) return res.status(500).json({ error: error.message });

    // Also get today's seating detail for restaurants
    const { data: todaySeating } = await db
      .from('email_parser_log')
      .select('table_number, party_size, seated_time, left_time, event_time, customer_name, activity_name, status')
      .eq('entity_slug', slug)
      .eq('event_date', today)
      .order('seated_time');

    res.json({
      entity_slug: slug,
      today,
      availability: data || [],
      today_detail: todaySeating || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/email-parser/log
 * Admin: view all parsed emails with filters
 * Query: ?entity_slug=x&date=x&platform=x&status=x&limit=50
 */
router.get('/log', async (req, res) => {
  try {
    const { entity_slug, date, platform, status, limit = 100, offset = 0 } = req.query;

    let q = db
      .from('email_parser_log')
      .select('*')
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (entity_slug) q = q.eq('entity_slug', entity_slug);
    if (date)        q = q.eq('event_date', date);
    if (platform)    q = q.eq('platform', platform);
    if (status)      q = q.eq('status', status);

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ total: count, logs: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/email-parser/platforms
 * Returns list of all supported platforms (for admin UI)
 */
router.get('/platforms', (req, res) => {
  res.json({
    platforms: EXTRACTORS.map(e => ({
      name: e.name,
      description: PLATFORM_DESCRIPTIONS[e.name] || e.name,
    }))
  });
});

const PLATFORM_DESCRIPTIONS = {
  fareharbor:   'FareHarbor — fishing charters, dolphin tours, watersports',
  peekpro:      'Peek Pro — boat rentals, tours, activities',
  boatbooker:   'BoatBooker — boat rentals',
  waverez:      'WaveRez — marine & watersports',
  rezdy:        'Rezdy — tour operators',
  bokun:        'Bókun — tours with TripAdvisor/Viator distribution',
  viator:       'Viator / TripAdvisor Experiences — OTA bookings',
  getyourguide: 'GetYourGuide — OTA bookings',
  airbnb:       'Airbnb — vacation rentals & condos',
  vrbo:         'VRBO / HomeAway — vacation rentals',
  booking_com:  'Booking.com — hotels & accommodations',
  opentable:    'OpenTable — restaurant reservations',
  resy:         'Resy — restaurant reservations',
  toast:        'Toast POS — table seating data & restaurant orders',
  vagaro:       'Vagaro — salons, spas, massage',
  mindbody:     'MindBody — gyms, yoga, wellness',
  square:       'Square Appointments — salons, barbers, photographers',
  honeybook:    'HoneyBook — photographers, event planners',
  acuity:       'Acuity Scheduling — photographers, consultants',
  calendly:     'Calendly — general appointments',
  booksy:       'Booksy — barbers & salons',
  glossgenius:  'GlossGenius — beauty professionals',
  yelp:         'Yelp Reservations — restaurant reservations',
  generic:      'Generic — any booking/confirmation email',
};

module.exports = router;
module.exports.EXTRACTORS = EXTRACTORS; // exported for testing
