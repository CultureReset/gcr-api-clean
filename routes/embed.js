// ============================================================
// EMBEDDABLE AVAILABILITY CALENDAR
// ============================================================
//
// A business drops two lines into their own website and gets a live calendar
// of what they have open — the same numbers this platform computes from their
// forwarded confirmation emails and their Airbnb/VRBO iCal feeds:
//
//   <div data-gcr-availability="reel-deal-charters"></div>
//   <script src="https://gcr-api-clean.vercel.app/api/embed/availability.js" async></script>
//
// Why this is worth having: the business already pays FareHarbor or Peek Pro
// or Airbnb, and none of those will show one calendar spanning all of them.
// This platform is the only place the union exists, because it is assembled
// from the confirmation emails rather than from any one platform's API.
//
// Everything here is public and unauthenticated by design — it is meant to be
// loaded by anonymous visitors on someone else's domain. Three consequences,
// all deliberate:
//
//   * only counts and statuses are ever returned. No guest name, no email, no
//     confirmation number, no booking row. A day is a number and a colour.
//   * `visible_on_profile = false` rows are excluded, so a business can keep a
//     date out of its public calendar without deleting it.
//   * responses are edge-cached for five minutes. A calendar that is five
//     minutes stale is fine; one that hammers the database on every page view
//     is not.

const express = require('express');
const AVAIL = require('./availability-engine');
const db = require('../db');

const router = express.Router();

/** Widest window the data route will answer, so a crawler can't ask for a decade. */
const MAX_DAYS = 120;

