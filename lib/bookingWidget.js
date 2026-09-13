// ============================================================
// THE PUBLIC BOOKING WIDGET — one file, no build step.
// ============================================================
//
// A business needs somewhere for customers to actually book. This is it:
// a script tag that drops a working checkout into any page they already
// have — a Wix site, a Squarespace page, a WordPress blog, the GCR
// listing — plus a hosted page for the ones who have no site at all.
//
//   <div id="book"></div>
//   <script src="https://…/api/booking/embed.js" data-slug="my-charters"></script>
//
// ── Why the source lives in a JS string ─────────────────────────────────
//
// Because Vercel's bundler traces `require()` and does not trace
// `fs.readFileSync(__dirname + '/…')`. A widget kept as a static asset
// works locally and 404s in production, which is the kind of bug that is
// only found by a customer failing to book. A required module is always
// bundled. server.js carries the same warning about route loaders.
//
// ── What the widget does not do ─────────────────────────────────────────
//
// It does not add up a price. Every total on screen came from POST
// /quote, priced by the same server function that prices the charge, so
// what a customer is shown and what their card is billed cannot drift.
// The widget sends quantities and renders the answer.
//
// It never touches a card either — that is Stripe's hosted checkout, one
// redirect away, which keeps card data out of both this file and the
// business's own website.
// ============================================================

'use strict';

