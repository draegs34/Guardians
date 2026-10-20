(function () {
  'use strict';

  const API = (window.DRAFT_API_URL || '').trim();
  const DEMO = !API;
  const REFRESH_MS = Math.max(5, Number(window.DRAFT_REFRESH_SECONDS) || 10) * 1000;
  const UP_NEXT_COUNT = 10; // rows in Up next, including whoever is on the clock (dropouts aren't listed)

  const $ = (id) => document.getElementById(id);
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  // Calendar names (used by the demo data below, so defined first)
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /* ------------------------------------------------------------------ */
  /* Which draft is showing: 'rs' (regular season), 'post', or 'archive' */
  /* ------------------------------------------------------------------ */
  const VIEWS = { rs: 'regular-season', post: 'postseason', archive: 'past-drafts' };
  const VIEW_KEY = 'guardians-draft-view';
  function initialView() {
    const h = location.hash.replace('#', '');
    for (const k in VIEWS) if (VIEWS[k] === h || k === h) return k;
    const saved = store.get(VIEW_KEY);
    return VIEWS[saved] ? saved : 'post';
  }
  /* Prices sent from the Season Ticket Manager arrive as #prices=ALDS:432,ALCS:646,WS:1090 */
  function readPriceHash() {
    const m = location.hash.match(/prices=([A-Za-z0-9:.,]+)/);
    if (!m) return null;
    const out = {};
    m[1].split(',').forEach((pair) => {
      const [k, v] = pair.split(':');
      const n = Number(v);
      if (k && isFinite(n) && n >= 0) out[k.toUpperCase()] = n;
    });
    return Object.keys(out).length ? out : null;
  }
  let wantNotify = /^#notifications/.test(location.hash);
  /* Member emails sent from the Season Ticket Manager arrive as #emails=<base64url JSON [[name, email], …]> */
  function readEmailHash() {
    const m = location.hash.match(/emails=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4))));
      const list = JSON.parse(json).filter((x) => Array.isArray(x) && x[0] && x[1]).map((x) => ({ from: String(x[0]), email: String(x[1]).trim() }));
      return list.length ? list : null;
    } catch (e) { return null; }
  }
  let sentEmails = readEmailHash();
  let sentPrices = readPriceHash();
  let view = sentPrices ? 'post' : initialView();

  const liveOn = {};            // drafts receiving live Firebase updates (live.js)
  let lastPoll = 0;
  const states = {};            // latest board per draft
  const staleViews = new Set(); // drafts showing a saved copy while live data loads
  let state = null;             // states[view]
  let archives = null;
  let lastPickCount = null;
  let pendingItem = null;
  let pendingName = null;
  let busy = false;

  // Which member this device belongs to (per draft), for turn alerts.
  const meKey = (v) => 'guardians-draft-me:' + v;
  if (store.get('guardians-draft-me') && !store.get(meKey('post'))) store.set(meKey('post'), store.get('guardians-draft-me'));
  let me = store.get(meKey(view)) || '';

  /* ------------------------------------------------------------------ */
  /* Demo backend: in-memory "sheets" run through the same DraftEngine   */
  /* the Apps Script uses (engine.js).                                   */
  /* ------------------------------------------------------------------ */
  const DEMO_SCHEDULE = '853879|2027-04-01|New York Yankees;853882|2027-04-02|New York Yankees;853881|2027-04-03|New York Yankees;853887|2027-04-04|New York Yankees;853888|2027-04-05|Seattle Mariners;853886|2027-04-06|Seattle Mariners;853878|2027-04-07|Seattle Mariners;853866|2027-04-13|Minnesota Twins;853872|2027-04-14|Minnesota Twins;853874|2027-04-15|Minnesota Twins;853870|2027-04-23|Kansas City Royals;853873|2027-04-24|Kansas City Royals;853869|2027-04-25|Kansas City Royals;853868|2027-04-26|Colorado Rockies;853867|2027-04-27|Colorado Rockies;853875|2027-04-28|Colorado Rockies;853871|2027-05-07|Boston Red Sox;853865|2027-05-08|Boston Red Sox;853863|2027-05-09|Boston Red Sox;853862|2027-05-11|Los Angeles Dodgers;853864|2027-05-12|Los Angeles Dodgers;853859|2027-05-13|Los Angeles Dodgers;853857|2027-05-21|Baltimore Orioles;853858|2027-05-22|Baltimore Orioles;853860|2027-05-23|Baltimore Orioles;853861|2027-05-24|Los Angeles Angels;853856|2027-05-25|Los Angeles Angels;853854|2027-05-26|Los Angeles Angels;853852|2027-06-04|Chicago White Sox;853855|2027-06-05|Chicago White Sox;853853|2027-06-06|Chicago White Sox;853848|2027-06-07|Detroit Tigers;853846|2027-06-08|Detroit Tigers;853847|2027-06-09|Detroit Tigers;853849|2027-06-10|Detroit Tigers;853851|2027-06-18|Athletics;853850|2027-06-19|Athletics;853842|2027-06-20|Athletics;853844|2027-06-21|Houston Astros;853845|2027-06-22|Houston Astros;853841|2027-06-23|Houston Astros;853843|2027-07-02|Minnesota Twins;853837|2027-07-03|Minnesota Twins;853835|2027-07-04|Minnesota Twins;853839|2027-07-05|Philadelphia Phillies;853838|2027-07-06|Philadelphia Phillies;853840|2027-07-07|Philadelphia Phillies;853836|2027-07-09|Milwaukee Brewers;853831|2027-07-10|Milwaukee Brewers;853832|2027-07-11|Milwaukee Brewers;853834|2027-07-26|Miami Marlins;853829|2027-07-27|Miami Marlins;853830|2027-07-28|Miami Marlins;853833|2027-07-29|Chicago White Sox;853828|2027-07-30|Chicago White Sox;853827|2027-07-31|Chicago White Sox;853825|2027-08-01|Chicago White Sox;853826|2027-08-03|Texas Rangers;853824|2027-08-04|Texas Rangers;853821|2027-08-05|Texas Rangers;853822|2027-08-13|Toronto Blue Jays;853820|2027-08-14|Toronto Blue Jays;853823|2027-08-15|Toronto Blue Jays;853819|2027-08-16|St. Louis Cardinals;853816|2027-08-17|St. Louis Cardinals;853817|2027-08-18|St. Louis Cardinals;853814|2027-08-20|Tampa Bay Rays;853818|2027-08-21|Tampa Bay Rays;853815|2027-08-22|Tampa Bay Rays;853809|2027-09-03|Atlanta Braves;853810|2027-09-04|Atlanta Braves;853808|2027-09-05|Atlanta Braves;853812|2027-09-06|Detroit Tigers;853811|2027-09-07|Detroit Tigers;853813|2027-09-08|Detroit Tigers;853804|2027-09-21|Kansas City Royals;853806|2027-09-22|Kansas City Royals;853803|2027-09-23|Kansas City Royals;853807|2027-09-24|Cincinnati Reds;853805|2027-09-25|Cincinnati Reds;853802|2027-09-26|Cincinnati Reds';

  const demo = (function () {
    const people = [
      { name: 'Alex', pin: '1111' }, { name: 'Jordan', pin: '2222' },
      { name: 'Casey', pin: '3333' }, { name: 'Morgan', pin: '4444' },
    ];
    const postGames = [
      ['ALDS-G1', 'AL Division Series', 'Game 1', '10/3', 432, ''],
      ['ALDS-G2', 'AL Division Series', 'Game 2', '10/5', 432, ''],
      ['ALDS-G5', 'AL Division Series', 'Game 5', '10/10', 432, 'If necessary'],
      ['ALCS-H1', 'AL Championship Series', 'Home Game 1', 'TBD', 646, 'If Guardians advance'],
      ['ALCS-H2', 'AL Championship Series', 'Home Game 2', 'TBD', 646, 'If Guardians advance'],
      ['ALCS-H3', 'AL Championship Series', 'Home Game 3', 'TBD', 646, 'If necessary'],
      ['ALCS-H4', 'AL Championship Series', 'Home Game 4', 'TBD', 646, 'If necessary; Only if Guardians have home-field advantage'],
      ['WS-H1', 'World Series', 'Home Game 1', 'TBD', 1090, 'If Guardians advance'],
      ['WS-H2', 'World Series', 'Home Game 2', 'TBD', 1090, 'If Guardians advance'],
      ['WS-H3', 'World Series', 'Home Game 3', 'TBD', 1090, 'If necessary'],
      ['WS-H4', 'World Series', 'Home Game 4', 'TBD', 1090, 'If necessary; Only if Guardians have home-field advantage'],
    ];
    const postInv = [];
    postGames.forEach((g) => ['7 & 8', '9 & 10'].forEach((seats) => {
      postInv.push({ id: g[0] + '-S' + seats.split(' ')[0], series: g[1], game: g[2], date: g[3], seats, price: g[4], notes: g[5] });
    }));
    const rsInv = DEMO_SCHEDULE.split(';').map((line) => {
      const [id, date, opp] = line.split('|');
      const day = dowOf(date);
      return { id, date, day, opponent: opp, time: 'TBD', promos: '', notes: '', series: 'Regular Season', game: 'vs ' + opp, seats: 'All 4 seats', price: '', label: day + ' ' + mdOf(date) + ' vs ' + opp };
    });
    const drafts = {
      post: {
        settings: { kind: 'post', title: '2026 Guardians Postseason Draft', snake: true, maxPicks: 0, open: true, commissionerPin: '0000' },
        members: people.map((p, i) => Object.assign({ order: i + 1 }, p)),
        inventory: postInv, rows: [],
      },
      rs: {
        settings: { kind: 'rs', title: '2027 Guardians Regular Season Draft', snake: true, maxPicks: 0, open: true, commissionerPin: '0000', timeLimitOn: false, timeLimitHours: 24 },
        members: [Object.assign({ cap: 10 }, people[0]), Object.assign({ cap: 5 }, people[1]), Object.assign({ cap: 5 }, people[2]), Object.assign({ cap: 6 }, people[3])],
        order: ['Alex', 'Jordan', 'Casey', 'Alex', 'Morgan'],
        inventory: rsInv, rows: [],
      },
    };
    const demoArchives = [];
    const data = (k) => {
      const d = drafts[k];
      const out = { settings: d.settings, members: d.members, inventory: d.inventory, events: d.rows.map((r, i) => DraftEngine.rowToEvent(r, i + 2)) };
      if (d.order) out.order = d.order;
      return out;
    };
    const demoPrefs = {};
    function post(body) {
      const k = body.draft === 'rs' ? 'rs' : 'post';
      const d = drafts[k];
      if (body.action === 'archive') {
        if (String(body.pin || '').trim() !== d.settings.commissionerPin) return Object.assign(DraftEngine.publicState(data(k)), { ok: false, error: "That commissioner PIN doesn't match." });
        if (!d.rows.length) return Object.assign(DraftEngine.publicState(data(k)), { ok: false, error: 'There are no picks to archive.' });
        demoArchives.unshift({
          title: d.settings.title, kind: k, archivedAt: new Date().toISOString(),
          rows: d.rows.map((r) => Object.assign(DraftEngine.rowToEvent(r, 0), { series: r[4], game: r[5], date: r[6], seats: r[7], price: r[8] })),
        });
        d.rows = [];
        return Object.assign(DraftEngine.publicState(data(k)), { ok: true, message: 'Archived "' + d.settings.title + '". The board is cleared and ready for next time.' });
      }
      if (body.action === 'setPrices') {
        if (k !== 'post' || body.pin !== d.settings.commissionerPin) return Object.assign(DraftEngine.publicState(data(k)), { ok: false, error: "That commissioner PIN doesn't match." });
        d.inventory.forEach((i) => { const key = i.id.split('-')[0].toUpperCase(); if (key in body.prices) i.price = body.prices[key]; });
        return Object.assign(DraftEngine.publicState(data(k)), { ok: true, message: 'Prices updated.' });
      }
      if (body.action === 'setEmails') {
        if (String(body.pin || '').trim() !== d.settings.commissionerPin) return { ok: false, error: "That commissioner PIN doesn't match." };
        (body.emails || []).forEach((e) => { const p = demoPrefs[e.name] = demoPrefs[e.name] || { email: '', emailOn: false, pushOn: false, nextUp: false, tokens: [] }; if (!p.email || body.replace) { p.email = e.email; p.emailOn = true; } });
        return { ok: true, message: 'Demo mode: ' + (body.emails || []).length + ' emails saved.' };
      }
      if (/^notify/.test(body.action || '')) {
        const m = d.members.find((x) => x.name === body.name);
        if (!m) return { ok: false, error: 'Choose your name.' };
        if (m.pin && String(body.pin || '').trim() !== m.pin && String(body.pin || '').trim() !== d.settings.commissionerPin) return { ok: false, error: "That PIN doesn't match." };
        const p = demoPrefs[body.name] = demoPrefs[body.name] || { email: '', emailOn: false, pushOn: false, nextUp: false, tokens: [] };
        if (body.action === 'notifySave') {
          Object.assign(p, body.prefs || {});
          if (body.addToken && !p.tokens.includes(body.addToken)) p.tokens.push(body.addToken);
          if (body.removeToken) p.tokens = p.tokens.filter((t) => t !== body.removeToken);
          return { ok: true, message: 'Notification settings saved (demo only).', prefs: Object.assign({}, p, { devices: p.tokens.length }) };
        }
        if (body.action === 'notifyTest') return { ok: true, message: 'Demo mode: nothing was sent.' };
        return { ok: true, prefs: Object.assign({}, p, { devices: p.tokens.length, hasThisDevice: !!body.token && p.tokens.includes(body.token) }), emailReady: false };
      }
      const r = DraftEngine.apply(data(k), body);
      if (r.ok && r.append) d.rows.push(r.append);
      if (r.ok && r.deleteRow) d.rows.splice(r.deleteRow - 2, 1);
      return Object.assign(DraftEngine.publicState(data(k)), { ok: r.ok, error: r.error, message: r.message });
    }
    return {
      get: (k) => Promise.resolve(DraftEngine.publicState(data(k))),
      post: (b) => new Promise((res) => setTimeout(() => res(post(b)), 250)),
      archives: () => Promise.resolve({ ok: true, archives: demoArchives }),
    };
  })();

  /* ------------------------------------------------------------------ */
  /* Network                                                              */
  /* ------------------------------------------------------------------ */
  function getJson(params) {
    const q = Object.keys(params).map((k) => k + '=' + encodeURIComponent(params[k])).join('&');
    return fetch(API + (API.includes('?') ? '&' : '?') + q + '&t=' + Date.now(), { method: 'GET' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function apiGet(draft) {
    if (DEMO) return demo.get(draft);
    return getJson({ draft });
  }
  function apiArchives() {
    if (DEMO) return demo.archives();
    return getJson({ view: 'archives' });
  }
  function apiPost(body) {
    body.draft = view;
    if (DEMO) return demo.post(body);
    // text/plain avoids a CORS preflight, which Apps Script doesn't answer.
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Apps Script sometimes saves a change but the reply never makes it back to
   * the browser. When a POST fails, re-read the board and check whether the
   * change actually landed before telling anyone it failed.
   */
  async function postVerified(body, landed) {
    const before = state;
    const draft = view;
    try {
      const res = await apiPost(body);
      if (res && typeof res === 'object') return res;
      throw new Error('Empty reply');
    } catch (err) {
      console.warn('No usable reply from the draft; checking whether it saved.', err);
      let reads = 0;
      for (let i = 0; i < 5; i++) {
        await sleep(i === 0 ? 700 : 1500);
        let s;
        try { s = await apiGet(draft); } catch (e) { continue; }
        if (!s || s.ok === false || !s.inventory) continue;
        if (draft === view) { apply(s); markSynced(); }
        if (landed(s, before)) return Object.assign({}, s, { ok: true, verified: true });
        if (++reads >= 2) return Object.assign({}, s, { ok: false, error: "That didn't go through. Please try again." });
      }
      throw err;
    }
  }

  let failStreak = 0;
  function markSynced() {
    failStreak = 0;
    $('sync').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    $('sync').classList.remove('err');
  }

  /* Saved copy of the last board per draft, shown instantly on the next visit
     while the live data loads. Picking stays locked until the live board arrives. */
  const cacheKey = (v) => 'guardians-draft-board:' + API + ':' + v;
  function saveCache(v, s) {
    if (DEMO || !s || !s.inventory) return;
    store.set(cacheKey(v), JSON.stringify({ at: Date.now(), s }));
  }
  function loadCache(v) {
    if (DEMO) return null;
    try {
      const raw = store.get(cacheKey(v)) || (v === 'post' ? store.get('guardians-draft-board:' + API) : null);
      const c = JSON.parse(raw || 'null');
      if (c && c.s && c.s.inventory && Date.now() - c.at < 7 * 24 * 3600 * 1000) return c;
    } catch (e) { /* ignore */ }
    return null;
  }

  function refresh() {
    if (view === 'archive') return loadArchives();
    const draft = view;
    lastPoll = Date.now();
    return apiGet(draft).then((s) => {
      if (draft !== view) return; // switched drafts while this was loading
      if (s && s.notSetUp) { staleViews.delete(draft); states[draft] = s; state = s; markSynced(); renderNotSetUp(); return; }
      if (!s || s.ok === false) throw new Error((s && s.error) || 'Bad response');
      staleViews.delete(draft);
      apply(s);
      markSynced();
    }).catch((err) => {
      console.warn(err);
      // One missed refresh is normal with Apps Script; only warn if it keeps happening.
      if (++failStreak >= 2) {
        $('sync').textContent = "Can't reach the draft — retrying…";
        $('sync').classList.add('err');
      }
    });
  }

  // "Did it land?" checks used by postVerified()
  const lastKey = (s) => s && s.picks.length + '|' + JSON.stringify(s.picks[s.picks.length - 1] || null);
  const changed = (s, before) => lastKey(s) !== lastKey(before);

  /* ------------------------------------------------------------------ */
  /* Dates, holidays and game flags (regular season)                      */
  /* ------------------------------------------------------------------ */
  function ymd(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? [+m[1], +m[2], +m[3]] : null; }
  function dowOf(iso) { const p = ymd(iso); return p ? DOW[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()] : ''; }
  function mdOf(iso) { const p = ymd(iso); return p ? p[1] + '/' + p[2] : ''; }
  function nthWeekday(y, month, dow, n) { // n = 1..5, or -1 for last
    if (n > 0) { const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay(); return 1 + ((dow - first + 7) % 7) + (n - 1) * 7; }
    const lastDay = new Date(Date.UTC(y, month, 0)).getUTCDate();
    const lastDow = new Date(Date.UTC(y, month - 1, lastDay)).getUTCDay();
    return lastDay - ((lastDow - dow + 7) % 7);
  }
  const holidayCache = {};
  function holidaysFor(y) {
    if (holidayCache[y]) return holidayCache[y];
    const pad = (n) => String(n).padStart(2, '0');
    const h = {};
    h[y + '-05-' + pad(nthWeekday(y, 5, 0, 2))] = "Mother's Day";
    h[y + '-05-' + pad(nthWeekday(y, 5, 1, -1))] = 'Memorial Day';
    h[y + '-06-' + pad(nthWeekday(y, 6, 0, 3))] = "Father's Day";
    h[y + '-07-04'] = 'Fourth of July';
    h[y + '-09-' + pad(nthWeekday(y, 9, 1, 1))] = 'Labor Day';
    return (holidayCache[y] = h);
  }
  function minutesOf(time) {
    const m = String(time || '').match(/^(\d{1,2}):(\d{2})\s*([AP])M/i);
    if (!m) return null;
    let h = +m[1] % 12; if (m[3].toUpperCase() === 'P') h += 12;
    return h * 60 + +m[2];
  }
  function gameFlags(g, openerId) {
    const p = ymd(g.date);
    const dow = dowOf(g.date);
    const mins = minutesOf(g.time);
    const holiday = p ? holidaysFor(p[0])[g.date] || '' : '';
    return {
      dow,
      weekend: dow === 'Sat' || dow === 'Sun',
      dayGame: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(dow) && mins != null && mins < 17 * 60,
      holiday,
      opener: g.id === openerId,
      promos: String(g.promos || '').split(';').map((x) => x.trim()).filter(Boolean),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                            */
  /* ------------------------------------------------------------------ */
  // First-load messaging: Apps Script can take several seconds to wake up.
  const SKELETON_BOARD = $('board').innerHTML;
  const SKELETON_UP = $('upcoming').innerHTML;
  let loadTimers = [];
  function startLoading() {
    $('clock').className = 'clock loading';
    $('clock').querySelector('.clock-label').textContent = 'Getting the latest picks';
    $('clock-name').innerHTML = '<span class="loader" aria-hidden="true"><i></i><i></i><i></i></span>';
    $('clock-meta').innerHTML = '<span id="load-msg">Loading the draft board…</span>';
    $('board').innerHTML = SKELETON_BOARD;
    $('board').setAttribute('aria-busy', 'true');
    $('upcoming').innerHTML = SKELETON_UP;
    $('log').innerHTML = '';
    $('totals').innerHTML = '';
    $('rs-filters').hidden = true;
    loadTimers.forEach(clearTimeout);
    loadTimers = [
      [4000, 'Waking up the Google Sheet — this can take a few seconds…'],
      [10000, 'Almost there…'],
      [20000, 'Still working. Check your connection if this keeps going.'],
    ].map(([ms, text]) => setTimeout(() => { if (!states[view] && $('load-msg')) $('load-msg').textContent = text; }, ms));
  }

  function apply(s) {
    loadTimers.forEach(clearTimeout);
    $('clock').classList.remove('loading');
    $('board').removeAttribute('aria-busy');
    if (!staleViews.has(view)) saveCache(view, s);
    const prevIds = state && state.picks ? new Set(state.picks.map((p) => p.itemId)) : null;
    states[view] = s;
    state = s;
    render(prevIds);
    if (lastPickCount !== null && s.picks.length > lastPickCount && !busy) {
      const p = s.picks[s.picks.length - 1];
      const item = s.inventory.find((i) => i.id === p.itemId);
      if (p.type === 'drop') toast(p.member + ' dropped out of the draft');
      else if (p.type === 'skip') toast(p.member + "'s turn was skipped" + (/auto/i.test(p.note || '') ? ' (time ran out)' : ''));
      else if (item) toast(p.member + (p.assigned ? ' was assigned ' : ' took ') + shortLabel(item));
    }
    lastPickCount = s.picks.length;
    // Opened from the "Change your notification settings" link in an email
    if (wantNotify && s.members && !setupOpen && !document.querySelector('dialog[open]')) { wantNotify = false; openNotify(); }
  }

  const isRS = (s) => s && s.kind === 'rs';
  function shortLabel(item) {
    if (item.label) return item.label;
    return item.series.replace(/^AL /, '') + ' ' + item.game + ' · ' + item.seats;
  }

  // Notes can hold several badges separated by ";" (e.g. "If necessary; Only if ... home-field advantage")
  function badges(notes) {
    const parts = String(notes || '').split(';').map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return '';
    return '<div class="badges">' + parts.map((t) => {
      const hf = /home.?field/i.test(t);
      return '<span class="cond' + (hf ? ' hf' : '') + '">' + esc(t) + '</span>';
    }).join('') + '</div>';
  }

  function renderNotSetUp() {
    loadTimers.forEach(clearTimeout);
    const label = view === 'rs' ? 'regular season' : 'postseason';
    $('clock').className = 'clock paused';
    $('clock').querySelector('.clock-label').textContent = 'Not set up yet';
    $('clock-name').textContent = 'Coming soon';
    $('clock-meta').textContent = 'The ' + label + ' draft hasn\'t been set up yet.';
    $('board').removeAttribute('aria-busy');
    $('board').innerHTML = window.FIREBASE_CONFIG
      ? '<div class="notice-card"><strong>The ' + label + ' draft isn\'t set up yet.</strong><br>Commissioner: open <em>Commissioner tools</em> to import your data or start it empty.</div>'
      : '<div class="notice-card"><strong>The ' + label + ' draft isn\'t set up yet.</strong><br>Commissioner: in the Google Sheet, choose <em>Guardians Draft → Set up ' + label + (view === 'rs' ? ' draft' : ' tabs') + '</em>.</div>';
    $('rs-filters').hidden = true;
    $('upcoming').innerHTML = '<li class="empty">Nothing yet.</li>';
    $('log').innerHTML = '<li class="empty">No picks yet.</li>';
    $('totals').innerHTML = '';
    $('turn-alert').hidden = true;
    setTitleFlash(false);
  }

  function render(prevIds) {
    try { renderPriceTool(); } catch (e) { /* tool not ready */ }
    try { renderEmailBanner(); } catch (e) { /* tool not ready */ }
    const s = state;
    if (!s || s.notSetUp) { if (s) renderNotSetUp(); return; }
    const rs = isRS(s);
    baseTitle = s.title || 'Ticket Draft';
    if (!titleTimer) document.title = baseTitle;
    $('title').textContent = s.title || 'Ticket Draft';
    $('demo-banner').hidden = !DEMO;
    const stale = staleViews.has(view);

    const takenBy = {};
    s.picks.forEach((p) => { if (p.itemId) takenBy[p.itemId] = p; });
    const itemPicks = s.picks.filter((p) => p.itemId);
    const left = s.inventory.length - itemPicks.length;
    const done = !s.current;
    const unit = rs ? 'games' : 'seat pairs';

    // On the clock
    const clock = $('clock');
    clock.classList.toggle('done', done);
    clock.classList.toggle('paused', !done && !s.open);
    if (done) {
      $('clock-name').textContent = 'Draft complete';
      $('clock-meta').textContent = itemPicks.length + ' ' + unit + ' claimed' + (left > 0 ? ', ' + left + ' unclaimed' : '') + '.';
      clock.querySelector('.clock-label').textContent = 'Final';
    } else {
      clock.querySelector('.clock-label').textContent = s.open ? 'On the clock' : 'Draft paused';
      // Slow-pick indicator: over an hour since the last pick/turn change.
      const since = DraftEngine.turnStart(s.picks);
      const waited = since ? Date.now() - since : 0;
      const slow = waited >= 60 * 60 * 1000;
      $('clock-name').innerHTML = esc(s.current.name) + (slow ? ' <span class="slow-clock" aria-hidden="true">' + CLOCK_SVG + '</span>' : '');
      let meta = 'Round ' + s.current.round + ' · Pick ' + s.current.pick + ' · ' + left + ' ' + (rs ? (left === 1 ? 'game' : 'games') : '') + (rs ? ' left' : 'left') + (s.snake ? ' · Snake order' : '');
      if (s.deadline && s.open) {
        const ms = new Date(s.deadline).getTime() - Date.now();
        meta += ' · ' + (ms > 0 ? fmtLeft(ms) + ' left to pick' : 'Time is up');
      }
      $('clock-meta').textContent = meta.replace(/ {2}/g, ' ');
    }

    const canPick = !done && s.open && !stale;
    document.body.classList.toggle('stale', stale);
    if (stale) $('clock-meta').textContent += ' · Updating…';

    // Board
    $('board-heading').textContent = rs ? 'Home games' : 'Games';
    if (rs) renderRsBoard(s, takenBy, canPick, prevIds);
    else { $('rs-filters').hidden = true; renderPostBoard(s, takenBy, canPick, prevIds); }

    // Up next. The server trims this list to the number of items left, but if
    // someone ahead drops out the draft keeps going, so rebuild a longer list
    // here (same rules, engine.js) and mark the extras as "if needed".
    let up = done ? [] : [s.current].concat(s.upcoming || []);
    if (!done) {
      try {
        const slots = (s.order && s.order.length ? s.order : s.members.map((m) => m.name)).map((n) => ({ name: n }));
        const full = DraftEngine.computeTurn(slots, s.picks, s.maxPicks, s.snake, UP_NEXT_COUNT - 1, s.caps || {});
        if (full.current && full.current.name === s.current.name && full.current.pick === s.current.pick) {
          up = [s.current].concat(full.upcoming);
        }
      } catch (e) { /* fall back to the server's list */ }
    }
    up = up.filter((t) => !t.out).slice(0, UP_NEXT_COUNT);
    let eligibleIdx = 0;
    $('upcoming').innerHTML = up.length
      ? up.map((t) => {
          const extra = eligibleIdx++ >= left; // only gets a turn if someone ahead drops out
          const cls = [me && t.name === me ? 'me' : '', extra ? 'standby' : ''].filter(Boolean).join(' ');
          return '<li' + (cls ? ' class="' + cls + '"' : '') + '><span>' + esc(t.name) + '</span><span class="meta">' +
            (extra ? 'If needed' : 'Rd ' + t.round + ' · #' + t.pick) + '</span></li>';
        }).join('')
      : '<li class="empty">Nothing left to pick.</li>';

    // Members
    const tot = {};
    const outNames = {};
    s.members.forEach((m) => { tot[m.name] = { n: 0, owed: 0, cap: m.cap || null }; if (m.out) outNames[m.name] = true; });
    itemPicks.forEach((p) => {
      const it = s.inventory.find((i) => i.id === p.itemId);
      if (!tot[p.member]) tot[p.member] = { n: 0, owed: 0, cap: null };
      tot[p.member].n++;
      tot[p.member].owed += it && it.price ? Number(it.price) : 0;
    });
    $('totals-head').innerHTML = rs
      ? '<tr><th>Name</th><th class="num">Games</th><th class="num">Left</th></tr>'
      : '<tr><th>Name</th><th class="num">Picks</th><th class="num">Owed</th></tr>';
    $('totals').innerHTML = Object.keys(tot).map((name) => {
      const t = tot[name];
      const third = rs ? (t.cap ? Math.max(0, t.cap - t.n) : '—') : money(t.owed);
      return '<tr' + (outNames[name] ? ' class="out"' : '') + '><td>' + (outNames[name] ? '<s>' + esc(name) + '</s> <span class="meta">out</span>' : esc(name)) +
        '</td><td class="num">' + t.n + (rs && t.cap ? '<span class="meta"> / ' + t.cap + '</span>' : '') + '</td><td class="num">' + third + '</td></tr>';
    }).join('');

    // Log
    $('log').innerHTML = s.picks.length
      ? s.picks.slice().reverse().map((p) => {
          const it = s.inventory.find((i) => i.id === p.itemId);
          const num = p.number ? '#' + p.number + ' ' : '';
          const when = etTime(p.time);
          const stamp = when ? '<time class="log-time" datetime="' + esc(p.time) + '">' + esc(when) + '</time>' : '';
          let body;
          if (p.type === 'skip') body = '<b>' + num + esc(p.member) + '</b> — <span class="meta">' + (/auto/i.test(p.note || '') ? 'turn skipped (time ran out)' : 'turn skipped') + '</span>';
          else if (p.type === 'drop') body = '<b>' + num + esc(p.member) + '</b> — <span class="meta">dropped out of the draft</span>';
          else {
            const what = it ? (it.label || it.series.replace(/^AL /, '') + ' ' + it.game + ' · Seats ' + it.seats) : p.itemId;
            body = '<b>' + (p.assigned ? '' : num) + esc(p.member) + '</b> — ' + esc(what) + (p.assigned ? ' <span class="meta">(assigned)</span>' : '');
          }
          return '<li>' + body + stamp + '</li>';
        }).join('')
      : '<li class="empty">No picks yet.</li>';

    renderMe(s, done);
    $('skip-who').textContent = s.current ? s.current.name : 'nobody';
    $('skip-btn').disabled = !s.current;
    $('archive-title').textContent = s.title || 'this draft';
  }

  function renderPostBoard(s, takenBy, canPick, prevIds) {
    const seatCols = [];
    s.inventory.forEach((i) => { if (!seatCols.includes(i.seats)) seatCols.push(i.seats); });
    const series = [];
    const bySeries = {};
    s.inventory.forEach((i) => {
      if (!bySeries[i.series]) { bySeries[i.series] = { name: i.series, games: [], gameMap: {}, prices: new Set() }; series.push(bySeries[i.series]); }
      const sr = bySeries[i.series];
      sr.prices.add(i.price);
      const key = i.game + '|' + i.date;
      if (!sr.gameMap[key]) { sr.gameMap[key] = { game: i.game, date: i.date, notes: i.notes, seats: {} }; sr.games.push(sr.gameMap[key]); }
      sr.gameMap[key].seats[i.seats] = i;
    });

    $('board').innerHTML = series.map((sr) => {
      const prices = Array.from(sr.prices);
      const priceText = prices.length === 1 ? money(prices[0]) + ' per pair' : prices.map(money).join(' / ');
      return '<div class="series"><div class="series-head"><h3>' + esc(sr.name) + '</h3><span class="price">' + esc(priceText) + '</span></div>' +
        sr.games.map((g) => {
          const info = '<div class="game-info"><div class="game-name">' + esc(g.game) + '</div>' +
            '<div class="game-sub">' + (g.date && g.date !== 'TBD' ? esc(g.date) : 'Date TBD') + '</div>' +
            badges(g.notes) + '</div>';
          const cells = seatCols.map((sc) => {
            const it = g.seats[sc];
            if (!it) return '<div></div>';
            return seatCell(it, takenBy[it.id], canPick, prevIds, 'Seats ' + sc, sr.name + ' ' + g.game + ' seats ' + sc);
          }).join('');
          return '<div class="game" style="--cols:' + seatCols.length + '">' + info + cells + '</div>';
        }).join('') + '</div>';
    }).join('');
  }

  function seatCell(it, p, canPick, prevIds, label, aria) {
    const fresh = prevIds && p && !prevIds.has(it.id) ? ' just' : '';
    if (p) {
      return '<div class="seat taken' + fresh + '" title="' + (p.assigned ? 'Assigned by commissioner' : 'Pick #' + p.number) + '"><span class="s-label">' + esc(label) + '</span><span class="s-val">' + esc(p.member) + '</span></div>';
    }
    if (!canPick) return '<div class="seat"><span class="s-label">' + esc(label) + '</span><span class="s-val">Available</span></div>';
    return '<button type="button" class="seat open" data-id="' + esc(it.id) + '" aria-label="Pick ' + esc(aria) + '"><span class="s-label">' + esc(label) + '</span><span class="s-val">Pick</span></button>';
  }

  /* Regular season board: one row per home game, all four seats per pick. */
  const rsFilter = { avail: 'all', tag: 'all', month: '', opp: '' };
  function renderRsBoard(s, takenBy, canPick, prevIds) {
    const games = s.inventory.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const openerId = games.length ? games[0].id : null;
    const enriched = games.map((g) => ({ g, f: gameFlags(g, openerId), p: takenBy[g.id] }));

    // Filter bar (only rebuilt when its options change, so it keeps focus).
    const months = [...new Set(games.map((g) => String(g.date).slice(0, 7)).filter(Boolean))];
    const opps = [...new Set(games.map((g) => g.opponent).filter(Boolean))].sort();
    const fb = $('rs-filters');
    const sig = months.join(',') + '|' + opps.join(',');
    if (fb.dataset.sig !== sig) {
      const chip = (k, v, t) => '<button type="button" class="fchip" data-fk="' + k + '" data-fv="' + v + '">' + t + '</button>';
      fb.innerHTML =
        '<div class="frow" role="group" aria-label="Show">' + chip('avail', 'all', 'All games') + chip('avail', 'open', 'Available') + '</div>' +
        '<div class="frow" role="group" aria-label="Highlights">' + chip('tag', 'all', 'Any') + chip('tag', 'weekend', 'Weekends') +
          chip('tag', 'daygame', 'Weekday day games') + chip('tag', 'holiday', 'Holidays') + chip('tag', 'promo', 'Promotions') + '</div>' +
        '<div class="frow selects"><label>Month <select data-fsel="month"><option value="">All</option>' +
          months.map((m) => { const p = m.split('-'); return '<option value="' + m + '">' + MONTH_FULL[+p[1] - 1] + '</option>'; }).join('') +
        '</select></label><label>Opponent <select data-fsel="opp"><option value="">All</option>' +
          opps.map((o) => '<option>' + esc(o) + '</option>').join('') + '</select></label>' +
        '<span class="fcount" id="fcount"></span></div>';
      fb.dataset.sig = sig;
    }
    fb.hidden = false;
    fb.querySelectorAll('.fchip').forEach((b) => b.setAttribute('aria-pressed', String(rsFilter[b.dataset.fk] === b.dataset.fv)));
    fb.querySelectorAll('select[data-fsel]').forEach((sel) => { if (sel !== document.activeElement) sel.value = rsFilter[sel.dataset.fsel]; });

    const shown = enriched.filter(({ g, f, p }) => {
      if (rsFilter.avail === 'open' && p) return false;
      if (rsFilter.tag === 'weekend' && !f.weekend) return false;
      if (rsFilter.tag === 'daygame' && !f.dayGame) return false;
      if (rsFilter.tag === 'holiday' && !f.holiday) return false;
      if (rsFilter.tag === 'promo' && !f.promos.length) return false;
      if (rsFilter.month && String(g.date).slice(0, 7) !== rsFilter.month) return false;
      if (rsFilter.opp && g.opponent !== rsFilter.opp) return false;
      return true;
    });
    const fc = $('fcount');
    if (fc) fc.textContent = shown.length + ' of ' + games.length + ' games';

    if (!shown.length) {
      $('board').innerHTML = '<div class="notice-card">' + (games.length ? 'No games match these filters.' : 'No games loaded yet. Commissioner: choose <em>Guardians Draft → Refresh regular season schedule from MLB</em> in the Google Sheet.') + '</div>';
      return;
    }
    const groups = [];
    shown.forEach((x) => {
      const key = String(x.g.date).slice(0, 7);
      let grp = groups[groups.length - 1];
      if (!grp || grp.key !== key) { grp = { key, items: [] }; groups.push(grp); }
      grp.items.push(x);
    });
    $('board').innerHTML = groups.map((grp) => {
      const p = grp.key.split('-');
      const name = p.length === 2 ? MONTH_FULL[+p[1] - 1] + ' ' + p[0] : 'Date TBD';
      const open = grp.items.filter((x) => !x.p).length;
      return '<div class="series rs-month"><div class="series-head"><h3>' + esc(name) + '</h3><span class="price">' + open + ' of ' + grp.items.length + ' open</span></div>' +
        grp.items.map(({ g, f, p: pick }) => {
          const d = ymd(g.date);
          const tags = [];
          if (f.opener) tags.push('<span class="cond tag-opener">Home Opener</span>');
          if (f.holiday) tags.push('<span class="cond tag-holiday">' + esc(f.holiday) + '</span>');
          if (f.dayGame) tags.push('<span class="cond tag-day">Weekday day game</span>');
          f.promos.forEach((pr) => tags.push('<span class="cond tag-promo">' + esc(pr) + '</span>'));
          String(g.notes || '').split(';').map((x) => x.trim()).filter(Boolean).forEach((n) => tags.push('<span class="cond">' + esc(n) + '</span>'));
          const time = g.time && !/^tbd$/i.test(g.time) ? esc(g.time) + ' ET' : 'Time TBD';
          const hl = f.holiday ? ' hl-holiday' : f.dayGame ? ' hl-day' : '';
          return '<div class="rsg' + (pick ? ' is-taken' : '') + hl + '">' +
            '<div class="rsg-date' + (f.weekend ? ' wknd' : '') + '"><span class="mon">' + (d ? MON[d[1] - 1] : '') + '</span><span class="dnum">' + (d ? d[2] : '?') + '</span><span class="dow">' + esc(f.dow) + '</span></div>' +
            '<div class="rsg-info"><div class="game-name">vs ' + esc(g.opponent) + '</div><div class="game-sub">' + time + '</div>' +
              (tags.length ? '<div class="badges">' + tags.join('') + '</div>' : '') + '</div>' +
            '<div class="rsg-act">' + seatCell(g, pick, canPick, prevIds, 'Seats 7–10', g.label || g.game) + '</div></div>';
        }).join('') + '</div>';
    }).join('');
  }

  $('rs-filters').addEventListener('click', (e) => {
    const b = e.target.closest('.fchip');
    if (!b) return;
    rsFilter[b.dataset.fk] = b.dataset.fv;
    if (state) render(null);
  });
  $('rs-filters').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-fsel]');
    if (!sel) return;
    rsFilter[sel.dataset.fsel] = sel.value;
    if (state) render(null);
  });

  /* ------------------------------------------------------------------ */
  /* Past drafts                                                          */
  /* ------------------------------------------------------------------ */
  function loadArchives() {
    return apiArchives().then((r) => {
      if (view !== 'archive') return;
      archives = (r && r.archives) || [];
      markSynced();
      renderArchives();
    }).catch((err) => {
      console.warn(err);
      if (view === 'archive' && !archives) $('archive-list').innerHTML = '<p class="empty">Couldn\'t load past drafts. Trying again…</p>';
    });
  }
  function renderArchives() {
    if (!archives) { $('archive-list').innerHTML = '<p class="empty">Loading…</p>'; return; }
    if (!archives.length) {
      $('archive-list').innerHTML = '<div class="notice-card">No archived drafts yet. The commissioner can archive a finished draft from <em>Commissioner tools → Archive this draft</em>.</div>';
      return;
    }
    $('archive-list').innerHTML = archives.map((a, i) => {
      const picks = a.rows.filter((r) => r.type === 'pick' || r.type === 'assign');
      const when = a.archivedAt ? new Date(a.archivedAt) : null;
      return '<details class="card arch"' + (i === 0 ? ' open' : '') + '><summary><span class="arch-title">' + esc(a.title) + '</span>' +
        '<span class="meta">' + picks.length + (picks.length === 1 ? ' pick' : ' picks') + (when && !isNaN(when) ? ' · archived ' + when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '') + '</span></summary>' +
        '<div class="tbl"><table class="arch-table"><thead><tr><th>#</th><th>Member</th><th>Game</th><th>Seats</th><th>When</th></tr></thead><tbody>' +
        a.rows.map((r) => {
          let game, seats = r.seats || '';
          if (r.type === 'skip') { game = /auto/i.test(r.note || '') ? 'Turn skipped (time ran out)' : 'Turn skipped'; seats = ''; }
          else if (r.type === 'drop') { game = 'Dropped out'; seats = ''; }
          else if (a.kind === 'rs' || /^\d{4}-\d{2}-\d{2}$/.test(r.date)) game = (dowOf(r.date) + ' ' + mdOf(r.date) + ' ' + r.game).trim();
          else game = (r.series ? r.series.replace(/^AL /, '') + ' ' : '') + r.game + (r.date && r.date !== 'TBD' ? ' (' + r.date + ')' : '');
          return '<tr' + (r.type === 'skip' || r.type === 'drop' ? ' class="dim"' : '') + '><td>' + (r.type === 'assign' ? 'A' : r.number || '') + '</td><td>' + esc(r.member) + '</td><td>' + esc(game) + '</td><td>' + esc(seats) + '</td><td class="meta">' + esc(etTime(r.time)) + '</td></tr>';
        }).join('') + '</tbody></table></div></details>';
    }).join('');
  }

  /* ------------------------------------------------------------------ */
  /* Switching drafts                                                     */
  /* ------------------------------------------------------------------ */
  function syncSwitch() {
    document.querySelectorAll('#draft-switch button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
    const arch = view === 'archive';
    $('archive-view').hidden = !arch;
    ['clock', 'me-bar', 'layout'].forEach((id) => { const el = $(id) || document.querySelector('.' + id); if (el) el.hidden = arch; });
  }
  function switchView(v) {
    if (!VIEWS[v] || v === view) return;
    view = v;
    store.set(VIEW_KEY, v);
    if (history.replaceState) history.replaceState(null, '', '#' + VIEWS[v]);
    lastPickCount = null;
    setTitleFlash(false);
    $('turn-alert').hidden = true;
    if (setupOpen) setupVisible(false);
    syncSwitch();
    if (v === 'archive') {
      if (window.DraftLive) window.DraftLive.watch(null);
      document.title = 'Past drafts';
      $('title').textContent = 'Past drafts';
      renderArchives();
      loadArchives();
      return;
    }
    me = store.get(meKey(v)) || '';
    $('me-select').dataset.sig = '';
    showDraft();
    if (window.DraftLive) window.DraftLive.watch(v);
    refresh();
  }
  function showDraft() {
    state = states[view] || null;
    if (state) { if (state.notSetUp) renderNotSetUp(); else render(null); lastPickCount = state.picks ? state.picks.length : null; return; }
    const cached = loadCache(view);
    if (cached) {
      staleViews.add(view);
      apply(cached.s);
      $('sync').innerHTML = '<span class="mini-spin" aria-hidden="true"></span>Updating…';
    } else {
      startLoading();
    }
  }
  $('draft-switch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) switchView(b.dataset.view);
  });
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    for (const k in VIEWS) if (VIEWS[k] === h) switchView(k);
  });
  // (A #prices=… link from the Season Ticket Manager is handled with the price tool below.)

  /* ------------------------------------------------------------------ */
  /* Pick flow                                                            */
  /* ------------------------------------------------------------------ */
  $('board').addEventListener('click', (e) => {
    const btn = e.target.closest('.seat.open');
    if (!btn || !state) return;
    const item = state.inventory.find((i) => i.id === btn.dataset.id);
    if (!item) return;
    pendingItem = item;
    if (isRS(state)) {
      const d = ymd(item.date);
      const f = gameFlags(item, null);
      const extras = [f.holiday, f.dayGame ? 'Weekday day game' : ''].concat(f.promos).filter(Boolean);
      $('pick-item').innerHTML = '<div class="pi-title">' + esc(f.dow) + ', ' + (d ? MON[d[1] - 1] + ' ' + d[2] : '') + ' — vs ' + esc(item.opponent) + '</div>' +
        '<div class="pi-sub">All 4 seats (7–10) · ' + (item.time && !/^tbd$/i.test(item.time) ? esc(item.time) + ' ET' : 'Time TBD') + (extras.length ? ' · ' + esc(extras.join(' · ')) : '') + '</div>';
    } else {
      $('pick-item').innerHTML = '<div class="pi-title">' + esc(item.series) + ' — ' + esc(item.game) + '</div>' +
        '<div class="pi-sub">Seats ' + esc(item.seats) + ' · ' + (item.date && item.date !== 'TBD' ? esc(item.date) + ' · ' : '') + money(item.price) + '</div>';
    }
    pendingName = state.current ? state.current.name : null;
    $('pick-for').textContent = pendingName || '';
    $('pick-submit').textContent = 'Lock it in for ' + (pendingName || '');
    $('pick-error').textContent = '';
    const mem = state.members.find((m) => m.name === pendingName);
    const needsPin = !mem || mem.needsPin !== false;
    $('pick-pin-wrap').hidden = !needsPin;
    $('pick-pin').required = needsPin;
    $('pick-pin').value = '';
    $('pick-dialog').showModal();
    setTimeout(() => (needsPin ? $('pick-pin') : $('pick-submit')).focus(), 50);
  });

  $('pick-cancel').addEventListener('click', () => $('pick-dialog').close());

  $('pick-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pendingItem || busy) return;
    busy = true;
    $('pick-submit').disabled = true;
    $('pick-submit').textContent = 'Saving…';
    $('pick-error').textContent = '';
    const want = { id: pendingItem.id, name: pendingName };
    postVerified({ action: 'pick', name: pendingName, pin: $('pick-pin').value, itemId: pendingItem.id },
      (s) => s.picks.some((p) => p.itemId === want.id && p.member === want.name))
      .then((res) => {
        if (res && res.inventory) apply(res);
        if (res && res.ok) {
          $('pick-dialog').close();
          toast(res.message || (res.verified ? 'Pick saved for ' + want.name + '.' : 'Pick saved.'));
          render(null);
        } else {
          $('pick-error').textContent = (res && res.error) || 'Something went wrong.';
        }
      })
      .catch(() => { $('pick-error').textContent = "Couldn't reach the draft. Check the pick log in a few seconds before trying again — it may have saved."; })
      .finally(() => {
        busy = false;
        lastPickCount = state && state.picks ? state.picks.length : lastPickCount;
        $('pick-submit').disabled = false;
        $('pick-submit').textContent = 'Lock it in for ' + (pendingName || '');
      });
  });

  /* Commissioner */
  function fillAssignLists() {
    if (!state || !state.inventory) return;
    const rs = isRS(state);
    $('assign-heading').textContent = rs ? 'Assign a game' : 'Assign a seat pair';
    $('assign-hint').textContent = rs
      ? "Give an open game to any member. It doesn't use a turn in the draft order, but it does count toward their games."
      : "Give an open game and seats to any member. This doesn't use up anyone's turn in the draft order.";
    $('assign-item-label').textContent = rs ? 'Game' : 'Game & seats';
    const taken = new Set(state.picks.filter((p) => p.itemId).map((p) => p.itemId));
    $('assign-member').innerHTML = '<option value="">Choose member…</option>' +
      state.members.map((m) => '<option>' + esc(m.name) + '</option>').join('');
    const open = state.inventory.filter((i) => !taken.has(i.id));
    $('assign-item').innerHTML = '<option value="">' + (open.length ? (rs ? 'Choose a game…' : 'Choose game & seats…') : 'Nothing left to assign') + '</option>' +
      open.map((i) => '<option value="' + esc(i.id) + '">' + esc(rs ? i.label : i.series.replace(/^AL /, '') + ' — ' + i.game + ' · Seats ' + i.seats + ' · ' + money(i.price)) + '</option>').join('');
  }

  /* Season Ticket Manager price update (postseason draft) */
  const ROUND_NAMES = { WC: 'Wild Card', ALDS: 'Division Series', ALCS: 'Championship Series', WS: 'World Series' };
  function currentPrice(prefix) {
    const ps = states.post;
    const it = ps && ps.inventory && ps.inventory.find((i) => i.id.split('-')[0].toUpperCase() === prefix);
    return it ? it.price : null;
  }
  function renderPriceTool() {
    const show = !!sentPrices && view === 'post' && !!(states.post && states.post.inventory);
    $('price-banner').hidden = !show;
    $('prices-tool').hidden = !show;
    if (!show) return;
    const keys = Object.keys(sentPrices).filter((k) => currentPrice(k) !== null);
    const diff = keys.filter((k) => currentPrice(k) !== sentPrices[k]);
    $('price-banner-text').textContent = diff.length
      ? 'Season Ticket Manager sent new prices for ' + diff.join(', ') + '.'
      : 'Season Ticket Manager prices already match this draft.';
    $('price-review').hidden = !diff.length;
    $('price-list').innerHTML = keys.map((k) => {
      const c = currentPrice(k), n = sentPrices[k];
      return '<li><span>' + esc(ROUND_NAMES[k] || k) + '</span><span>' + (c === n ? money(n) + ' <em>no change</em>' : '<s>' + money(c) + '</s> → <strong>' + money(n) + '</strong>') + '</span></li>';
    }).join('');
    $('prices-btn').disabled = !diff.length;
  }
  function clearPriceHash() {
    sentPrices = null;
    try { history.replaceState(null, '', location.pathname + location.search + '#' + VIEWS[view]); } catch (e) { location.hash = VIEWS[view]; }
    renderPriceTool();
  }
  window.addEventListener('hashchange', () => {
    const p = readPriceHash();
    if (p) { sentPrices = p; if (view !== 'post') switchView('post'); else renderPriceTool(); }
  });
  $('price-review').addEventListener('click', () => $('commish-btn').click());
  $('prices-btn').addEventListener('click', () => {
    if (!sentPrices) return;
    const prices = sentPrices;
    const pricesLanded = (s) => Object.keys(prices).every((k) =>
      s.inventory.filter((i) => i.id.split('-')[0].toUpperCase() === k).every((i) => i.price === prices[k]));
    commishAction({ action: 'setPrices', prices }, $('prices-btn'), pricesLanded, (res) => { if (res && res.ok) clearPriceHash(); });
  });

  $('commish-btn').addEventListener('click', () => {
    if (!state || state.notSetUp) {
      if (window.FIREBASE_CONFIG) openSetup('');
      else toast('This draft isn\'t set up yet.');
      return;
    }
    $('commish-pin').value = '';
    $('commish-error').textContent = '';
    disarmArchive();
    fillAssignLists();
    renderPriceTool();
    renderEmailTool();
    $('setup-tool').hidden = !window.FIREBASE_CONFIG;
    $('commish-dialog').showModal();
    setTimeout(() => $('commish-pin').focus(), 50);
  });
  $('commish-cancel').addEventListener('click', () => $('commish-dialog').close());
  $('commish-form').addEventListener('submit', (e) => e.preventDefault());

  function commishAction(body, btn, landed, after) {
    if (busy) return;
    if (!$('commish-pin').value.trim()) { $('commish-error').textContent = 'Enter your commissioner PIN.'; return; }
    busy = true;
    btn.disabled = true;
    $('commish-error').textContent = '';
    body.pin = $('commish-pin').value;
    postVerified(body, landed || changed)
      .then((res) => {
        if (res && res.inventory) apply(res);
        if (after) after(res);
        if (res && res.ok) { $('commish-dialog').close(); toast(res.message || 'Saved.'); archives = null; }
        else { $('commish-error').textContent = (res && res.error) || 'Something went wrong.'; fillAssignLists(); }
      })
      .catch(() => { $('commish-error').textContent = "Couldn't reach the draft."; })
      .finally(() => { busy = false; btn.disabled = false; disarmArchive(); lastPickCount = state && state.picks ? state.picks.length : lastPickCount; });
  }

  $('assign-btn').addEventListener('click', () => {
    const name = $('assign-member').value;
    const itemId = $('assign-item').value;
    if (!name || !itemId) { $('commish-error').textContent = 'Choose a member and a game.'; return; }
    commishAction({ action: 'assign', name, itemId }, $('assign-btn'));
  });
  $('undo-btn').addEventListener('click', () => commishAction({ action: 'undo' }, $('undo-btn')));
  $('skip-btn').addEventListener('click', () => {
    if (!state || !state.current) return;
    commishAction({ action: 'skip', name: state.current.name }, $('skip-btn'));
  });

  // Archive needs two clicks so it can't happen by accident.
  let archiveArmed = false;
  function disarmArchive() {
    archiveArmed = false;
    $('archive-btn').classList.remove('armed');
    $('archive-btn').textContent = 'Archive this draft…';
  }
  $('archive-btn').addEventListener('click', () => {
    if (!$('commish-pin').value.trim()) { $('commish-error').textContent = 'Enter your commissioner PIN.'; return; }
    if (!archiveArmed) {
      archiveArmed = true;
      $('archive-btn').classList.add('armed');
      $('archive-btn').textContent = 'Yes, archive and clear the board';
      $('commish-error').textContent = '';
      return;
    }
    commishAction({ action: 'archive' }, $('archive-btn'), (s) => s.picks.length === 0);
  });

  /* Drop out */
  $('drop-btn').addEventListener('click', () => {
    if (!state || !state.members) return;
    const active = state.members.filter((m) => !m.out);
    $('drop-name').innerHTML = '<option value="">Choose your name…</option>' +
      active.map((m) => '<option>' + esc(m.name) + '</option>').join('');
    $('drop-pin').value = '';
    $('drop-confirm').checked = false;
    $('drop-error').textContent = '';
    $('drop-dialog').showModal();
  });
  $('drop-cancel').addEventListener('click', () => $('drop-dialog').close());
  $('drop-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    const name = $('drop-name').value;
    if (!name) { $('drop-error').textContent = 'Choose your name.'; return; }
    if (!$('drop-confirm').checked) { $('drop-error').textContent = 'Tick the box to confirm.'; return; }
    busy = true;
    $('drop-submit').disabled = true;
    $('drop-error').textContent = '';
    postVerified({ action: 'drop', name, pin: $('drop-pin').value },
      (s) => s.members.some((m) => m.name === name && m.out))
      .then((res) => {
        if (res && res.inventory) apply(res);
        if (res && res.ok) { $('drop-dialog').close(); toast(res.message || name + ' dropped out of the draft.'); }
        else $('drop-error').textContent = (res && res.error) || 'Something went wrong.';
      })
      .catch(() => { $('drop-error').textContent = "Couldn't reach the draft."; })
      .finally(() => { busy = false; $('drop-submit').disabled = false; lastPickCount = state && state.picks ? state.picks.length : lastPickCount; });
  });

  /* ------------------------------------------------------------------ */
  /* Commissioner setup (Firebase backend): members, PINs, draft order,  */
  /* games, settings, MLB schedule, CSV download, and importing data.    */
  /* ------------------------------------------------------------------ */
  let setupOpen = false;
  let adminPin = '';
  let adminData = null;   // what the setup screen is editing
  let setupBusy = false;

  function setupVisible(on) {
    setupOpen = on;
    $('setup-view').hidden = !on;
    ['clock', 'me-bar', 'layout'].forEach((id) => { const el = $(id) || document.querySelector('.' + id); if (el) el.hidden = on || view === 'archive'; });
    if (on) window.scrollTo(0, 0);
  }
  function openSetup(pin) {
    adminPin = pin || '';
    adminData = null;
    setupVisible(true);
    $('setup-title').textContent = (view === 'rs' ? 'Regular season' : 'Postseason') + ' draft';
    if (!state || state.notSetUp || !adminPin) { renderSetup(); return; }
    $('setup-body').innerHTML = '<p class="empty">Loading setup…</p>';
    apiPost({ action: 'adminGet', pin: adminPin }).then((res) => {
      if (!res || !res.ok) { $('setup-body').innerHTML = '<div class="notice-card">' + esc((res && res.error) || 'Couldn\'t load setup.') + (res && /isn't available|Unknown action/i.test(res.error || '') ? '' : '') + '</div>'; return; }
      adminData = res.admin;
      renderSetup();
    }).catch(() => { $('setup-body').innerHTML = '<div class="notice-card">Couldn\'t reach the draft. Try again in a moment.</div>'; });
  }
  $('setup-back').addEventListener('click', () => { setupVisible(false); syncSwitch(); if (state) { if (state.notSetUp) renderNotSetUp(); else render(null); } });
  $('setup-btn').addEventListener('click', () => {
    const pin = $('commish-pin').value.trim();
    if (!pin) { $('commish-error').textContent = 'Enter your commissioner PIN.'; return; }
    $('commish-dialog').close();
    openSetup(pin);
  });

  const field = (label, html, hint) => '<label class="sf"><span>' + label + '</span>' + html + (hint ? '<small>' + hint + '</small>' : '') + '</label>';
  const inp = (bind, val, attrs) => '<input data-bind="' + bind + '" value="' + esc(val == null ? '' : val) + '" ' + (attrs || '') + '>';
  const chk = (bind, on, text) => '<label class="check"><input type="checkbox" data-bind="' + bind + '"' + (on ? ' checked' : '') + '> ' + text + '</label>';
  const iconBtn = (act, i, label, sym, dis) => '<button type="button" class="icon-btn" data-act="' + act + '" data-i="' + i + '" aria-label="' + label + '"' + (dis ? ' disabled title="' + esc(dis) + '"' : '') + '>' + sym + '</button>';

  function renderSetup() {
    const rs = view === 'rs';
    const a = adminData;
    const importCard =
      '<section class="card sc"><h3>Import data</h3>' +
      '<p class="hint">Moving from the Google Sheet: in the sheet choose <em>Guardians Draft → Export everything for Firebase</em>, copy the text and paste it here. ' +
      'It replaces the drafts and past drafts it contains. Use the <strong>setup key</strong> you chose when deploying (or your current commissioner PIN).</p>' +
      '<textarea id="import-text" rows="5" placeholder="Paste the export here"></textarea>' +
      field('Setup key or commissioner PIN', '<input id="import-key" type="password" autocomplete="off">') +
      '<div class="row-btns"><button type="button" class="btn primary" data-act="import">Import</button></div></section>';
    if (!a) {
      $('setup-body').innerHTML = (state && !state.notSetUp && !adminPin ? '' :
        '<div class="notice-card">This draft isn\'t set up in Firebase yet. Import your data from the Google Sheet, or start it empty and fill it in here.</div>') +
        importCard +
        '<section class="card sc"><h3>Start this draft empty</h3><p class="hint">Creates the ' + (rs ? 'regular season' : 'postseason') + ' draft with one placeholder member. You can then add members, games and settings here.</p>' +
        field('Commissioner PIN for this draft', '<input id="fresh-pin" autocomplete="off">') +
        field('Setup key', '<input id="fresh-key" type="password" autocomplete="off">', 'The private phrase you chose when deploying.') +
        '<div class="row-btns"><button type="button" class="btn" data-act="fresh">Create empty draft</button></div></section>';
      return;
    }
    const s = a.settings || {};
    const picked = new Set(((states[view] && states[view].picks) || []).filter((p) => p.itemId).map((p) => p.itemId));
    const names = a.members.map((m) => m.name).filter(Boolean);

    let html = '<section class="card sc"><h3>Settings</h3><div class="sgrid">' +
      field('Draft title', inp('settings.title', s.title)) +
      (rs ? field('Season', inp('settings.season', s.season, 'inputmode="numeric"'), 'Used when loading the schedule from MLB') : field('Max picks per member', inp('settings.maxPicks', s.maxPicks || '', 'inputmode="numeric" placeholder="No limit"'))) +
      field('New commissioner PIN', '<input data-bind="newCommissionerPin" autocomplete="off" placeholder="Leave blank to keep it">') +
      '</div><div class="checks">' +
      chk('settings.open', s.open, '<strong>Draft open</strong> (members can pick)') +
      chk('settings.snake', s.snake !== false, 'Snake order (reverses every round)') +
      (rs ? chk('settings.timeLimitOn', s.timeLimitOn, 'Pick time limit') + '<label class="sf inline"><span>Hours per pick</span>' + inp('settings.timeLimitHours', s.timeLimitHours || 24, 'inputmode="numeric" style="width:90px"') + '</label>' : '') +
      '</div></section>';

    html += '<section class="card sc"><h3>Members</h3><p class="hint">' + (rs ? 'Games purchased is each member\'s limit for this draft.' : 'The list order is the draft order.') + ' Leave a PIN blank to let someone pick without one. Adding an email turns on email alerts for that member; they can change it themselves under <em>Email &amp; push alerts</em>. Emails are shared by both drafts.</p>' +
      '<div class="tbl"><table class="stable"><thead><tr><th>Name</th><th>PIN</th>' + (rs ? '<th>Games</th>' : '') + '<th>Email (for turn alerts)</th><th></th></tr></thead><tbody>' +
      a.members.map((m, i) => '<tr><td>' + inp('members.' + i + '.name', m.name, 'placeholder="Name"') + '</td><td>' + inp('members.' + i + '.pin', m.pin, 'autocomplete="off" class="pin-in"') + '</td>' +
        (rs ? '<td>' + inp('members.' + i + '.cap', m.cap || '', 'inputmode="numeric" class="num-in"') + '</td>' : '') +
        '<td>' + inp('members.' + i + '.email', m.email || '', 'type="email" placeholder="Optional" class="email-in"') + '</td>' +
        '<td class="acts">' + (rs ? '' : iconBtn('up-member', i, 'Move up', '↑', i === 0 ? 'Already first' : '') + iconBtn('down-member', i, 'Move down', '↓', i === a.members.length - 1 ? 'Already last' : '')) +
        iconBtn('del-member', i, 'Remove ' + m.name, '✕') + '</td></tr>').join('') +
      '</tbody></table></div><div class="row-btns"><button type="button" class="btn ghost" data-act="add-member">+ Add member</button></div></section>';

    if (rs) {
      const slotCount = {};
      a.order.forEach((n) => { slotCount[n] = (slotCount[n] || 0) + 1; });
      const warn = a.members.filter((m) => m.name && Number(m.cap) > 0 && (slotCount[m.name] || 0) !== Math.floor(Number(m.cap) / 5))
        .map((m) => esc(m.name) + ' has ' + (slotCount[m.name] || 0) + ' slot' + ((slotCount[m.name] || 0) === 1 ? '' : 's') + ' (' + m.cap + ' games → ' + Math.floor(Number(m.cap) / 5) + ')');
      html += '<section class="card sc"><h3>Draft order</h3><p class="hint">One row per slot in a round: list each member once for every 5 games purchased. ' +
        '<strong>' + a.order.length + ' slots = ' + a.order.length + ' picks per round.</strong> Snake order reverses each round.</p>' +
        (warn.length ? '<p class="warn">Check: ' + warn.join('; ') + '.</p>' : '') +
        '<ol class="slots">' + a.order.map((n, i) => '<li><span class="slot-no">' + (i + 1) + '</span><select data-bind="order.' + i + '">' +
          (names.includes(n) ? '' : '<option value="' + esc(n) + '" selected>' + esc(n || 'Choose…') + '</option>') +
          names.map((x) => '<option' + (x === n ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select>' +
          iconBtn('up-slot', i, 'Move up', '↑', i === 0 ? 'Already first' : '') + iconBtn('down-slot', i, 'Move down', '↓', i === a.order.length - 1 ? 'Already last' : '') + iconBtn('del-slot', i, 'Remove slot', '✕') + '</li>').join('') + '</ol>' +
        '<div class="row-btns"><button type="button" class="btn ghost" data-act="add-slot">+ Add slot</button>' +
        '<button type="button" class="btn ghost" data-act="fill-order">Rebuild from games purchased</button></div></section>';
    }

    html += '<section class="card sc"><h3>' + (rs ? 'Home games' : 'Games & seat pairs') + '</h3>' +
      (rs ? '<p class="hint">Load or refresh from MLB any time: dates, opponents and start times update, promotions fill in when MLB lists them, and your notes are kept. Save your other changes first.</p>' +
        '<div class="row-btns"><button type="button" class="btn primary" data-act="load-mlb">Load / refresh schedule from MLB</button></div>'
        : '<p class="hint">Notes show as badges; separate several with ";". Item IDs starting ALDS-, ALCS-, WS- get prices from the Season Ticket Manager.</p>') +
      '<div class="tbl"><table class="stable games"><thead><tr>' +
      (rs ? '<th>Date</th><th>Opponent</th><th>Time (ET)</th><th>Promotions</th><th>Notes</th>' : '<th>Item ID</th><th>Series</th><th>Game</th><th>Date</th><th>Seats</th><th>Price</th><th>Notes</th>') + '<th></th></tr></thead><tbody>' +
      a.inventory.map((g, i) => {
        const lock = picked.has(g.id) ? 'Already picked — undo the pick first' : '';
        const c = (k, extra) => '<td>' + inp('inventory.' + i + '.' + k, g[k], extra) + '</td>';
        return '<tr' + (lock ? ' class="picked"' : '') + '>' + (rs
          ? c('date', 'placeholder="2027-04-01" class="date-in"') + c('opponent') + c('time', 'class="time-in"') + c('promos') + c('notes')
          : c('id', 'class="id-in"') + c('series') + c('game') + c('date', 'class="time-in"') + c('seats', 'class="time-in"') + c('price', 'inputmode="decimal" class="num-in"') + c('notes')) +
          '<td class="acts">' + iconBtn('del-game', i, 'Remove game', '✕', lock) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="row-btns"><button type="button" class="btn ghost" data-act="add-game">+ Add ' + (rs ? 'game' : 'seat pair') + '</button></div></section>';

    html += '<section class="card sc"><h3>Picks</h3><p class="hint">Download every pick, assignment, skip and drop-out in this draft. Opens in Excel, Numbers or Google Sheets.</p>' +
      '<div class="row-btns"><button type="button" class="btn ghost" data-act="csv">Download picks (CSV)</button></div></section>';
    html += importCard;
    html += '<div class="save-bar"><span class="hint" id="setup-msg"></span><button type="button" class="btn primary" data-act="save">Save setup</button></div>';
    $('setup-body').innerHTML = html;
  }

  function setPath(obj, path, val) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = val;
  }
  $('setup-body').addEventListener('input', (e) => {
    const el = e.target.closest('[data-bind]');
    if (!el || !adminData) return;
    const path = el.dataset.bind;
    if (path === 'newCommissionerPin') { adminData.newCommissionerPin = el.value.trim(); return; }
    setPath(adminData, path, el.type === 'checkbox' ? el.checked : el.value);
    if (/^order\.|\.cap$/.test(path)) { const y = window.scrollY; renderSetup(); window.scrollTo(0, y); }
  });
  $('setup-body').addEventListener('change', (e) => {
    const el = e.target.closest('[data-bind]');
    if (el && el.type === 'checkbox' && adminData) setPath(adminData, el.dataset.bind, el.checked);
  });

  function move(list, i, d) { const j = i + d; if (j < 0 || j >= list.length) return; const t = list[i]; list[i] = list[j]; list[j] = t; }
  $('setup-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || setupBusy) return;
    const i = Number(b.dataset.i);
    const a = adminData;
    const y = window.scrollY;
    const redraw = () => { renderSetup(); window.scrollTo(0, y); };
    switch (b.dataset.act) {
      case 'add-member': a.members.push({ name: '', pin: '', cap: 0, email: '' }); return redraw();
      case 'del-member': a.members.splice(i, 1); return redraw();
      case 'up-member': move(a.members, i, -1); return redraw();
      case 'down-member': move(a.members, i, 1); return redraw();
      case 'add-slot': a.order.push(a.members[0] ? a.members[0].name : ''); return redraw();
      case 'del-slot': a.order.splice(i, 1); return redraw();
      case 'up-slot': move(a.order, i, -1); return redraw();
      case 'down-slot': move(a.order, i, 1); return redraw();
      case 'fill-order': {
        const out = [];
        a.members.forEach((m) => { for (let k = 0; k < Math.floor(Number(m.cap) / 5); k++) out.push(m.name); });
        if (!out.length) { toast('Enter Games purchased for members first.'); return; }
        a.order = out;
        toast('Order rebuilt: ' + out.length + ' slots. Rearrange them into your draft order, then save.');
        return redraw();
      }
      case 'add-game':
        a.inventory.push(view === 'rs' ? { id: 'custom-' + Date.now(), date: '', opponent: '', time: 'TBD', promos: '', notes: '' } : { id: '', series: '', game: '', date: '', seats: '', price: 0, notes: '' });
        return redraw();
      case 'del-game': a.inventory.splice(i, 1); return redraw();
      case 'csv': return downloadCsv();
      case 'save': return saveSetup(b);
      case 'load-mlb': return setupCall(b, { action: 'loadSchedule', pin: adminPin }, true);
      case 'import': return doImport(b);
      case 'fresh': return doFresh(b);
    }
  });

  function setupCall(btn, body, reload) {
    setupBusy = true;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Working…';
    return apiPost(body).then((res) => {
      if (res && res.inventory && body.action !== 'import') apply(res);
      if (res && res.ok) {
        toast(res.message || 'Saved.');
        if (reload) return apiPost({ action: 'adminGet', pin: body.newPin || adminPin }).then((r2) => { if (r2 && r2.ok) { adminData = r2.admin; renderSetup(); } });
      } else {
        toast((res && res.error) || 'Something went wrong.');
        const m = $('setup-msg'); if (m) m.textContent = (res && res.error) || '';
      }
      return res;
    }).catch(() => toast("Couldn't reach the draft. Try again.")).finally(() => { setupBusy = false; btn.disabled = false; btn.textContent = label; });
  }
  function saveSetup(btn) {
    const a = adminData;
    const body = { action: 'adminSave', pin: adminPin, admin: { settings: a.settings, members: a.members, order: a.order, inventory: a.inventory } };
    if (a.newCommissionerPin) { body.admin.newCommissionerPin = a.newCommissionerPin; body.newPin = a.newCommissionerPin; }
    setupCall(btn, body, true).then((res) => { if (res && res.ok && body.newPin) { adminPin = body.newPin; toast('Saved. Your new commissioner PIN is active.'); } });
  }
  function doImport(btn) {
    let payload;
    try { payload = JSON.parse($('import-text').value); } catch (e) { toast('That doesn\'t look like the export text. Copy all of it and try again.'); return; }
    const key = $('import-key').value.trim();
    if (!key) { toast('Enter your setup key or commissioner PIN.'); return; }
    setupCall(btn, { action: 'import', setupKey: key, payload }).then((res) => {
      if (res && res.ok) { states.post = undefined; states.rs = undefined; setupVisible(false); syncSwitch(); refresh(); }
    });
  }
  function doFresh(btn) {
    const pin = $('fresh-pin').value.trim();
    const key = $('fresh-key').value.trim();
    if (!pin || !key) { toast('Enter a commissioner PIN and your setup key.'); return; }
    const payload = {};
    payload[view] = { settings: { title: view === 'rs' ? 'Regular Season Draft' : 'Postseason Draft', open: false, snake: true, season: String(new Date().getFullYear() + 1) }, commissionerPin: pin, members: [{ name: 'Member 1' }], order: ['Member 1'], inventory: [], events: [] };
    setupCall(btn, { action: 'import', setupKey: key, payload }).then((res) => { if (res && res.ok) openSetup(pin); });
  }

  function downloadCsv() {
    const s = states[view];
    if (!s || !s.picks) { toast('No picks to download yet.'); return; }
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['Pick #', 'Round', 'Member', 'Type', 'Game', 'Date', 'Seats', 'Price', 'Time (ET)']];
    s.picks.forEach((p) => {
      const it = s.inventory.find((i) => i.id === p.itemId) || {};
      const type = p.type === 'assign' ? 'Assigned' : p.type === 'skip' ? (/auto/i.test(p.note || '') ? 'Skipped (time ran out)' : 'Skipped') : p.type === 'drop' ? 'Dropped out' : 'Pick';
      const game = it.label || (it.series ? it.series + ' ' + it.game : p.game || '');
      rows.push([p.number || '', p.round || '', p.member, type, game, it.date || p.date || '', it.seats || p.seats || '', it.price || p.price || '', etTime(p.time)]);
    });
    const blob = new Blob([rows.map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (s.title || 'draft').replace(/[^\w-]+/g, '-') + '-picks.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }



  /* ------------------------------------------------------------------ */
  /* Member emails sent from the Season Ticket Manager                    */
  /* ------------------------------------------------------------------ */
  const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z]/g, '');
  function draftMemberNames() {
    const set = new Set();
    ['post', 'rs'].forEach((k) => ((states[k] && states[k].members) || []).forEach((m) => set.add(m.name)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }
  function guessMember(from, names) {
    const exact = names.find((n) => normName(n) === normName(from));
    if (exact) return exact;
    // e.g. "Molly & Tom Jones" in the Manager vs "Molly Jones" here: every word of the draft name appears in the Manager name
    const words = String(from).toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const hits = names.filter((n) => String(n).toLowerCase().split(/[^a-z]+/).filter(Boolean).every((w) => words.includes(w)));
    return hits.length === 1 ? hits[0] : '';
  }
  let emailOtherLoading = false;
  function ensureBothDrafts() {
    const other = view === 'rs' ? 'post' : 'rs';
    if (states[other] || emailOtherLoading || view === 'archive') return;
    emailOtherLoading = true;
    apiGet(other).then((s) => { if (s && !s.notSetUp && s.members) { states[other] = s; renderEmailTool(); } }).catch(() => {}).finally(() => { emailOtherLoading = false; });
  }
  function renderEmailBanner() {
    const show = !!sentEmails && view !== 'archive' && !!state && !state.notSetUp;
    $('email-banner').hidden = !show;
    if (show) $('email-banner-text').textContent = sentEmails.length + ' member email' + (sentEmails.length === 1 ? '' : 's') + ' arrived from the Season Ticket Manager.';
  }
  function renderEmailTool() {
    const show = !!sentEmails && view !== 'archive';
    $('emails-tool').hidden = !show;
    if (!show) return;
    ensureBothDrafts();
    const names = draftMemberNames();
    sentEmails.forEach((e) => { if (e.to === undefined || (!e.to && !e.touched)) e.to = guessMember(e.from, names); });
    $('email-map').innerHTML = sentEmails.map((e, i) =>
      '<div class="em-row' + (e.to ? '' : ' unmatched') + '"><div><div class="em-who">' + esc(e.from) + '</div><div class="em-addr">' + esc(e.email) + '</div></div>' +
      '<select data-em="' + i + '" aria-label="Draft member for ' + esc(e.from) + '"><option value="">Skip (not in draft)</option>' +
      names.map((n) => '<option' + (n === e.to ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select></div>').join('');
  }
  $('email-map').addEventListener('change', (ev) => {
    const sel = ev.target.closest('select[data-em]');
    if (!sel) return;
    const e = sentEmails[Number(sel.dataset.em)];
    e.to = sel.value;
    e.touched = true;
    sel.closest('.em-row').classList.toggle('unmatched', !sel.value);
  });
  $('email-review').addEventListener('click', () => $('commish-btn').click());
  window.addEventListener('hashchange', () => {
    const e = readEmailHash();
    if (e) { sentEmails = e; renderEmailBanner(); }
  });
  $('emails-btn').addEventListener('click', () => {
    if (!sentEmails || busy) return;
    if (!$('commish-pin').value.trim()) { $('commish-error').textContent = 'Enter your commissioner PIN.'; return; }
    const emails = sentEmails.filter((e) => e.to).map((e) => ({ name: e.to, email: e.email }));
    if (!emails.length) { $('commish-error').textContent = 'Match at least one email to a draft member.'; return; }
    busy = true;
    $('emails-btn').disabled = true;
    $('commish-error').textContent = '';
    apiPost({ action: 'setEmails', pin: $('commish-pin').value, emails, replace: $('email-replace').checked })
      .then((res) => {
        if (res && res.ok) {
          sentEmails = null;
          try { history.replaceState(null, '', location.pathname + location.search + '#' + VIEWS[view]); } catch (e) { /* ignore */ }
          renderEmailBanner();
          $('commish-dialog').close();
          toast(res.message || 'Emails updated.');
        } else $('commish-error').textContent = (res && res.error) || 'Something went wrong.';
      })
      .catch(() => { $('commish-error').textContent = "Couldn't reach the draft."; })
      .finally(() => { busy = false; $('emails-btn').disabled = false; });
  });

  /* ------------------------------------------------------------------ */
  /* Email & push alerts: each member chooses what they get               */
  /* ------------------------------------------------------------------ */
  const PUSH_TOKEN_KEY = 'guardians-draft-push-token';
  let notifyName = '';
  let notifyPin = '';
  let notifyPrefs = null;
  let notifyBusy = false;

  function notifyPost(body) {
    body.name = notifyName;
    body.pin = notifyPin;
    return apiPost(body);
  }
  function openNotify() {
    if (!state || !state.members) { toast('One moment, the draft is still loading.'); wantNotify = true; return; }
    const names = state.members.map((m) => m.name);
    $('notify-name').innerHTML = '<option value="">Choose your name…</option>' + names.map((n) => '<option>' + esc(n) + '</option>').join('');
    $('notify-name').value = names.includes(notifyName) ? notifyName : (names.includes(me) ? me : '');
    $('notify-pin').value = '';
    $('notify-error').textContent = '';
    showNotifyStep(!!notifyPrefs && $('notify-name').value === notifyName);
    syncNotifyPinField();
    $('notify-dialog').showModal();
  }
  function syncNotifyPinField() {
    const m = state && state.members.find((x) => x.name === $('notify-name').value);
    $('notify-pin-wrap').hidden = !!m && !m.needsPin;
  }
  function showNotifyStep(settings) {
    $('notify-who').hidden = settings;
    $('notify-settings').hidden = !settings;
    if (settings) fillNotify();
  }
  function fillNotify() {
    const p = notifyPrefs || {};
    $('notify-for').textContent = notifyName;
    $('notify-email').value = p.email || '';
    $('notify-email-on').checked = !!p.emailOn;
    $('notify-next').checked = !!p.nextUp;
    renderPushStatus();
  }
  async function renderPushStatus() {
    const st = window.DraftPush ? await window.DraftPush.status() : 'off';
    const p = notifyPrefs || {};
    const mine = !!store.get(PUSH_TOKEN_KEY) && p.hasThisDevice;
    const others = Math.max(0, (p.devices || 0) - (mine ? 1 : 0));
    const btn = $('push-btn');
    const more = others ? ' Also on ' + others + ' other device' + (others === 1 ? '' : 's') + '.' : '';
    btn.hidden = false;
    btn.disabled = false;
    if (st === 'off') {
      $('push-status').textContent = DEMO ? 'Push works once the draft is live.' : "Push isn't set up yet. Email works now.";
      btn.hidden = true;
    } else if (st === 'ios-install') {
      $('push-status').innerHTML = 'On iPhone or iPad, first add this page to your Home Screen: tap <strong>Share</strong> → <strong>Add to Home Screen</strong>. Then open the draft from that icon and come back here.' + esc(more);
      btn.hidden = true;
    } else if (st === 'unsupported') {
      $('push-status').textContent = "This browser can't receive push notifications. Try Chrome, Edge, Firefox or Safari, or use email." + more;
      btn.hidden = true;
    } else if (st === 'denied') {
      $('push-status').textContent = 'Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.' + more;
      btn.hidden = true;
    } else if (mine) {
      $('push-status').innerHTML = '<span class="push-on">✓ On for this device.</span>' + esc(more);
      btn.textContent = 'Turn off for this device';
      btn.dataset.mode = 'off';
    } else {
      $('push-status').textContent = 'Get a notification on this ' + (/Mobi|Android|iPhone/i.test(navigator.userAgent) ? 'phone' : 'device') + " when it's your turn." + more;
      btn.textContent = 'Turn on for this device';
      btn.dataset.mode = 'on';
    }
  }
  function notifyDone(res) {
    if (res && res.ok) {
      if (res.prefs) notifyPrefs = Object.assign({}, notifyPrefs, res.prefs, { hasThisDevice: 'hasThisDevice' in res.prefs ? res.prefs.hasThisDevice : notifyPrefs && notifyPrefs.hasThisDevice });
      return true;
    }
    $('notify-error').textContent = (res && res.error) || 'Something went wrong.';
    return false;
  }
  function withNotifyBusy(btn, fn) {
    if (notifyBusy) return;
    notifyBusy = true;
    btn.disabled = true;
    $('notify-error').textContent = '';
    Promise.resolve().then(fn)
      .catch((e) => { console.warn(e); $('notify-error').textContent = "Couldn't reach the draft. Try again."; })
      .finally(() => { notifyBusy = false; btn.disabled = false; });
  }
  const notifyForm = () => ({ email: $('notify-email').value.trim(), emailOn: $('notify-email-on').checked, nextUp: $('notify-next').checked });

  $('notify-btn').addEventListener('click', openNotify);
  $('notify-cancel').addEventListener('click', () => $('notify-dialog').close());
  $('notify-name').addEventListener('change', syncNotifyPinField);
  $('notify-change').addEventListener('click', () => { notifyPrefs = null; showNotifyStep(false); });
  $('notify-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!$('notify-who').hidden) $('notify-load').click();
  });
  $('notify-load').addEventListener('click', (e) => {
    e.preventDefault();
    const name = $('notify-name').value;
    if (!name) { $('notify-error').textContent = 'Choose your name.'; return; }
    withNotifyBusy($('notify-load'), async () => {
      notifyName = name;
      notifyPin = $('notify-pin').value.trim();
      const res = await notifyPost({ action: 'notifyGet', token: store.get(PUSH_TOKEN_KEY) || '' });
      if (!res || !res.ok) { $('notify-error').textContent = (res && res.error) || 'Something went wrong.'; return; }
      notifyPrefs = res.prefs || {};
      if (!me) { me = name; store.set(meKey(view), me); if (state) render(null); }
      showNotifyStep(true);
    });
  });
  $('notify-save').addEventListener('click', () => withNotifyBusy($('notify-save'), async () => {
    const f = notifyForm();
    if (f.emailOn && !f.email) { $('notify-error').textContent = 'Enter your email address, or untick the email box.'; return; }
    if (notifyDone(await notifyPost({ action: 'notifySave', prefs: f }))) { toast('Saved. ' + summaryOf(notifyPrefs)); $('notify-dialog').close(); }
  }));
  $('notify-test').addEventListener('click', () => withNotifyBusy($('notify-test'), async () => {
    // Save first so the test uses what's on screen.
    if (!notifyDone(await notifyPost({ action: 'notifySave', prefs: notifyForm() }))) return;
    // Phones only show a banner when the draft isn't on screen, so give them time to leave the app.
    toast('Test coming in 10 seconds. Close the app or lock your phone now to see the banner.');
    const res = await notifyPost({ action: 'notifyTest', delay: 10 });
    if (res && res.ok) toast(res.message || 'Test sent.');
    else $('notify-error').textContent = (res && res.error) || 'Something went wrong.';
  }));
  $('push-btn').addEventListener('click', () => {
    const btn = $('push-btn');
    const turnOn = btn.dataset.mode !== 'off';
    // Start the permission prompt right away (iPhone only allows it straight from a tap).
    const tokenPromise = turnOn ? window.DraftPush.enable() : null;
    withNotifyBusy(btn, async () => {
      if (turnOn) {
        let token;
        try { token = await tokenPromise; } catch (e) {
          $('notify-error').textContent = e && e.message === 'denied' ? 'Notifications are blocked for this site. Allow them in your settings, then try again.'
            : e && e.message === 'dismissed' ? 'Tap Allow when your browser asks, to get notifications.' : "Couldn't turn on notifications on this device.";
          console.warn(e);
          return renderPushStatus();
        }
        const old = store.get(PUSH_TOKEN_KEY);
        const res = await notifyPost({ action: 'notifySave', prefs: Object.assign(notifyForm(), { pushOn: true }), addToken: token, removeToken: old && old !== token ? old : undefined });
        if (notifyDone(res)) { store.set(PUSH_TOKEN_KEY, token); notifyPrefs.hasThisDevice = true; toast('Push notifications are on for this device.'); }
      } else {
        const token = store.get(PUSH_TOKEN_KEY);
        const res = await notifyPost({ action: 'notifySave', prefs: notifyForm(), removeToken: token });
        if (notifyDone(res)) {
          store.set(PUSH_TOKEN_KEY, '');
          notifyPrefs.hasThisDevice = false;
          if (window.DraftPush) await window.DraftPush.disable();
          toast('Push notifications are off for this device.');
        }
      }
      renderPushStatus();
    });
  });
  function summaryOf(p) {
    const ways = [];
    if (p.emailOn && p.email) ways.push('email');
    if (p.devices) ways.push('push on ' + p.devices + ' device' + (p.devices === 1 ? '' : 's'));
    return ways.length ? "You'll get " + ways.join(' and ') + " when it's your turn" + (p.nextUp ? ' and when you\'re up next.' : '.') : "You won't get any alerts outside this page.";
  }
  window.addEventListener('hashchange', () => { if (/^#notifications/.test(location.hash)) { clearNotifyHash(); openNotify(); } });
  function clearNotifyHash() {
    try { history.replaceState(null, '', location.pathname + location.search + '#' + VIEWS[view]); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* Turn alerts (visual only — no sounds)                                */
  /* ------------------------------------------------------------------ */
  let titleTimer = null;
  let baseTitle = 'Ticket Draft';

  function renderMe(s, done) {
    const sel = $('me-select');
    const names = s.members.map((m) => m.name);
    const sig = view + '|' + names.join('|');
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = '<option value="">Nobody (off)</option>' + names.map((n) => '<option>' + esc(n) + '</option>').join('');
      sel.dataset.sig = sig;
    }
    if (me && !names.includes(me)) me = '';
    sel.value = me;

    const meMember = s.members.find((m) => m.name === me);
    const mine = !!me && !done && s.current && s.current.name === me && !(meMember && meMember.out);
    const nextUp = !mine && !!me && !done && (s.upcoming || []).find((u) => !u.out);
    const isNext = !!nextUp && nextUp.name === me;

    $('clock').classList.toggle('mine', mine);
    const bar = $('turn-alert');
    bar.classList.toggle('next', isNext);
    const what = isRS(s) ? 'an open game' : 'an open seat pair';
    if (mine) {
      let msg = s.open
        ? "You're on the clock, " + me + '! Tap ' + what + ' below to make your pick.'
        : "You're on the clock, " + me + ', but the draft is paused right now.';
      if (s.open && s.deadline) {
        const ms = new Date(s.deadline).getTime() - Date.now();
        if (ms > 0) msg += ' ' + fmtLeft(ms) + ' left.';
      }
      $('turn-alert-text').textContent = msg;
      bar.hidden = false;
    } else if (isNext) {
      $('turn-alert-text').textContent = 'Heads up, ' + me + " — you're up next.";
      bar.hidden = false;
    } else {
      bar.hidden = true;
    }
    setTitleFlash(mine);
    syncBadge();
  }

  /* Home Screen icon badge: "1" while it's this device's member's turn in either draft. */
  let badgeShown = null;
  // A push can set the badge while the page sits in the background, so re-check whenever it comes back.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { badgeShown = null; syncBadge(); } });
  function syncBadge() {
    if (DEMO || !('setAppBadge' in navigator)) return;
    const on = ['post', 'rs'].some((k) => {
      const s = states[k];
      const who = k === view ? me : store.get(meKey(k));
      if (!s || !s.open || !s.current || !who || s.current.name !== who) return false;
      const m = (s.members || []).find((x) => x.name === who);
      return !(m && m.out);
    });
    if (on === badgeShown) return;
    badgeShown = on;
    (on ? navigator.setAppBadge(1) : navigator.clearAppBadge()).catch(() => {});
    if (!on && 'serviceWorker' in navigator && navigator.serviceWorker.getRegistration) {
      // Also tidy away an old "you're on the clock" notification once the turn has passed.
      navigator.serviceWorker.getRegistration().then((reg) => reg && reg.getNotifications({ tag: 'draft-turn' }))
        .then((list) => (list || []).forEach((n) => { if (/on the clock|Test/i.test(n.title || '')) n.close(); })).catch(() => {});
    }
  }

  function setTitleFlash(on) {
    if (on && !titleTimer) {
      let flip = false;
      document.title = '● Your pick! — ' + baseTitle;
      titleTimer = setInterval(() => {
        flip = !flip;
        document.title = flip ? baseTitle : '● Your pick! — ' + baseTitle;
      }, 1200);
    } else if (!on) {
      if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
      document.title = baseTitle;
    }
  }

  $('me-select').addEventListener('change', (e) => {
    me = e.target.value;
    store.set(meKey(view), me);
    if (state) render(null);
  });

  function fmtLeft(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(m / 60);
    return h ? h + 'h ' + String(m % 60).padStart(2, '0') + 'm' : (m % 60) + 'm';
  }
  const CLOCK_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  /* Pick-log timestamps, always shown in Eastern Time */
  const etFmt = (() => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return null; }
  })();
  function etTime(iso) {
    if (!iso || !etFmt) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return etFmt.format(d).replace(',', '') + ' ET';
  }

  /* Light/dark toggle — light by default, choice remembered per device */
  function syncThemeBtn() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    $('theme-btn').textContent = dark ? '☀ Light' : '☾ Dark';
    $('theme-btn').setAttribute('aria-pressed', String(dark));
    $('theme-btn').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
  $('theme-btn').addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    store.set('guardians-draft-theme', dark ? 'dark' : 'light');
    syncThemeBtn();
  });
  syncThemeBtn();

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  /* Hooks for live.js (Firebase live updates) */
  window.DraftApp = {
    currentView: () => view,
    onLive(draft, s) {
      liveOn[draft] = true;
      if (draft !== view) { if (s && !s.notSetUp) states[draft] = s; return; }
      if (s && s.notSetUp) { states[draft] = s; state = s; markSynced(); if (!setupOpen) renderNotSetUp(); return; }
      staleViews.delete(draft);
      if (setupOpen) { states[draft] = s; state = s; lastPickCount = s.picks.length; markSynced(); return; }
      apply(s);
      markSynced();
      $('sync').textContent = 'Live';
      $('sync').classList.add('live');
    },
    liveOff(draft) { liveOn[draft] = false; },
    toast: (msg) => toast(msg),
  };

  /* ------------------------------------------------------------------ */
  /* Start                                                                */
  /* ------------------------------------------------------------------ */
  // Keep the slow-pick clock and pick countdown current even when nothing else changes.
  setInterval(() => { if (state && !busy && view !== 'archive' && !document.querySelector('dialog[open]')) render(null); }, 60000);

  if (history.replaceState && !sentPrices && !sentEmails) history.replaceState(null, '', '#' + VIEWS[view]);
  syncSwitch();
  if (view === 'archive') { $('title').textContent = 'Past drafts'; document.title = 'Past drafts'; renderArchives(); }
  else showDraft();
  refresh();
  // Keep checking in background tabs too (more slowly) so turn alerts still fire.
  let lastBg = 0;
  setInterval(() => {
    if (busy || view === 'archive') return;
    if (liveOn[view] && Date.now() - lastPoll < 60000) return; // live updates are on; just a slow safety check
    if (!document.hidden) { refresh(); return; }
    if (me && Date.now() - lastBg >= 30000) { lastBg = Date.now(); refresh(); }
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && view !== 'archive') refresh(); });
})();