function monthBounds(month) {
    const from = month + '-01';
    const year = parseInt(month.slice(0, 4), 10);
    const mon = parseInt(month.slice(5, 7), 10);
    const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    return { from, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/* ── data ────────────────────────────────────────────────────────────── */
//
// GET /api/embed/availability/:slug?month=YYYY-MM
// GET /api/embed/availability/:slug?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// For a single business this is its own days. For a complex — a condo
// building, a marina — it is the union of its units plus a per-unit
// breakdown, because "is anything free on the 15th" is a question about the
// children and the parent usually carries no inventory of its own.

router.get('/availability/:slug', async (req, res) => {
    try {
        const slug = String(req.params.slug || '').slice(0, 120);
        if (!slug) return res.status(400).json({ error: 'slug required' });

        let from;
        let to;
        if (/^\d{4}-\d{2}$/.test(req.query.month || '')) {
            ({ from, to } = monthBounds(req.query.month));
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) {
            from = req.query.from;
            to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : from;
        } else {
            ({ from, to } = monthBounds(new Date().toISOString().slice(0, 7)));
        }
        if (to < from) return res.status(400).json({ error: 'to must not be before from' });
        const dates = AVAIL.datesBetween(from, to, MAX_DAYS);
        if (!dates.length) return res.status(400).json({ error: 'empty date range' });
        to = dates[dates.length - 1];

        const { data: entity } = await db
            .from('entity')
            .select('slug, name, entity_type, entity_subtype, timezone, booking_url, phone, daily_capacity')
            .eq('slug', slug)
            .eq('is_active', true)
            .maybeSingle();
        if (!entity) return res.status(404).json({ error: 'Not found' });

        const { data: units } = await db
            .from('entity')
            .select('slug, name, entity_subtype, bedrooms, bathrooms, daily_capacity')
            .eq('parent_entity_slug', slug)
            .eq('is_active', true)
            .order('name')
            .limit(300);

        const slugs = [slug, ...(units || []).map((u) => u.slug)];
        const availability = await AVAIL.readAvailability({ from, to, slugs, publicOnly: true });

        const vertical = AVAIL.verticalOf(entity);
        const coverage = AVAIL.coverageFor(vertical);

        // A day on the parent's own calendar. `remaining` is spots for a
        // charter and units for a complex — the widget labels it from
        // `unit_word`, which is why that is computed here rather than guessed
        // in the browser.
        //
        // Unclaimed dates are filled in from daily_capacity rather than left
        // blank: a row only exists once something has taken the date, so no
        // row means nothing has taken it. See `expand` in the engine.
        const ownDays = AVAIL.expand(availability.get(slug), dates, entity.daily_capacity ?? null);
        const dayMap = new Map(ownDays.map((d) => [d.date, d]));

        const unitRows = (units || []).map((u) => {
            // A unit with no capacity set is still one unit — that is what a
            // condo IS — so it defaults to 1 rather than to unknown.
            const summary = AVAIL.summarise(
                availability.get(u.slug), dates, coverage, u.daily_capacity ?? 1,
            );
            return {
                slug: u.slug,
                name: u.name,
                subtype: u.entity_subtype,
                bedrooms: u.bedrooms ?? null,
                bathrooms: u.bathrooms ?? null,
                available_dates: summary.available_dates,
                has_data: summary.has_data,
            };
        });

        const days = dates.map((date) => {
            const own_ = dayMap.get(date);
            const freeUnits = unitRows.filter((u) => u.available_dates.includes(date));

            // With units, the count IS the number of free units — the parent's
            // own capacity row, if any, describes the building and would
            // double-count. Without units, the parent's own numbers are it.
            if (unitRows.length) {
                const blocked = own_ && own_.status === 'blocked' && !own_.assumed;
                return {
                    date,
                    status: blocked ? 'blocked' : AVAIL.statusFor(freeUnits.length, unitRows.length),
                    remaining: blocked ? 0 : freeUnits.length,
                    total: unitRows.length,
                    units: freeUnits.map((u) => u.slug),
                };
            }
            return {
                date,
                status: own_.status,
                remaining: own_.remaining,
                total: own_.total,
                slots: own_.slots && own_.slots.length ? own_.slots : undefined,
            };
        });

        res.set('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');
        res.json({
            slug,
            name: entity.name,
            vertical,
            coverage,
            // "spots" for a charter, "units" for a complex, "nights" for a
            // single stay. The widget renders this verbatim.
            unit_word: unitRows.length ? 'units' : vertical === 'stay' ? 'nights' : 'spots',
            from,
            to,
            days,
            units: unitRows.length ? unitRows : undefined,
            unit_count: unitRows.length || undefined,
            booking_url: entity.booking_url || null,
            phone: entity.phone || null,
            // Stated so the widget can say "call to confirm" rather than
            // implying an open day means confirmed seats.
            capacity_known: unitRows.length > 0 || entity.daily_capacity != null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── the script ──────────────────────────────────────────────────────── */
//
// Served as a route rather than a static file so it can bake in the API
// origin it was fetched from. A business pastes one URL and the script knows
// where to call back to; there is no second thing to configure and get wrong.
//
// Self-contained on purpose: no framework, no CSS file, no external request
// beyond its own data endpoint. It has to run inside a Wix page, a Squarespace
// block and a hand-written HTML file without any of them fighting it.

function widgetSource(origin) {
    return `/* GCR availability calendar — ${origin} */
(function () {
  'use strict';
  if (window.__gcrAvailabilityLoaded) return;
  window.__gcrAvailabilityLoaded = true;

  var API = ${JSON.stringify(origin)};
  var CSS = [
    '.gcrc{font-family:inherit;max-width:420px;color:inherit;font-size:14px}',
    '.gcrc *{box-sizing:border-box}',
    '.gcrc__head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}',
    '.gcrc__title{font-weight:600}',
    '.gcrc__nav{display:flex;gap:4px}',
    '.gcrc__btn{border:1px solid currentColor;background:none;color:inherit;border-radius:6px;',
    'width:28px;height:28px;line-height:1;cursor:pointer;opacity:.6;font-size:14px}',
    '.gcrc__btn:hover:not(:disabled){opacity:1}.gcrc__btn:disabled{opacity:.2;cursor:default}',
    '.gcrc__grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}',
    '.gcrc__dow{text-align:center;font-size:11px;opacity:.55;padding:2px 0;text-transform:uppercase}',
    '.gcrc__day{aspect-ratio:1;border-radius:6px;display:flex;flex-direction:column;',
    'align-items:center;justify-content:center;font-size:13px;border:1px solid transparent}',
    '.gcrc__day--pad{visibility:hidden}',
    '.gcrc__day--past{opacity:.25}',
    '.gcrc__day--unknown{border-color:currentColor;opacity:.35}',
    '.gcrc__day--available{background:#16a34a;color:#fff}',
    '.gcrc__day--limited{background:#f59e0b;color:#111}',
    '.gcrc__day--full,.gcrc__day--blocked{background:currentColor;opacity:.18}',
    '.gcrc__n{font-size:10px;line-height:1;margin-top:2px;opacity:.9}',
    '.gcrc__key{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;font-size:11px;opacity:.7}',
    '.gcrc__k{display:flex;align-items:center;gap:4px}',
    '.gcrc__sw{width:10px;height:10px;border-radius:3px;display:inline-block}',
    '.gcrc__foot{margin-top:10px;font-size:12px}',
    '.gcrc__foot a{color:inherit}',
    '.gcrc__err{font-size:12px;opacity:.6;padding:10px 0}'
  ].join('');

  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  var DOW = ['S','M','T','W','T','F','S'];
  var MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

  function today() { return new Date().toISOString().slice(0, 10); }
  function monthKey(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render(host, slug, month, opts) {
    host.textContent = '';
    var root = el('div', 'gcrc');
    host.appendChild(root);

    var url = API + '/api/embed/availability/' + encodeURIComponent(slug) + '?month=' + month;
    fetch(url, { credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) { draw(root, host, slug, month, data, opts); })
      .catch(function () {
        root.appendChild(el('div', 'gcrc__err', 'Availability is unavailable right now.'));
      });
  }

  function draw(root, host, slug, month, data, opts) {
    var head = el('div', 'gcrc__head');
    head.appendChild(el('div', 'gcrc__title',
      MONTHS[parseInt(month.slice(5, 7), 10) - 1] + ' ' + month.slice(0, 4)));

    var nav = el('div', 'gcrc__nav');
    var prev = el('button', 'gcrc__btn', '\\u2039');
    var next = el('button', 'gcrc__btn', '\\u203A');
    // Never page backwards past the current month: history is not useful on a
    // "can I book this?" calendar and it invites confusion with sold-out days.
    prev.disabled = month <= today().slice(0, 7);
    prev.setAttribute('aria-label', 'Previous month');
    next.setAttribute('aria-label', 'Next month');
    prev.onclick = function () { render(host, slug, shift(month, -1), opts); };
    next.onclick = function () { render(host, slug, shift(month, 1), opts); };
    nav.appendChild(prev); nav.appendChild(next);
    head.appendChild(nav);
    root.appendChild(head);

    var grid = el('div', 'gcrc__grid');
    for (var i = 0; i < 7; i++) grid.appendChild(el('div', 'gcrc__dow', DOW[i]));

    var byDate = {};
    (data.days || []).forEach(function (d) { byDate[d.date] = d; });

    var first = new Date(month + '-01T00:00:00Z');
    for (var p = 0; p < first.getUTCDay(); p++) grid.appendChild(el('div', 'gcrc__day gcrc__day--pad'));

    var cursor = new Date(first.getTime());
    var t = today();
    while (monthKey(cursor) === month) {
      var iso = cursor.toISOString().slice(0, 10);
      var day = byDate[iso] || { status: 'unknown', remaining: null };
      var past = iso < t;
      var cell = el('div', 'gcrc__day gcrc__day--' + (past ? 'past' : day.status));
      cell.appendChild(el('span', null, String(cursor.getUTCDate())));
      if (!past && day.remaining != null && day.status !== 'full' && day.status !== 'blocked') {
        cell.appendChild(el('span', 'gcrc__n', day.remaining + ' ' + (data.unit_word || 'spots')));
      }
      cell.title = past ? iso
        : day.status === 'unknown' ? iso + ' — call to check'
        : iso + ' — ' + day.status + (day.remaining != null ? ' (' + day.remaining + ' ' + (data.unit_word || 'spots') + ')' : '');
      grid.appendChild(cell);
      cursor = new Date(cursor.getTime() + 86400000);
    }
    root.appendChild(grid);

    var key = el('div', 'gcrc__key');
    [['available', 'Available'], ['limited', 'Almost gone'], ['full', 'Booked']].forEach(function (k) {
      var item = el('div', 'gcrc__k');
      var sw = el('span', 'gcrc__sw');
      sw.style.background = k[0] === 'available' ? '#16a34a' : k[0] === 'limited' ? '#f59e0b' : 'currentColor';
      if (k[0] === 'full') sw.style.opacity = '.18';
      item.appendChild(sw); item.appendChild(el('span', null, k[1]));
      key.appendChild(item);
    });
    root.appendChild(key);

    var foot = el('div', 'gcrc__foot');
    if (data.unit_count) {
      foot.appendChild(el('span', null, data.unit_count + ' units \\u00B7 '));
    }
    // Said plainly rather than implied: with no capacity on file an open day
    // means nothing has blocked it, not that seats are confirmed.
    if (!data.capacity_known) {
      foot.appendChild(el('span', null, 'Call to confirm availability. '));
    }
    if (opts.book !== 'off' && data.booking_url) {
      var a = el('a', null, 'Book now');
      a.href = data.booking_url;
      a.target = '_blank';
      a.rel = 'noopener';
      foot.appendChild(a);
    } else if (opts.book !== 'off' && data.phone) {
      var tel = el('a', null, data.phone);
      tel.href = 'tel:' + String(data.phone).replace(/[^0-9+]/g, '');
      foot.appendChild(tel);
    }
    if (foot.childNodes.length) root.appendChild(foot);
  }

  function shift(month, by) {
    var d = new Date(month + '-01T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + by);
    return monthKey(d);
  }

  function mount() {
    var hosts = document.querySelectorAll('[data-gcr-availability]:not([data-gcr-mounted])');
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      host.setAttribute('data-gcr-mounted', '1');
      var slug = host.getAttribute('data-gcr-availability');
      if (!slug) continue;
      render(host, slug, host.getAttribute('data-gcr-month') || today().slice(0, 7), {
        book: host.getAttribute('data-gcr-book') || 'on'
      });
    }
  }

  // Mount now for anything already parsed, and again on DOMContentLoaded for
  // the common case of the script tag sitting in <head>.
  mount();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  window.gcrAvailability = { mount: mount };
})();
`;
}

router.get('/availability.js', (req, res) => {
    // The origin the script was fetched from is the origin it calls back to,
    // so moving the API to another host needs no change on any customer site.
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const origin = process.env.PUBLIC_API_BASE_URL || `${proto}://${host}`;

    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600, s-maxage=3600');
    res.send(widgetSource(origin));
});

module.exports = router;
module.exports.widgetSource = widgetSource;
