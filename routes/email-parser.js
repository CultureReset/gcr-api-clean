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
      // Restaurant-side notifications name the diner — that's the customer
      // relationship the business gets to keep
      const nameM  = text.match(/(?:Guest|Diner|Name|Reservation for)[: \t]+([A-Z][A-Za-z'’.-]+(?:[ \t]+[A-Z][A-Za-z'’.-]+){1,2})/);
      return {
        platform: 'opentable',
        booking_type: 'restaurant',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        customer_name: nameM ? nameM[1] : null,
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
      const nameM  = text.match(/(?:Guest|Diner|Name|Reservation for)[: \t]+([A-Z][A-Za-z'’.-]+(?:[ \t]+[A-Z][A-Za-z'’.-]+){1,2})/);
      return {
        platform: 'resy',
        booking_type: 'restaurant',
        event_date: dateM ? parseDate(dateM[1]) : null,
        event_time: timeM ? parseTime(timeM[1]) : null,
        party_size: guestM ? parseInt(guestM[1]) : null,
        customer_name: nameM ? nameM[1] : null,
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

// Auto-create a last_minute deal when availability hits critical thresholds
async function maybeCreateAutoDeal(entitySlug, date, remaining, total, timeSlot, parsed) {
  const today    = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (date !== today && date !== tomorrow) return; // only today / tomorrow

  // Only create deals for limited spots (not full, not plenty)
  if (remaining === null || remaining <= 0 || remaining > 5) return;

  // Check if an auto deal already exists for this entity/date/slot
  const slotKey = timeSlot || '00:00';
  const { data: existing } = await db
    .from('gcr_deals')
    .select('id, spots_remaining')
    .eq('entity_slug', entitySlug)
    .eq('valid_date', date)
    .eq('source', 'email_parser')
    .maybeSingle();

  // Fetch entity info for the deal card
  const { data: ent } = await db
    .from('entity')
    .select('name, entity_type, entity_subtype, hero_image_url, phone, booking_url, price_from, price_unit')
    .eq('slug', entitySlug)
    .maybeSingle();

  if (!ent) return;

  const isToday    = date === today;
  const isCharter  = (ent.entity_subtype || '').includes('charter') || (ent.entity_subtype || '').includes('fishing');
  const isRental   = (ent.entity_subtype || '').includes('rental') || (ent.entity_type || '') === 'condo';
  const dealType   = isCharter ? 'charter_opening' : isRental ? 'rental_gap' : 'last_minute';

  const spotsWord  = remaining === 1 ? 'spot' : 'spots';
  const timeStr    = timeSlot ? ` at ${timeSlot.replace(/:\d{2}$/, '')}` : '';
  const whenStr    = isToday ? 'TODAY' : 'TOMORROW';

  let headline;
  if (isCharter) {
    headline = `🎣 ${remaining} walk-on ${spotsWord} open — ${whenStr}${timeStr}`;
  } else if (isRental) {
    headline = `🏠 Last-minute opening — ${whenStr}${timeStr ? ` · ${timeStr}` : ''}`;
  } else {
    headline = `⚡ ${remaining} ${spotsWord} just opened up — ${whenStr}${timeStr}`;
  }

  const expiresAt = new Date(date + 'T23:59:00').toISOString();

  if (existing) {
    // Update existing deal with new spot count
    await db.from('gcr_deals').update({
      spots_remaining: remaining,
      headline,
      is_today_only: isToday,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }).eq('id', existing.id);
  } else {
    // Create new auto deal
    await db.from('gcr_deals').insert({
      entity_slug:    entitySlug,
      entity_name:    ent.name,
      entity_type:    ent.entity_type || null,
      entity_subtype: ent.entity_subtype || null,
      image_url:      ent.hero_image_url || null,
      posted_by:      'auto',
      deal_type:      dealType,
      headline,
      deal_price:     ent.price_from || null,
      price_unit:     ent.price_unit || 'person',
      valid_date:     date,
      valid_start_time: timeSlot || null,
      expires_at:     expiresAt,
      is_today_only:  isToday,
      spots_total:    total || null,
      spots_remaining: remaining,
      claim_type:     ent.booking_url ? 'link' : 'phone',
      claim_url:      ent.booking_url || null,
      claim_phone:    ent.phone || null,
      is_active:      true,
      is_featured:    remaining === 1, // feature if truly last spot
      promoted_feed:  true,
      swipe_card:     true,
      promoted_sms:   remaining <= 2, // SMS blast if 1-2 spots
      source:         'email_parser',
      created_at:     new Date().toISOString(),
    });
  }
}

// Mirror every parsed external booking into booking_calendar — ONE
// slug-keyed store of date-claims, so a date taken on Airbnb/FareHarbor/
// OpenTable blocks the direct checkout too. Dedupe on (source,
// external_uid): re-forwarded emails never double-claim a date.
async function mirrorToCalendar(entitySlug, parsed, emailLogId) {
  try {
    if (!entitySlug || !parsed.event_date) return;
    const source = 'email:' + (parsed.platform || 'unknown');
    const uid = parsed.confirmation_no
      || [parsed.platform, parsed.event_date, parsed.event_time || '', parsed.party_size || ''].join('|');
    const row = {
      entity_slug: entitySlug,
      date: parsed.event_date,
      end_date: parsed.checkout_date || parsed.end_date || null,
      start_time: parsed.event_time || null,
      end_time: parsed.end_time || null,
      kind: 'booking',
      source: source,
      status: parsed.status === 'cancelled' ? 'cancelled' : 'active',
      title: [parsed.platform, parsed.guest_name || parsed.activity_name].filter(Boolean).join(' · ') || source,
      party: parseInt(parsed.party_size, 10) || null,
      external_uid: String(uid).slice(0, 120),
      details: { ...parsed, email_log_id: emailLogId || null },
      updated_at: new Date().toISOString(),
    };
    const { data: existing } = await db.from('booking_calendar')
      .select('id').eq('entity_slug', entitySlug).eq('source', source)
      .eq('external_uid', row.external_uid).maybeSingle();
    if (existing) await db.from('booking_calendar').update(row).eq('id', existing.id);
    else await db.from('booking_calendar').insert(row);
  } catch (e) {
    console.warn('[email-parser] calendar mirror failed:', e.message);
  }
}

async function upsertAvailability(entitySlug, parsed, emailLogId) {
  if (!entitySlug || !parsed.event_date) return;

  // every parsed booking claims its date on the unified calendar
  mirrorToCalendar(entitySlug, parsed, emailLogId).catch(() => {});

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

  let remaining = null;
  let tc = null;

  if (existing) {
    const newBooked = isCancelled
      ? Math.max(0, (existing.booked_count || 0) - partySize)
      : (existing.booked_count || 0) + partySize;

    tc = existing.total_capacity || totalCapacity;
    remaining = tc ? Math.max(0, tc - newBooked) : null;
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
    tc = totalCapacity;
    remaining = tc ? Math.max(0, tc - partySize) : null;
    const status = !tc ? 'unknown'
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
        total_capacity: tc,
        booked_count: partySize,
        remaining_spots: remaining,
        status,
        booking_type: parsed.booking_type,
        source_platform: parsed.platform,
        last_updated: new Date().toISOString(),
        last_email_log_id: emailLogId,
      });
  }

  // Auto-create last_minute deal if today/tomorrow and spots are limited
  if (remaining !== null) {
    maybeCreateAutoDeal(entitySlug, parsed.event_date, remaining, tc, parsed.event_time, parsed).catch(e =>
      console.warn('[email-parser] auto-deal error:', e.message)
    );
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
// Fire-and-forget confirmation email + (consent-gated) SMS for a GCR-direct
// booking — never throws into the caller, a send failure must not fail the
// booking itself.
async function sendBookingConfirmations(entitySlug, parsed, customerEmail, customerPhone, optInId) {
  try {
    const { data: entity } = await db.from('entity').select('name').eq('slug', entitySlug).maybeSingle();
    const businessName = entity?.name || 'Gulf Coast Radar';

    if (customerEmail) {
      const { sendEmail, gcrReservationConfirmationHtml } = require('../utils/email');
      await sendEmail({
        to: customerEmail,
        subject: `Reservation requested — ${businessName}`,
        html: gcrReservationConfirmationHtml({
          business_name: businessName,
          customer_name: parsed.customer_name || 'there',
          date: parsed.event_date,
          time_slot: parsed.event_time,
          guest_count: parsed.party_size,
          notes: parsed.notes,
        }),
      });
    }

    // SMS only goes out if this phone number has an explicit sms_consent=true
    // opt-in on file — required until A2P 10DLC approval lands. sendSms()
    // itself also relays to the owner instead of the customer when
    // OWNER_RELAY_MODE is set, as an extra pre-approval safety net.
    if (customerPhone && optInId) {
      const { data: optIn } = await db.from('booking_opt_ins').select('sms_consent').eq('id', optInId).maybeSingle();
      if (optIn?.sms_consent) {
        const { sendSms } = require('../utils/sms');
        await sendSms(
          customerPhone,
          `${businessName}: We received your reservation request for ${parsed.event_date}${parsed.event_time ? ' at ' + parsed.event_time : ''}. We'll text you when it's confirmed. Reply STOP to opt out.`,
          entitySlug,
          'booking_confirmation'
        );
      }
    }
  } catch (err) {
    console.error('sendBookingConfirmations failed:', err.message);
  }
}

router.post('/manual', async (req, res) => {
  try {
    const {
      entity_slug, platform = 'manual', booking_type = 'tour',
      event_date, event_time, end_time, party_size,
      customer_name, activity_name, table_number, seated_time,
      left_time, confirmation_no, status = 'confirmed', notes,
      customer_email, customer_phone, opt_in_id,
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

    if (customer_email || opt_in_id) {
      sendBookingConfirmations(entity_slug, parsed, customer_email, customer_phone, opt_in_id).catch(() => {});
    }

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

/**
 * POST /api/email-parser/setup/:slug
 * Business onboarding — set capacity and BCC email address
 * Body: { daily_capacity, capacity_per_slot, bcc_email }
 */
router.post('/setup/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { daily_capacity, capacity_per_slot } = req.body;

    if (!daily_capacity) {
      return res.status(400).json({ error: 'daily_capacity required' });
    }

    const { error } = await db
      .from('entity')
      .update({
        daily_capacity:    parseInt(daily_capacity),
        capacity_per_slot: capacity_per_slot ? parseInt(capacity_per_slot) : null,
        updated_at:        new Date().toISOString(),
      })
      .eq('slug', slug);

    if (error) return res.status(500).json({ error: error.message });

    const bccEmail = `gcr-${slug}@parse.gulfcoastradar.com`;

    res.json({
      success: true,
      bcc_email: bccEmail,
      instructions: `BCC every booking confirmation to: ${bccEmail}. Set this in your FareHarbor / Peek / BoatBooker notification settings.`,
      daily_capacity: parseInt(daily_capacity),
      capacity_per_slot: capacity_per_slot ? parseInt(capacity_per_slot) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/email-parser/setup/:slug
 * Returns current capacity config + BCC address for a business
 */
router.get('/setup/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { data, error } = await db
      .from('entity')
      .select('name, daily_capacity, capacity_per_slot')
      .eq('slug', slug)
      .maybeSingle();

    if (error || !data) return res.status(404).json({ error: 'Business not found' });

    res.json({
      slug,
      name: data.name,
      daily_capacity: data.daily_capacity || null,
      capacity_per_slot: data.capacity_per_slot || null,
      bcc_email: `gcr-${slug}@parse.gulfcoastradar.com`,
      configured: !!data.daily_capacity,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── EXTERNAL CALENDAR IMPORT (iCal) ──────────────────────────────────────
// Reverse of the export feed (/api/public/ical/:slug/:token.ics): a business
// pastes their Airbnb/VRBO .ics export URL, we poll it on a cron and mirror
// its blocked date ranges into business_availability — so a booking made on
// Airbnb also blocks that date on GCR, closing the loop on the unified
// calendar.
const { parseIcsEvents, datesInRange } = require('../utils/ical-parse');

async function blockDateOnCalendar(entitySlug, date, sourceLabel, resourceId = null) {
  // Match the existing row for this specific unit, or the entity-wide row when the
  // feed isn't tied to a unit (resourceId null). Per-unit feeds let a multi-unit
  // building block one unit's dates without touching its siblings.
  let q = db.from('business_availability')
    .select('id')
    .eq('entity_slug', entitySlug)
    .eq('availability_date', date)
    .eq('time_slot', '00:00');
  q = resourceId ? q.eq('resource_id', resourceId) : q.is('resource_id', null);
  const { data: existing } = await q.maybeSingle();

  if (existing) {
    await db.from('business_availability').update({
      status: 'blocked',
      remaining_spots: 0,
      source_platform: sourceLabel,
      last_updated: new Date().toISOString(),
    }).eq('id', existing.id);
  } else {
    await db.from('business_availability').insert({
      entity_slug: entitySlug,
      resource_id: resourceId,
      availability_date: date,
      time_slot: '00:00',
      status: 'blocked',
      remaining_spots: 0,
      booked_count: 0,
      source_platform: sourceLabel,
    });
  }
}

async function syncExternalCalendar(row) {
  try {
    const res = await fetch(row.ical_url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const events = parseIcsEvents(text);

    const dates = new Set();
    for (const ev of events) {
      for (const d of datesInRange(ev.start, ev.end)) dates.add(d);
    }

    let blockedCount = 0;
    for (const d of dates) {
      await blockDateOnCalendar(row.entity_slug, d, row.source_label || 'external-ical', row.resource_id || null);
      blockedCount++;
    }

    // Mirror into booking_calendar — the ONE table the platform engine
    // computes availability from — so a booking made on Airbnb/VRBO also
    // blocks the direct checkout. Source is scoped per feed row, which lets
    // us prune dates that fell out of the feed without touching anything
    // else. A feed tied to one unit claims just that unit (kind 'booking'
    // + offering_id → per-resource busy); an entity-wide feed hard-blocks
    // the date (kind 'block').
    const calSource = 'ical:' + row.id;
    const perUnit = !!row.resource_id;
    const { data: existing } = await db.from('booking_calendar')
      .select('id, date').eq('entity_slug', row.entity_slug).eq('source', calSource).limit(2000);
    const have = {};
    (existing || []).forEach(r => { have[r.date] = r.id; });
    for (const d of dates) {
      if (have[d]) { delete have[d]; continue; }
      await db.from('booking_calendar').insert({
        entity_slug: row.entity_slug,
        date: d,
        kind: perUnit ? 'booking' : 'block',
        source: calSource,
        status: 'active',
        title: (row.source_label || 'External calendar') + ' (synced)',
        external_uid: d,
        offering_id: row.resource_id || null,
        details: { provider: row.provider || null, feed: row.source_label || null, synced: true },
      });
    }
    // anything left in `have` is no longer claimed by the feed — free it
    for (const d of Object.keys(have)) {
      await db.from('booking_calendar').delete().eq('id', have[d]);
    }

    await db.from('entity_external_calendars').update({
      last_synced_at: new Date().toISOString(),
      last_sync_status: `ok (${blockedCount} dates blocked)`,
    }).eq('id', row.id);
  } catch (err) {
    await db.from('entity_external_calendars').update({
      last_synced_at: new Date().toISOString(),
      last_sync_status: 'error: ' + err.message,
    }).eq('id', row.id);
  }
}

// GET /api/email-parser/ical-import/run — Vercel cron hits this hourly
router.get('/ical-import/run', async (req, res) => {
  if (process.env.CRON_SECRET && (req.headers.authorization || '') !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { data: rows } = await db.from('entity_external_calendars').select('*');
  for (const row of (rows || [])) {
    await syncExternalCalendar(row);
  }
  res.json({ success: true, synced: (rows || []).length });
});

// POST /api/email-parser/ical-import/sync-now/:id — manual "sync now" trigger from the dashboard
router.post('/ical-import/sync-now/:id', async (req, res) => {
  const { data: row } = await db.from('entity_external_calendars').select('*').eq('id', req.params.id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'Not found' });
  await syncExternalCalendar(row);
  res.json({ success: true });
});

module.exports = router;
module.exports.EXTRACTORS = EXTRACTORS;
// Exported so the admin router can trigger a sync in-process instead of
// making an HTTP call back to this same server. Behaviour is unchanged.
module.exports.syncExternalCalendar = syncExternalCalendar;