const WIDGET_JS = String.raw`
(function () {
  'use strict';

  // ── configuration, from the script tag that loaded us ──
  var script = document.currentScript ||
    (function () { var s = document.getElementsByTagName('script'); return s[s.length - 1]; })();
  var cfg = {
    slug: (script && script.getAttribute('data-slug')) || '',
    mount: (script && script.getAttribute('data-target')) || 'gcr-book',
    api: (script && script.getAttribute('data-api')) ||
      (script && script.src ? script.src.replace(/\/api\/booking\/embed\.js.*$/, '') : ''),
    accent: (script && script.getAttribute('data-accent')) || '',
  };

  var root = document.getElementById(cfg.mount);
  if (!root) {
    root = document.createElement('div');
    root.id = cfg.mount;
    if (script && script.parentNode) script.parentNode.insertBefore(root, script);
    else document.body.appendChild(root);
  }
  if (!cfg.slug) { root.textContent = 'Booking widget: data-slug is missing.'; return; }

  // ── state ──
  var page = null;        // the business and its products
  var product = null;     // the one being booked
  var chosen = { date: '', time: '', items: {}, extras: {}, promo: '' };
  var availability = {};  // 'YYYY-MM-DD' -> day
  var quote = null;
  var quoteSeq = 0;
  var busy = false;
  var message = '';

  // ── tiny DOM helpers ──
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var key in attrs || {}) {
      if (key === 'class') node.className = attrs[key];
      else if (key === 'text') node.textContent = attrs[key];
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] != null && attrs[key] !== false) node.setAttribute(key, attrs[key]);
    }
    (children || []).forEach(function (child) {
      if (child == null || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function money(amount, currency) {
    var value = Number(amount);
    if (!isFinite(value)) return '';
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency', currency: (currency || 'usd').toUpperCase(),
        minimumFractionDigits: value % 1 === 0 ? 0 : 2,
      }).format(value);
    } catch (e) { return '$' + value.toFixed(2); }
  }
  function prettyTime(t) {
    if (!t) return '';
    var m = String(t).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return t;
    var h = Number(m[1]);
    return ((h + 11) % 12 + 1) + ':' + m[2] + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  function today() { return new Date().toISOString().slice(0, 10); }

  // ── the API ──
  function api(path, body) {
    var opts = { headers: { 'Content-Type': 'application/json' } };
    if (body) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
    return fetch(cfg.api + path, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  // ── styles, scoped to our own class prefix ──
  function injectStyles() {
    if (document.getElementById('gcr-book-styles')) return;
    var accent = cfg.accent || (page && page.business && page.business.accent) || '#17806f';
    var css = [
      '.gcrb{font-family:Inter,system-ui,-apple-system,sans-serif;color:#16202a;max-width:640px;line-height:1.45}',
      '.gcrb *{box-sizing:border-box}',
      '.gcrb-h{margin:0 0 4px;font-size:1.2rem}',
      '.gcrb-sub{margin:0 0 16px;color:#64748b;font-size:.88rem}',
      '.gcrb-card{border:1px solid #dde3e8;border-radius:12px;padding:14px;margin-bottom:10px;background:#fff;cursor:pointer;display:block;width:100%;text-align:left;font:inherit;color:inherit}',
      '.gcrb-card:hover{border-color:' + accent + '}',
      '.gcrb-card-name{font-weight:600;display:block;margin-bottom:2px}',
      '.gcrb-card-meta{color:#64748b;font-size:.82rem;display:block}',
      '.gcrb-card-from{color:' + accent + ';font-size:.82rem;font-weight:600;display:block;margin-top:6px}',
      '.gcrb-panel{border:1px solid #dde3e8;border-radius:12px;padding:16px;background:#fff}',
      '.gcrb-back{border:0;background:none;color:#64748b;font:inherit;font-size:.85rem;cursor:pointer;padding:0 0 10px}',
      '.gcrb-sec{margin:0 0 18px}',
      '.gcrb-lbl{display:block;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin:0 0 6px}',
      '.gcrb-in{width:100%;min-height:42px;padding:9px 11px;border:1px solid #dde3e8;border-radius:8px;font:inherit;font-size:.92rem;background:#fff;color:#16202a}',
      '.gcrb-slots{display:flex;flex-wrap:wrap;gap:6px}',
      '.gcrb-slot{min-height:40px;padding:8px 14px;border:1px solid #dde3e8;border-radius:999px;background:#fff;font:inherit;font-size:.85rem;cursor:pointer;color:#16202a}',
      '.gcrb-slot.on{background:' + accent + ';border-color:' + accent + ';color:#fff}',
      '.gcrb-slot:disabled{opacity:.4;cursor:not-allowed;text-decoration:line-through}',
      '.gcrb-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #eef2f5}',
      '.gcrb-row-main{flex:1}',
      '.gcrb-row-name{font-size:.92rem}',
      '.gcrb-row-note{display:block;color:#64748b;font-size:.76rem}',
      '.gcrb-step{display:flex;align-items:center;gap:4px}',
      '.gcrb-step button{width:34px;height:34px;border:1px solid #dde3e8;border-radius:8px;background:#fff;font:inherit;font-size:1rem;cursor:pointer;color:#16202a}',
      '.gcrb-step button:disabled{opacity:.35;cursor:not-allowed}',
      '.gcrb-step span{min-width:26px;text-align:center;font-size:.95rem}',
      '.gcrb-total{border-top:2px solid #16202a;margin-top:10px;padding-top:10px}',
      '.gcrb-line{display:flex;justify-content:space-between;font-size:.88rem;padding:3px 0}',
      '.gcrb-line-total{font-weight:700;font-size:1rem}',
      '.gcrb-line-due{color:' + accent + ';font-weight:600}',
      '.gcrb-btn{width:100%;min-height:48px;border:0;border-radius:10px;background:' + accent + ';color:#fff;font:inherit;font-size:1rem;font-weight:600;cursor:pointer;margin-top:12px}',
      '.gcrb-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.gcrb-err{background:#fdecea;border:1px solid #b3261e;color:#b3261e;padding:10px 12px;border-radius:8px;font-size:.86rem;margin:10px 0}',
      '.gcrb-ok{background:#e6f5f2;border:1px solid ' + accent + ';padding:14px;border-radius:10px;font-size:.9rem}',
      '.gcrb-fine{color:#64748b;font-size:.78rem;margin-top:10px}',
      '@media(prefers-color-scheme:dark){',
      '.gcrb{color:#e7edf3}',
      '.gcrb-card,.gcrb-panel,.gcrb-in,.gcrb-slot,.gcrb-step button{background:#182028;border-color:#2b3742;color:#e7edf3}',
      '.gcrb-total{border-top-color:#e7edf3}.gcrb-row{border-bottom-color:#22303a}',
      '}',
    ].join('');
    document.head.appendChild(el('style', { id: 'gcr-book-styles', text: css }));
  }

  // ── screen 1: which trip? ──
  function renderList() {
    clear(root);
    var wrap = el('div', { class: 'gcrb' });
    wrap.appendChild(el('h2', { class: 'gcrb-h', text: 'Book with ' + page.business.name }));

    if (!page.products.length) {
      wrap.appendChild(el('p', { class: 'gcrb-sub', text: 'Nothing is available to book online just now.' }));
      root.appendChild(wrap);
      return;
    }

    wrap.appendChild(el('p', { class: 'gcrb-sub', text: 'Choose what you would like to book.' }));

    page.products.forEach(function (item) {
      var cheapest = (item.rates || []).reduce(function (low, r) {
        return !low || Number(r.amount) < Number(low.amount) ? r : low;
      }, null);
      var bits = [];
      if (item.duration_minutes) bits.push(durationText(item.duration_minutes));
      if (item.max_party) bits.push('up to ' + item.max_party);
      if (item.requires_waiver) bits.push('waiver required');

      wrap.appendChild(el('button', {
        class: 'gcrb-card', type: 'button',
        onclick: function () { open(item); },
      }, [
        el('span', { class: 'gcrb-card-name', text: item.name }),
        item.description ? el('span', { class: 'gcrb-card-meta', text: item.description }) : null,
        bits.length ? el('span', { class: 'gcrb-card-meta', text: bits.join(' · ') }) : null,
        cheapest ? el('span', {
          class: 'gcrb-card-from',
          text: 'From ' + money(cheapest.amount, item.currency) + perText(cheapest.pricing_mode),
        }) : null,
      ]));
    });

    if (!page.accepts_payments) {
      wrap.appendChild(el('p', { class: 'gcrb-fine', text: 'Bookings are confirmed with the business and paid on the day.' }));
    }
    root.appendChild(wrap);
  }

  function durationText(minutes) {
    var m = Number(minutes) || 0;
    if (m < 60) return m + ' min';
    var h = m / 60;
    return (h % 1 === 0 ? h : h.toFixed(1)) + ' hr' + (h === 1 ? '' : 's');
  }
  function perText(mode) {
    return {
      per_person: ' per person', per_group: ' per group', per_unit: ' per unit',
      per_hour: ' per hour', per_day: ' per day', per_night: ' per night',
    }[mode] || '';
  }

  // ── screen 2: the booking form ──
  function open(item) {
    product = item;
    chosen = { date: '', time: '', items: {}, extras: {}, promo: '' };
    quote = null;
    availability = {};
    message = '';
    render();
    if (product.schedule_mode !== 'request') loadAvailability();
  }

  function loadAvailability() {
    var from = chosen.date || today();
    var to = new Date(new Date(from + 'T00:00:00Z').getTime() + 45 * 86400000).toISOString().slice(0, 10);
    api('/api/booking/public/' + encodeURIComponent(cfg.slug) +
        '/availability?product_id=' + encodeURIComponent(product.id) +
        '&from=' + from + '&to=' + to)
      .then(function (data) {
        (data.days || []).forEach(function (day) { availability[day.date] = day; });
        render();
      })
      .catch(function (err) { message = err.message; render(); });
  }

  // Debounced so a customer tapping "+" five times costs one request, not
  // five — and so an old reply cannot overwrite a newer one (quoteSeq).
  var quoteTimer = null;
  function requestQuote() {
    clearTimeout(quoteTimer);
    var items = cartItems();
    if (!items.length) { quote = null; render(); return; }
    quoteTimer = setTimeout(function () {
      var seq = ++quoteSeq;
      api('/api/booking/public/' + encodeURIComponent(cfg.slug) + '/quote', {
        product_id: product.id,
        date: chosen.date || today(),
        items: items,
        extras: cartExtras(),
        promo_code: chosen.promo || undefined,
      }).then(function (data) {
        if (seq !== quoteSeq) return;
        quote = data; message = ''; render();
      }).catch(function (err) {
        if (seq !== quoteSeq) return;
        quote = null; message = err.message; render();
      });
    }, 220);
  }

  function cartItems() {
    return Object.keys(chosen.items)
      .filter(function (id) { return chosen.items[id] > 0; })
      .map(function (id) { return { rate_id: id, qty: chosen.items[id] }; });
  }
  function cartExtras() {
    return Object.keys(chosen.extras)
      .filter(function (id) { return chosen.extras[id] > 0; })
      .map(function (id) { return { extra_id: id, qty: chosen.extras[id] }; });
  }

  function render() {
    clear(root);
    var wrap = el('div', { class: 'gcrb' });
    wrap.appendChild(el('button', {
      class: 'gcrb-back', type: 'button', text: '← All bookings',
      onclick: function () { product = null; renderList(); },
    }));

    var panel = el('div', { class: 'gcrb-panel' });
    panel.appendChild(el('h2', { class: 'gcrb-h', text: product.name }));
    if (product.description) panel.appendChild(el('p', { class: 'gcrb-sub', text: product.description }));

    if (product.schedule_mode !== 'request') {
      panel.appendChild(dateSection());
      var day = availability[chosen.date];
      if (chosen.date && day && needsTime()) panel.appendChild(slotSection(day));
    }

    panel.appendChild(rateSection());
    if ((product.extras || []).length) panel.appendChild(extraSection());
    panel.appendChild(promoSection());
    if (quote) panel.appendChild(totalSection());
    panel.appendChild(detailsSection());

    if (message) panel.appendChild(el('div', { class: 'gcrb-err', text: message }));

    panel.appendChild(el('button', {
      class: 'gcrb-btn', type: 'button',
      disabled: busy || !quote || !readyToBook(),
      text: busy ? 'One moment…' : bookButtonText(),
      onclick: submit,
    }));

    panel.appendChild(el('p', { class: 'gcrb-fine', text: policyText() }));

    wrap.appendChild(panel);
    root.appendChild(wrap);
  }

  function needsTime() {
    return product.schedule_mode === 'fixed_times' || product.schedule_mode === 'duration_slots';
  }

  function dateSection() {
    var section = el('div', { class: 'gcrb-sec' });
    section.appendChild(el('label', { class: 'gcrb-lbl', for: 'gcrb-date', text: 'Date' }));
    section.appendChild(el('input', {
      class: 'gcrb-in', id: 'gcrb-date', type: 'date', min: today(), value: chosen.date,
      onchange: function (event) {
        chosen.date = event.target.value;
        chosen.time = '';
        if (!availability[chosen.date]) loadAvailability(); else render();
        requestQuote();
      },
    }));
    if (product.schedule_mode === 'date_range') {
      section.appendChild(el('label', { class: 'gcrb-lbl', for: 'gcrb-end', text: 'Until' }));
      section.appendChild(el('input', {
        class: 'gcrb-in', id: 'gcrb-end', type: 'date', min: chosen.date || today(), value: chosen.end_date || '',
        onchange: function (event) { chosen.end_date = event.target.value; requestQuote(); },
      }));
    }
    var day = availability[chosen.date];
    if (chosen.date && day && !day.bookable) {
      section.appendChild(el('div', { class: 'gcrb-err', text: closedText(day) }));
    }
    return section;
  }

  function closedText(day) {
    if (day.reason === 'past') return 'That date has passed.';
    if (day.reason === 'closed') return 'Closed that day — please pick another date.';
    if (day.reason === 'beyond_window') return 'That is further ahead than bookings are open.';
    if (day.reason === 'no_slots') return 'Nothing runs on that day.';
    return 'Fully booked that day — please pick another date.';
  }

  function slotSection(day) {
    var section = el('div', { class: 'gcrb-sec' });
    section.appendChild(el('span', { class: 'gcrb-lbl', text: 'Time' }));
    var list = el('div', { class: 'gcrb-slots' });
    (day.slots || []).forEach(function (slot) {
      list.appendChild(el('button', {
        class: 'gcrb-slot' + (chosen.time === slot.time ? ' on' : ''),
        type: 'button',
        disabled: !slot.available,
        title: slot.available ? slot.remaining + ' left' : slotWhy(slot),
        text: prettyTime(slot.time) + (slot.available && slot.remaining <= 3 ? ' · ' + slot.remaining + ' left' : ''),
        onclick: function () { chosen.time = slot.time; render(); },
      }));
    });
    section.appendChild(list);
    return section;
  }

  function slotWhy(slot) {
    if (slot.reason === 'cutoff') return 'Too late to book this one online';
    if (slot.reason === 'resource_busy') return 'Already out';
    return 'Fully booked';
  }

  function rateSection() {
    var section = el('div', { class: 'gcrb-sec' });
    section.appendChild(el('span', { class: 'gcrb-lbl', text: 'How many' }));
    (product.rates || []).forEach(function (rate) {
      section.appendChild(stepperRow({
        id: rate.id,
        name: rate.label,
        note: [
          money(rate.amount, product.currency) + perText(rate.pricing_mode),
          rate.weight_max_lb ? 'up to ' + rate.weight_max_lb + ' lbs' : '',
          rate.description || '',
        ].filter(Boolean).join(' · '),
        value: chosen.items[rate.id] || 0,
        max: product.max_party || 99,
        onChange: function (next) { chosen.items[rate.id] = next; requestQuote(); },
      }));
    });
    return section;
  }

  function extraSection() {
    var section = el('div', { class: 'gcrb-sec' });
    section.appendChild(el('span', { class: 'gcrb-lbl', text: 'Add anything?' }));
    (product.extras || []).forEach(function (extra) {
      if (extra.required) return; // added automatically; showing a locked stepper only confuses
      section.appendChild(stepperRow({
        id: extra.id,
        name: extra.name,
        note: money(extra.price, product.currency) + perText(extra.pricing_mode) + (extra.description ? ' · ' + extra.description : ''),
        value: chosen.extras[extra.id] || 0,
        max: extra.max_qty || 1,
        onChange: function (next) { chosen.extras[extra.id] = next; requestQuote(); },
      }));
    });
    return section;
  }

  function stepperRow(opts) {
    function step(delta) {
      var next = Math.max(0, Math.min(opts.max, opts.value + delta));
      if (next !== opts.value) opts.onChange(next);
    }
    return el('div', { class: 'gcrb-row' }, [
      el('div', { class: 'gcrb-row-main' }, [
        el('span', { class: 'gcrb-row-name', text: opts.name }),
        opts.note ? el('span', { class: 'gcrb-row-note', text: opts.note }) : null,
      ]),
      el('div', { class: 'gcrb-step' }, [
        el('button', { type: 'button', text: '−', disabled: opts.value <= 0, 'aria-label': 'One fewer ' + opts.name, onclick: function () { step(-1); } }),
        el('span', { text: String(opts.value) }),
        el('button', { type: 'button', text: '+', disabled: opts.value >= opts.max, 'aria-label': 'One more ' + opts.name, onclick: function () { step(1); } }),
      ]),
    ]);
  }

  function promoSection() {
    var section = el('div', { class: 'gcrb-sec' });
    section.appendChild(el('label', { class: 'gcrb-lbl', for: 'gcrb-promo', text: 'Promo code (optional)' }));
    section.appendChild(el('input', {
      class: 'gcrb-in', id: 'gcrb-promo', type: 'text', value: chosen.promo, placeholder: 'Code',
      onchange: function (event) { chosen.promo = event.target.value.trim(); requestQuote(); },
    }));
    if (quote && quote.promo_warning) {
      section.appendChild(el('p', { class: 'gcrb-fine', text: quote.promo_warning }));
    }
    return section;
  }

  // Every figure here came from the server. Nothing is added up locally.
  function totalSection() {
    var section = el('div', { class: 'gcrb-sec gcrb-total' });
    quote.lines.forEach(function (line) {
      section.appendChild(el('div', { class: 'gcrb-line' }, [
        el('span', { text: line.label }),
        el('span', { text: money(line.amount, quote.currency) }),
      ]));
    });
    section.appendChild(el('div', { class: 'gcrb-line gcrb-line-total' }, [
      el('span', { text: 'Total' }),
      el('span', { text: money(quote.total, quote.currency) }),
    ]));
    if (quote.deposit_due > 0 && quote.deposit_due < quote.total) {
      section.appendChild(el('div', { class: 'gcrb-line gcrb-line-due' }, [
        el('span', { text: 'Pay now (deposit)' }),
        el('span', { text: money(quote.deposit_due, quote.currency) }),
      ]));
      section.appendChild(el('div', { class: 'gcrb-line' }, [
        el('span', { text: 'Due on the day' }),
        el('span', { text: money(quote.balance_due, quote.currency) }),
      ]));
    } else if (quote.deposit_due === 0) {
      section.appendChild(el('div', { class: 'gcrb-line gcrb-line-due' }, [
        el('span', { text: 'Pay on the day' }),
        el('span', { text: money(quote.total, quote.currency) }),
      ]));
    }
    return section;
  }

  function detailsSection() {
    var section = el('div', { class: 'gcrb-sec' });
    section.appendChild(el('span', { class: 'gcrb-lbl', text: 'Your details' }));

    [
      { key: 'customer_name', label: 'Full name', type: 'text', required: true },
      { key: 'customer_email', label: 'Email', type: 'email', required: true },
      { key: 'customer_phone', label: 'Mobile', type: 'tel' },
    ].forEach(function (field) {
      section.appendChild(el('input', {
        class: 'gcrb-in', type: field.type, placeholder: field.label + (field.required ? '' : ' (optional)'),
        value: chosen[field.key] || '', style: 'margin-bottom:8px',
        oninput: function (event) { chosen[field.key] = event.target.value; },
      }));
    });

    // The product's own questions, whatever the business put there.
    (product.questions || []).forEach(function (question) {
      if (question.type === 'select' && (question.options || []).length) {
        var select = el('select', {
          class: 'gcrb-in', style: 'margin-bottom:8px',
          onchange: function (event) { chosen['q_' + question.key] = event.target.value; },
        }, [el('option', { value: '', text: question.label })]);
        question.options.forEach(function (option) {
          select.appendChild(el('option', { value: option, text: option }));
        });
        section.appendChild(select);
      } else {
        section.appendChild(el(question.type === 'textarea' ? 'textarea' : 'input', {
          class: 'gcrb-in', placeholder: question.label + (question.required ? '' : ' (optional)'),
          style: 'margin-bottom:8px', rows: question.type === 'textarea' ? 3 : null,
          oninput: function (event) { chosen['q_' + question.key] = event.target.value; },
        }));
      }
    });

    section.appendChild(el('textarea', {
      class: 'gcrb-in', rows: 2, placeholder: 'Anything we should know? (optional)',
      oninput: function (event) { chosen.notes = event.target.value; },
    }));
    return section;
  }

  function readyToBook() {
    if (!chosen.customer_name || !chosen.customer_email) return false;
    if (product.schedule_mode === 'request') return true;
    if (!chosen.date) return false;
    if (needsTime() && !chosen.time) return false;
    var day = availability[chosen.date];
    return !day || day.bookable;
  }

  function bookButtonText() {
    if (!quote) return 'Choose your party size';
    if (quote.pay_now_cents > 0) return 'Pay ' + money(quote.deposit_due, quote.currency) + ' and book';
    return 'Request this booking';
  }

  function policyText() {
    var policy = product.cancellation_policy || {};
    if (policy.free_until_hours != null) {
      return 'Free cancellation up to ' + policy.free_until_hours + ' hours before you start.';
    }
    return 'Cancellation terms are set by the business.';
  }

  function submit() {
    busy = true; message = ''; render();

    var answers = {};
    (product.questions || []).forEach(function (question) {
      if (chosen['q_' + question.key]) answers[question.key] = chosen['q_' + question.key];
    });

    api('/api/booking/public/' + encodeURIComponent(cfg.slug) + '/checkout', {
      product_id: product.id,
      date: chosen.date || undefined,
      end_date: chosen.end_date || undefined,
      time: chosen.time || undefined,
      items: cartItems(),
      extras: cartExtras(),
      promo_code: chosen.promo || undefined,
      customer_name: chosen.customer_name,
      customer_email: chosen.customer_email,
      customer_phone: chosen.customer_phone,
      notes: chosen.notes,
      answers: answers,
      success_url: location.href.split('#')[0],
      cancel_url: location.href.split('#')[0],
    }).then(function (data) {
      if (data.checkout_url) { location.href = data.checkout_url; return; }
      busy = false;
      renderDone(data);
    }).catch(function (err) {
      busy = false;
      message = err.message;
      // A seat taken while they were typing means the calendar on screen is
      // stale — reload it so the next attempt sees what is actually left.
      if (/available|full|gone|closed/i.test(err.message)) loadAvailability();
      else render();
    });
  }

  function renderDone(data) {
    clear(root);
    root.appendChild(el('div', { class: 'gcrb' }, [
      el('div', { class: 'gcrb-ok' }, [
        el('h2', { class: 'gcrb-h', text: 'You are booked' }),
        el('p', { text: 'Confirmation ' + (data.confirmation_code || '') + '. We have emailed the details to ' + chosen.customer_email + '.' }),
        data.payment_required === false && data.total
          ? el('p', { text: 'Payment of ' + money(data.total, product.currency) + ' is due on the day.' })
          : null,
        data.manage_url ? el('p', [el('a', { href: data.manage_url, text: 'View or cancel this booking' })]) : null,
      ]),
    ]));
  }

  // ── go ──
  root.textContent = 'Loading…';
  api('/api/booking/public/' + encodeURIComponent(cfg.slug))
    .then(function (data) {
      page = data;
      injectStyles();
      renderList();
    })
    .catch(function (err) {
      clear(root);
      root.appendChild(el('div', { class: 'gcrb' }, [
        el('div', { class: 'gcrb-err', text: 'Bookings are unavailable right now: ' + err.message }),
      ]));
    });
})();
`;

/**
 * The hosted page, for a business with no website of its own.
 *
 * Loads the same widget the embed serves, so there is one implementation
 * of the checkout rather than two that drift.
 */
function pageHtml(slug, apiBase) {
    const safeSlug = String(slug || '').replace(/[^a-z0-9_-]/gi, '');
    const safeBase = String(apiBase || '').replace(/[^a-z0-9:/._-]/gi, '');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Book online</title>
<style>
  body { margin: 0; padding: 24px 16px; background: #f4f6f8; display: flex; justify-content: center; }
  @media (prefers-color-scheme: dark) { body { background: #0f151b; } }
  #gcr-book { width: 100%; max-width: 640px; }
</style>
</head>
<body>
<div id="gcr-book"></div>
<script src="${safeBase}/api/booking/embed.js" data-slug="${safeSlug}"></script>
</body>
</html>`;
}

module.exports = { WIDGET_JS, pageHtml };
