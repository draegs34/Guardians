(function () {
  'use strict';

  const API = (window.DRAFT_API_URL || '').trim();
  const DEMO = !API;
  // Test mode: open the site with ?test to use separate test data (see README → Test mode).
  const TEST = !DEMO && /[?&]test(=|&|$)/.test(location.search);
  window.DRAFT_TEST = TEST;
  const REFRESH_MS = Math.max(5, Number(window.DRAFT_REFRESH_SECONDS) || 10) * 1000;
  const UP_NEXT_COUNT = 10; // rows in Up next, including whoever is on the clock (dropouts aren't listed)

  const $ = (id) => document.getElementById(id);
  // Member dropdowns list people by last name ("Molly & Tom Jones" sorts under Jones; Jr./Sr./II/III are ignored).
  const lastFirst = (n) => {
    const w = String(n || '').trim().split(/\s+/).filter((x) => !/^(jr|sr|ii|iii|iv)\.?,?$/i.test(x));
    return ((w.length > 1 ? w[w.length - 1] : w[0] || '') + ' ' + w.slice(0, -1).join(' ')).toLowerCase();
  };
  const byLast = (a, b) => lastFirst(a).localeCompare(lastFirst(b)) || String(a).localeCompare(String(b));
  const sortedNames = (members) => members.map((m) => m.name).filter(Boolean).sort(byLast);
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Who-you-are and alert keys are kept separately in test mode, so testing as another member
  // doesn't change who the real site thinks you are.
  const ID_KEY = /^guardians-(draft-me|draft-push-token|notify-on|screen-chosen|swap-me|viewer)/;
  const nsKey = (k) => (TEST && ID_KEY.test(k) ? 'test:' + k : k);
  const store = {
    get(k) { try { return localStorage.getItem(nsKey(k)); } catch (e) { return null; } },
    set(k, v) { try { if (v == null || v === '') localStorage.removeItem(nsKey(k)); else localStorage.setItem(nsKey(k), v); } catch (e) { /* ignore */ } },
  };
  // A link ending in &fresh (or ?fresh) opens the site as a first-time visitor: it forgets who you are
  // and your alert settings in this browser, then removes "fresh" from the address.
  if (/[?&]fresh(=|&|$)/.test(location.search)) {
    try {
      Object.keys(localStorage).forEach((k) => { const base = k.replace(/^test:/, ''); if (ID_KEY.test(base) && (k.startsWith('test:') === TEST)) localStorage.removeItem(k); });
      const q = location.search.replace(/([?&])fresh(=[^&]*)?(&|$)/, (m, a, b, c) => (c ? a : '')).replace(/[?&]$/, '');
      history.replaceState(null, '', location.pathname + q + location.hash);
    } catch (e) { /* ignore */ }
  }

  // Calendar names (used by the demo data below, so defined first)
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /* ------------------------------------------------------------------ */
  /* What's showing: 'rs' (regular season), 'post', or 'setup' (commissioner) */
  /* ------------------------------------------------------------------ */
  const VIEWS = { rs: 'regular-season', post: 'postseason', swap: 'ticket-swap', setup: 'setup' };
  const VIEW_KEY = 'guardians-draft-view';
  const isDraftView = (v) => v === 'rs' || v === 'post';
  let setupKey = 'rs'; // which Setup section: 'rs', 'post', 'archive-rs' or 'archive-post'
  // Whether members see the Postseason tab (Setup → Postseason → Display Postseason tab). Last known value, until the draft loads.
  const SHOW_POST_KEY = 'guardians-show-post';
  let showPost = store.get(SHOW_POST_KEY) !== '0';
  function initialView() {
    const h = location.hash.replace('#', '');
    if (h === 'past-drafts') { setupKey = 'archive-rs'; return 'setup'; }
    for (const k in VIEWS) if (VIEWS[k] === h || k === h) return k;
    const saved = store.get(VIEW_KEY);
    if (saved === 'post' && !showPost) return 'rs';
    return isDraftView(saved) ? saved : (showPost ? 'post' : 'rs');
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
  /* Members sent from the Season Ticket Manager arrive as #members=<base64url JSON [[name, email, games], …]>
     (older links used #emails= with [[name, email], …]). */
  function readEmailHash() {
    const m = location.hash.match(/(?:members|emails)=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4))));
      const list = JSON.parse(json).filter((x) => Array.isArray(x) && String(x[0] || '').trim())
        .map((x) => ({ from: String(x[0]).trim(), email: String(x[1] || '').trim(), games: x[2] == null || x[2] === '' ? null : Math.max(0, Math.round(Number(x[2]) || 0)) }));
      return list.length ? list : null;
    } catch (e) { return null; }
  }
  let sentEmails = readEmailHash();
  let sentPrices = readPriceHash();
  let view = sentPrices ? 'post' : sentEmails ? 'setup' : initialView();

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
  // Who's using this browser, for highlighting "you" (Up Next, Pick Log, calendar). Remembered from
  // on-screen alerts, Notification & PIN settings, or Ticket Swap, whichever they've used.
  const VIEWER_KEY = 'guardians-viewer';
  const viewer = () => store.get(VIEWER_KEY) || me || store.get('guardians-swap-me') || '';
  let whoPin = ''; // PIN from "Who are you?", kept only while the page is open
  const setViewer = (n) => { if (n) store.set(VIEWER_KEY, n); };

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
      if (body.action === 'syncMembers') {
        if (String(body.pin || '').trim() !== d.settings.commissionerPin) return { ok: false, error: "That commissioner PIN doesn't match." };
        if (body.preview) {
          const all = {};
          ['rs', 'post'].forEach((x) => drafts[x].members.forEach((m) => { const a = all[m.name] = all[m.name] || { name: m.name, inRs: false, inPost: false, games: null, email: (demoPrefs[m.name] || {}).email || '' }; if (x === 'rs') { a.inRs = true; a.games = m.cap || 0; } else a.inPost = true; }));
          return { ok: true, drafts: { rs: true, post: true }, members: Object.values(all) };
        }
        (body.games || []).forEach((g) => { const m = drafts.rs.members.find((x) => x.name === g.name); if (m) m.cap = g.games; });
        (body.add || []).forEach((a) => { ['rs', 'post'].forEach((x) => { if (body.addTo[x] && !drafts[x].members.some((m) => m.name === a.name)) drafts[x].members.push({ name: a.name, pin: '', cap: x === 'rs' ? a.games || 0 : 0, order: drafts[x].members.length + 1 }); }); if (a.email) body.emails.push({ name: a.name, email: a.email }); });
        (body.emails || []).forEach((e) => { const p = demoPrefs[e.name] = demoPrefs[e.name] || { email: '', emailOn: false, pushOn: false, nextUp: false, tokens: [] }; p.email = e.email; p.emailOn = true; });
        return Object.assign(DraftEngine.publicState(data(k)), { ok: true, message: 'Demo mode: members updated.' });
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
    return fetch(API + (API.includes('?') ? '&' : '?') + q + (TEST ? '&test=1' : '') + '&t=' + Date.now(), { method: 'GET' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function apiGet(draft) {
    if (DEMO) return demo.get(draft);
    return getJson({ draft });
  }
  function apiArchives() {
    if (DEMO) return demo.archives();
    return apiPost({ action: 'archives', pin: commishPin, draft: 'rs' });
  }
  function apiPost(body) {
    if (!body.draft) body.draft = isDraftView(view) ? view : (/post/.test(setupKey) ? 'post' : 'rs');
    if (DEMO) return demo.post(body);
    if (TEST) body.test = true;
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
  const cacheKey = (v) => 'guardians-draft-board:' + API + (TEST ? ':test' : '') + ':' + v;
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
    if (!isDraftView(view)) return Promise.resolve();
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

  // "2027 Regular Season": the year comes from Setup → Regular Season → Season. Last known value until the draft loads.
  const RS_SEASON_KEY = 'guardians-rs-season';
  function setRsSeason(season) {
    season = String(season || '').trim();
    store.set(RS_SEASON_KEY, season);
    const label = (season ? season + ' ' : '') + 'Regular Season';
    $('rs-tab').textContent = label;
    $('rs-subtab').textContent = label;
  }
  function setShowPost(on) {
    on = on !== false;
    if (on !== showPost) store.set(SHOW_POST_KEY, on ? '1' : '0');
    showPost = on;
    $('post-tab').hidden = !on;
    // Members get moved off a hidden Postseason tab; the commissioner (Setup unlocked) can still look at it.
    if (!on && view === 'post' && !commishPin && !sentPrices) switchView('rs');
  }
  function apply(s) {
    loadTimers.forEach(clearTimeout);
    if (view === 'post' && s && !s.notSetUp) setShowPost(s.showTab);
    if (view === 'rs' && s && !s.notSetUp && 'season' in s) setRsSeason(s.season);
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
    if (pendingCog && pendingCog === view && !staleViews.has(view)) { const k = pendingCog; setTimeout(() => openCog(k), 0); }
    // Opened from the "Change your notification settings" link in an email
    if (wantNotify && s.members && isDraftView(view) && !document.querySelector('dialog[open]')) { wantNotify = false; openNotify(); }
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
      ? '<div class="notice-card"><strong>The ' + label + ' draft isn\'t set up yet.</strong><br>Commissioner: open <em>Setup</em> at the top of the page to import your data or start it empty.</div>'
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
    if (TEST) baseTitle = 'TEST · ' + baseTitle;
    if (!titleTimer) document.title = baseTitle;
    $('title').textContent = s.title || 'Ticket Draft';
    $('demo-banner').hidden = !DEMO;
    $('test-banner').hidden = !TEST;
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
    else { $('rs-filters').hidden = true; document.querySelector('.board-col').classList.remove('cal-mode'); renderPostBoard(s, takenBy, canPick, prevIds); }

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
          const cls = [viewer() && t.name === viewer() ? 'me' : '', extra ? 'standby' : ''].filter(Boolean).join(' ');
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
          return '<li' + (viewer() && p.member === viewer() ? ' class="me"' : '') + '>' + body + stamp + '</li>';
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
    const lab = label ? '<span class="s-label">' + esc(label) + '</span>' : '';
    if (p) {
      return '<div class="seat taken' + (viewer() && p.member === viewer() ? ' mine' : '') + fresh + '" title="' + (p.assigned ? 'Assigned by commissioner' : 'Pick #' + p.number) + '">' + lab + '<span class="s-val">' + esc(p.member) + '</span></div>';
    }
    if (!canPick) return '<div class="seat">' + lab + '<span class="s-val">Available</span></div>';
    return '<button type="button" class="seat open" data-id="' + esc(it.id) + '" aria-label="Pick ' + esc(aria) + '">' + lab + '<span class="s-val">Pick</span></button>';
  }

  /* Regular season board: one row per home game, all four seats per pick. */
  const rsFilter = { avail: 'all', opp: '' };
  // List or calendar (remembered in this browser).
  const RS_VIEW_KEY = 'guardians-rs-view';
  let rsView = store.get(RS_VIEW_KEY) === 'list' ? 'list' : 'cal'; // calendar unless they chose the list
  // Short team codes like the printed schedule.
  const TEAM_ABBR = {
    'Arizona Diamondbacks': 'AZ', 'Athletics': 'ATH', 'Oakland Athletics': 'ATH', 'Atlanta Braves': 'ATL', 'Baltimore Orioles': 'BAL',
    'Boston Red Sox': 'BOS', 'Chicago Cubs': 'CHC', 'Chicago White Sox': 'CWS', 'Cincinnati Reds': 'CIN', 'Colorado Rockies': 'COL',
    'Detroit Tigers': 'DET', 'Houston Astros': 'HOU', 'Kansas City Royals': 'KC', 'Los Angeles Angels': 'LAA', 'Los Angeles Dodgers': 'LAD',
    'Miami Marlins': 'MIA', 'Milwaukee Brewers': 'MIL', 'Minnesota Twins': 'MIN', 'New York Mets': 'NYM', 'New York Yankees': 'NYY',
    'Philadelphia Phillies': 'PHI', 'Pittsburgh Pirates': 'PIT', 'San Diego Padres': 'SD', 'San Francisco Giants': 'SF', 'Seattle Mariners': 'SEA',
    'St. Louis Cardinals': 'STL', 'Tampa Bay Rays': 'TB', 'Texas Rangers': 'TEX', 'Toronto Blue Jays': 'TOR', 'Washington Nationals': 'WSH',
  };
  const teamAbbr = (n) => TEAM_ABBR[n] || String(n || '').split(' ').pop().slice(0, 3).toUpperCase();
  const lastName = (n) => String(n || '').trim().split(/\s+/).pop();
  // Months fold up; they all start open (tap a month's bar to close it).
  const monthOpen = {};
  // List view: months start folded up, except while a filter is narrowing the list.
  const filtering = () => rsFilter.avail !== 'all' || !!rsFilter.opp;
  const isMonthOpen = (key) => (key in monthOpen ? monthOpen[key] : filtering());
  function renderRsBoard(s, takenBy, canPick, prevIds) {
    const games = s.inventory.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const openerId = games.length ? games[0].id : null;
    const enriched = games.map((g) => ({ g, f: gameFlags(g, openerId), p: takenBy[g.id] }));

    // Filter bar (only rebuilt when its options change, so it keeps focus).
    const opps = [...new Set(games.map((g) => g.opponent).filter(Boolean))].sort();
    const fb = $('rs-filters');
    const sig = opps.join(',');
    if (fb.dataset.sig !== sig) {
      const chip = (k, v, t) => '<button type="button" class="fchip" data-fk="' + k + '" data-fv="' + v + '">' + t + '</button>';
      fb.innerHTML =
        '<div class="vtoggle" role="group" aria-label="View">' +
          '<button type="button" data-rsview="cal"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>Calendar</button>' +
          '<button type="button" data-rsview="list"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>List</button></div>' +
        '<div class="frow" role="group" aria-label="Show">' + chip('avail', 'all', 'All games') + chip('avail', 'open', 'Available') + chip('avail', 'mine', 'My games') + '</div>' +
        '<div class="frow selects"><label>Opponent <select data-fsel="opp"><option value="">All</option>' +
          opps.map((o) => '<option>' + esc(o) + '</option>').join('') + '</select></label>' +
        '<span class="fcount" id="fcount"></span><button type="button" class="link-btn month-all" id="month-all"></button></div>';
      fb.dataset.sig = sig;
    }
    fb.hidden = false;
    fb.querySelectorAll('.fchip').forEach((b) => b.setAttribute('aria-pressed', String(rsFilter[b.dataset.fk] === b.dataset.fv)));
    fb.querySelectorAll('[data-rsview]').forEach((b) => b.setAttribute('aria-pressed', String(rsView === b.dataset.rsview)));
    fb.querySelectorAll('select[data-fsel]').forEach((sel) => { if (sel !== document.activeElement) sel.value = rsFilter[sel.dataset.fsel]; });

    const shown = enriched.filter(({ g, f, p }) => {
      if (rsFilter.avail === 'open' && p) return false;
      if (rsFilter.avail === 'mine' && !(p && viewer() && p.member === viewer())) return false;
      if (rsFilter.opp && g.opponent !== rsFilter.opp) return false;
      return true;
    });
    const fc = $('fcount');
    if (fc) fc.textContent = shown.length + ' of ' + games.length + ' games';
    const shownMonths = [...new Set(shown.map((x) => String(x.g.date).slice(0, 7)))];
    const allOpen = shownMonths.length > 0 && shownMonths.every(isMonthOpen);
    const ma = $('month-all');
    if (ma) { ma.textContent = allOpen ? 'Collapse all' : 'Expand all'; ma.dataset.open = allOpen ? '1' : ''; ma.hidden = shownMonths.length < 2 || rsView === 'cal'; }

    document.querySelector('.board-col').classList.toggle('cal-mode', rsView === 'cal');
    if (rsView === 'cal' && games.length) { renderRsCalendar(enriched, new Set(shown.map((x) => x.g.id)), canPick, prevIds); return; }

    if (!shown.length) {
      $('board').innerHTML = '<div class="notice-card">' + (games.length && rsFilter.avail === 'mine' && !viewer() ? 'Tap <strong>Who are you?</strong> above so the page knows which games are yours.' : games.length && rsFilter.avail === 'mine' ? 'You don\'t have any games yet' + (rsFilter.opp ? ' that match these filters.' : '.') : games.length ? 'No games match these filters.' : 'No games loaded yet. Commissioner: choose <em>Guardians Draft → Refresh regular season schedule from MLB</em> in the Google Sheet.') + '</div>';
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
      const isOpen = isMonthOpen(grp.key);
      const mineOnly = rsFilter.avail === 'mine';
      return '<div class="series rs-month' + (isOpen ? '' : ' closed') + (open || mineOnly ? '' : ' full') + '"><button type="button" class="series-head month-toggle" data-month="' + esc(grp.key) + '" aria-expanded="' + isOpen + '">' +
        '<h3><span class="chev" aria-hidden="true">▾</span>' + esc(name) + '</h3><span class="price">' + (mineOnly ? grp.items.length + (grp.items.length === 1 ? ' game' : ' games') : open + ' of ' + grp.items.length + ' open') + '</span></button>' +
        '<div class="month-body"' + (isOpen ? '' : ' hidden') + '>' +
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
          return '<div class="rsg' + (pick ? ' is-taken' : '') + (pick && viewer() && pick.member === viewer() ? ' is-mine' : '') + hl + '">' +
            '<div class="rsg-date' + (f.weekend ? ' wknd' : '') + '"><span class="mon">' + (d ? MON[d[1] - 1] : '') + '</span><span class="dnum">' + (d ? d[2] : '?') + '</span><span class="dow">' + esc(f.dow) + '</span></div>' +
            '<div class="rsg-info"><div class="game-name">vs ' + esc(g.opponent) + '</div><div class="game-sub">' + time + '</div>' +
              (tags.length ? '<div class="badges">' + tags.join('') + '</div>' : '') + '</div>' +
            '<div class="rsg-act">' + seatCell(g, pick, canPick, prevIds, '', g.label || g.game) + '</div></div>';
        }).join('') + '</div></div>';
    }).join('');
  }

  /* Calendar view: month grids like the printed schedule. Available home games are navy (taken ones gray,
     yours red); games that don't match the filters fade out. The Month filter shows just that month. */
  function renderRsCalendar(enriched, match, canPick, prevIds) {
    const byDate = {};
    enriched.forEach((x) => { byDate[x.g.date] = x; });
    const months = [...new Set(enriched.map((x) => String(x.g.date).slice(0, 7)))].filter((m) => /^\d{4}-\d{2}$/.test(m));
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const pad = (n) => String(n).padStart(2, '0');
    $('board').innerHTML = '<div class="cal-legend"><span><i class="cl open"></i>Available</span><span><i class="cl taken"></i>Taken</span>' + (viewer() ? '<span><i class="cl mine"></i>Yours</span>' : '') + '</div>' +
      '<div class="cal-months">' + months.map((key) => {
        const [y, m] = key.split('-').map(Number);
        const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
        const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const inMonth = enriched.filter((x) => String(x.g.date).slice(0, 7) === key);
        const open = inMonth.filter((x) => !x.p).length;
        let cells = '';
        for (let i = 0; i < first; i++) cells += '<div class="cal-d blank"></div>';
        for (let d = 1; d <= days; d++) {
          const x = byDate[key + '-' + pad(d)];
          if (!x) { cells += '<div class="cal-d"><span class="cn">' + d + '</span></div>'; continue; }
          const { g, f, p: pick } = x;
          const time = g.time && !/^tbd$/i.test(g.time) ? g.time : 'TBD';
          const mineCls = pick && viewer() && pick.member === viewer() ? ' mine' : '';
          const fresh = prevIds && pick && !prevIds.has(g.id) ? ' just' : '';
          const dim = match.has(g.id) ? '' : ' dim';
          const tip = f.dow + ' ' + MON[m - 1] + ' ' + d + ' vs ' + g.opponent + ' · ' + time + (pick ? ' — ' + pick.member : ' — available') + (f.opener ? ' · Home Opener' : '') + (f.holiday ? ' · ' + f.holiday : '');
          const mark = f.opener || f.holiday ? '<span class="cstar" aria-hidden="true">★</span>' : '';
          const inner = '<span class="cn">' + d + '</span>' + mark + '<span class="ct">' + esc(teamAbbr(g.opponent)) + '</span>' +
            '<span class="cw">' + esc(pick ? (mineCls ? 'You' : lastName(pick.member)) : time.replace(/\s?PM$/i, 'p').replace(/\s?AM$/i, 'a')) + '</span>';
          if (!pick && canPick && !dim) cells += '<button type="button" class="cal-d g open" data-id="' + esc(g.id) + '" title="' + esc(tip) + '" aria-label="Pick ' + esc(tip) + '">' + inner + '</button>';
          else cells += '<div class="cal-d g' + (pick ? ' taken' + mineCls : ' avail') + fresh + dim + '" title="' + esc(tip) + '">' + inner + '</div>';
        }
        return '<div class="series cal-month' + (open ? '' : ' full') + '"><div class="series-head"><h3>' + esc(MONTH_FULL[m - 1] + ' ' + y) + '</h3><span class="price">' + open + ' of ' + inMonth.length + ' open</span></div>' +
          '<div class="cal-grid">' + DOW.map((w) => '<div class="cal-w">' + w + '</div>').join('') + cells + '</div></div>';
      }).join('') + '</div>';
  }

  $('board').addEventListener('click', (e) => {
    const t = e.target.closest('.month-toggle');
    if (!t) return;
    monthOpen[t.dataset.month] = !isMonthOpen(t.dataset.month);
    if (state) render(null);
  });
  $('rs-filters').addEventListener('click', (e) => {
    const all = e.target.closest('#month-all');
    if (all) {
      const openAll = !all.dataset.open;
      ((state && state.inventory) || []).forEach((g) => { monthOpen[String(g.date).slice(0, 7)] = openAll; });
      if (state) render(null);
      return;
    }
    const v = e.target.closest('[data-rsview]');
    if (v) {
      rsView = v.dataset.rsview;
      store.set(RS_VIEW_KEY, rsView);
      if (state) render(null);
      return;
    }
    const b = e.target.closest('.fchip');
    if (!b) return;
    rsFilter[b.dataset.fk] = b.dataset.fv;
    if (state) render(null);
    if (b.dataset.fv === 'mine' && !viewer()) openWho(); // need to know who "my" is
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
  const onArchives = () => view === 'setup' && /^archive/.test(setupKey) && !!$('archive-list');
  function loadArchives() {
    return apiArchives().then((r) => {
      if (r && r.ok === false) throw new Error(r.error || 'Not allowed');
      archives = (r && r.archives) || [];
      if (onArchives()) renderArchives();
    }).catch((err) => {
      console.warn(err);
      if (onArchives() && !archives) $('archive-list').innerHTML = '<p class="empty">Couldn\'t load past drafts. ' + esc(err && err.message ? err.message : '') + '</p>';
    });
  }
  function renderArchives() {
    if (!$('archive-list')) return;
    if (!archives) { $('archive-list').innerHTML = '<p class="empty">Loading…</p>'; return; }
    const kind = setupKey === 'archive-post' ? 'post' : 'rs';
    const list = archives.filter((a) => (a.kind === 'rs' ? 'rs' : 'post') === kind);
    if (!list.length) {
      $('archive-list').innerHTML = '<div class="notice-card">No archived ' + (kind === 'rs' ? 'regular season' : 'postseason') + ' drafts yet. Archive a finished draft with the ⚙ commissioner tools → <em>Archive this draft</em>.</div>';
      return;
    }
    $('archive-list').innerHTML = list.map((a, i) => {
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
    document.querySelectorAll('#draft-switch button[data-view]').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
    const setup = view === 'setup';
    const swap = view === 'swap';
    $('setup-view').hidden = !setup;
    $('swap-view').hidden = !swap;
    ['clock', 'me-bar', 'mtabs', 'layout'].forEach((id) => { const el = $(id) || document.querySelector('.' + id); if (el) el.hidden = setup || swap; });
    if (setup || swap) { $('turn-alert').hidden = true; $('price-banner').hidden = true; }
  }
  function switchView(v) {
    if (!VIEWS[v] || v === view) return;
    view = v;
    if (isDraftView(v)) store.set(VIEW_KEY, v);
    if (history.replaceState) history.replaceState(null, '', '#' + VIEWS[v]);
    lastPickCount = null;
    setTitleFlash(false);
    $('turn-alert').hidden = true;
    syncSwitch();
    if (v === 'setup') {
      if (window.DraftLive) window.DraftLive.watch(null);
      document.title = 'Setup';
      $('title').textContent = 'Commissioner setup';
      openSetupView();
      renderEmailBanner();
      return;
    }
    if (v === 'swap') {
      if (window.DraftLive) window.DraftLive.watch(null);
      document.title = 'Ticket Swap';
      $('title').textContent = 'Ticket Swap';
      openSwap();
      return;
    }
    me = store.get(meKey(v)) || '';
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
    if (h === 'past-drafts') { setupKey = 'archive-rs'; if (view === 'setup') renderSetup(); else switchView('setup'); return; }
    for (const k in VIEWS) if (VIEWS[k] === h) switchView(k);
  });
  // (A #prices=… link from the Season Ticket Manager is handled with the price tool below.)

  /* ------------------------------------------------------------------ */
  /* Pick flow                                                            */
  /* ------------------------------------------------------------------ */
  $('board').addEventListener('click', (e) => {
    const btn = e.target.closest('.seat.open, .cal-d.open');
    if (!btn || !state) return;
    const item = state.inventory.find((i) => i.id === btn.dataset.id);
    if (!item) return;
    pendingItem = item;
    if (isRS(state)) {
      const d = ymd(item.date);
      const f = gameFlags(item, null);
      const extras = [f.holiday, f.dayGame ? 'Weekday day game' : ''].concat(f.promos).filter(Boolean);
      $('pick-item').innerHTML = '<div class="pi-title">' + esc(f.dow) + ', ' + (d ? MON[d[1] - 1] + ' ' + d[2] : '') + ' — vs ' + esc(item.opponent) + '</div>' +
        '<div class="pi-sub">4 tickets · ' + (item.time && !/^tbd$/i.test(item.time) ? esc(item.time) + ' ET' : 'Time TBD') + (extras.length ? ' · ' + esc(extras.join(' · ')) : '') + '</div>';
    } else {
      $('pick-item').innerHTML = '<div class="pi-title">' + esc(item.series) + ' — ' + esc(item.game) + '</div>' +
        '<div class="pi-sub">Seats ' + esc(item.seats) + ' · ' + (item.date && item.date !== 'TBD' ? esc(item.date) + ' · ' : '') + money(item.price) + '</div>';
    }
    pendingName = state.current ? state.current.name : null;
    $('pick-for').textContent = pendingName || '';
    $('pick-submit').textContent = 'Lock it in';
    $('pick-error').textContent = '';
    const mem = state.members.find((m) => m.name === pendingName);
    const needsPin = !mem || mem.needsPin !== false;
    $('pick-pin-wrap').hidden = !needsPin;
    $('pick-pin').required = needsPin;
    $('pick-pin').value = whoPin && pendingName === viewer() ? whoPin : '';
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
        $('pick-submit').textContent = 'Lock it in';
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
      sortedNames(state.members).map((n) => '<option>' + esc(n) + '</option>').join('');
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
  $('price-review').addEventListener('click', () => openCog('post'));
  $('prices-btn').addEventListener('click', () => {
    if (!sentPrices) return;
    const prices = sentPrices;
    const pricesLanded = (s) => Object.keys(prices).every((k) =>
      s.inventory.filter((i) => i.id.split('-')[0].toUpperCase() === k).every((i) => i.price === prices[k]));
    commishAction({ action: 'setPrices', prices }, $('prices-btn'), pricesLanded, (res) => { if (res && res.ok) clearPriceHash(); });
  });

  /* The ⚙ button: commissioner tools for the draft on screen (from Setup, the section you're in). */
  let pendingCog = null; // opening the tools from Setup waits for that draft's board to load
  function openCog(want) {
    const key = want || (isDraftView(view) ? view : (/post/.test(setupKey) ? 'post' : 'rs'));
    if (view !== key) switchView(key);
    if (state && state.notSetUp) { pendingCog = null; toast('This draft isn\'t set up yet. Use Setup to import it or start it empty.'); return; }
    if (!state || staleViews.has(view)) { pendingCog = key; return; }
    pendingCog = null;
    $('commish-draft').textContent = '· ' + (key === 'rs' ? 'Regular Season' : 'Postseason');
    $('commish-pin').value = commishPin || '';
    $('commish-error').textContent = '';
    disarmArchive();
    fillAssignLists();
    renderPriceTool();
    $('commish-dialog').showModal();
    setTimeout(() => (commishPin ? $('commish-cancel') : $('commish-pin')).focus(), 50);
  }
  $('cog-btn').addEventListener('click', () => openCog());
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
        if (res && res.ok) { rememberPin(body.pin); $('commish-dialog').close(); toast(res.message || 'Saved.'); archives = null; }
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
  // Same button at the bottom of the Games list on phones.
  $('drop-btn-m').addEventListener('click', () => $('drop-btn').click());
  $('drop-btn').addEventListener('click', () => {
    if (!state || !state.members) return;
    const active = state.members.filter((m) => !m.out);
    $('drop-name').innerHTML = '<option value="">Choose your name…</option>' +
      sortedNames(active).map((n) => '<option>' + esc(n) + '</option>').join('');
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
  /* Setup tab (commissioner): one PIN, a section per draft, past drafts. */
  /* The regular season member list is the source of truth; the          */
  /* postseason list follows it (order and active/inactive set there).   */
  /* ------------------------------------------------------------------ */
  const PIN_KEY = 'guardians-commish-pin';
  const session = {
    get() { try { return sessionStorage.getItem(PIN_KEY) || ''; } catch (e) { return ''; } },
    set(v) { try { if (v) sessionStorage.setItem(PIN_KEY, v); else sessionStorage.removeItem(PIN_KEY); } catch (e) { /* ignore */ } },
  };
  // Remembered until this browser tab or app is closed, so moving between pages doesn't ask again.
  let commishPin = session.get();
  function rememberPin(pin) { pin = String(pin || '').trim(); if (pin) { commishPin = pin; session.set(pin); } }
  let admin = null;        // { rs, post }: what Setup is editing (null for a draft that isn't set up)
  let setupBoards = {};    // public state of each draft, for "who has picks"
  let setupBusy = false;
  let setupLoading = false;
  const A = () => (admin && (setupKey === 'rs' || setupKey === 'post') ? admin[setupKey] : null);

  function openSetupView() {
    syncSwitch();
    if (DEMO) {
      $('setup-lock').hidden = true;
      $('setup-main').hidden = false;
      $('setup-body').innerHTML = '<div class="notice-card">Setup works once the site is connected to Firebase (see the README).</div>';
      return;
    }
    if (!commishPin) { showLock(''); return; }
    $('setup-lock').hidden = true;
    $('setup-main').hidden = false;
    if (!admin) loadAdmin(commishPin); else renderSetup();
  }
  function showLock(err) {
    $('setup-main').hidden = true;
    $('setup-lock').hidden = false;
    $('lock-error').textContent = err || '';
    $('lock-pin').value = '';
    setTimeout(() => $('lock-pin').focus(), 50);
  }
  $('lock-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = $('lock-pin').value.trim();
    if (!pin) { $('lock-error').textContent = 'Enter the commissioner PIN.'; return; }
    loadAdmin(pin);
  });
  $('setup-lockbtn').addEventListener('click', () => {
    commishPin = ''; session.set(''); admin = null; archives = null; sync = null;
    showLock('');
    toast('Setup is locked on this device.');
  });
  $('setup-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sk]');
    if (!b || b.dataset.sk === setupKey) return;
    setupKey = b.dataset.sk;
    renderSetup();
    window.scrollTo(0, 0);
  });

  function loadAdmin(pin) {
    if (setupLoading) return Promise.resolve();
    setupLoading = true;
    $('lock-go').disabled = true;
    if (!$('setup-main').hidden) $('setup-body').innerHTML = '<p class="empty">Loading setup…</p>';
    return Promise.all(['rs', 'post'].map((k) => apiPost({ action: 'adminGet', pin, draft: k }).catch(() => null))).then(([r, p]) => {
      const res = { rs: r, post: p };
      const okAny = (r && r.ok) || (p && p.ok);
      const bothEmpty = r && r.notSetUp && p && p.notSetUp;
      if (!okAny && !bothEmpty) {
        commishPin = ''; session.set(''); admin = null;
        showLock((r && r.error) || (p && p.error) || "Couldn't reach the draft. Try again in a moment.");
        return;
      }
      rememberPin(pin);
      admin = {};
      setupBoards = {};
      ['rs', 'post'].forEach((k) => {
        const x = res[k];
        if (x && x.ok && x.admin) {
          x.admin.members.forEach((m) => { m.orig = m.name; });
          if (k === 'rs') x.admin.members.sort((p, q) => byLast(p.name, q.name)); // the list reads alphabetically by last name
          admin[k] = x.admin;
          setupBoards[k] = x;
        } else admin[k] = null;
      });
      $('setup-lock').hidden = true;
      $('setup-main').hidden = false;
      renderSetup();
    }).finally(() => { setupLoading = false; $('lock-go').disabled = false; });
  }

  const field = (label, html, hint) => '<label class="sf"><span>' + label + '</span>' + html + (hint ? '<small>' + hint + '</small>' : '') + '</label>';
  const inp = (bind, val, attrs) => '<input data-bind="' + bind + '" value="' + esc(val == null ? '' : val) + '" ' + (attrs || '') + '>';
  const ro = (val, cls) => '<input value="' + esc(val == null ? '' : val) + '" disabled class="ro ' + (cls || '') + '">';
  const chk = (bind, on, text) => '<label class="check"><input type="checkbox" data-bind="' + bind + '"' + (on ? ' checked' : '') + '> ' + text + '</label>';
  const iconBtn = (act, i, label, sym, dis) => '<button type="button" class="icon-btn" data-act="' + act + '" data-i="' + i + '" aria-label="' + esc(label) + '" title="' + esc(dis || label) + '"' + (dis ? ' disabled' : '') + '>' + sym + '</button>';
  const hasPicks = (k, name) => !!name && ((setupBoards[k] && setupBoards[k].picks) || []).some((p) => p.member === name);

  function renderSetup() {
    document.querySelectorAll('#setup-tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.sk === setupKey ? 'page' : 'false'));
    if (/^archive/.test(setupKey)) {
      $('setup-body').innerHTML = '<p class="hint setup-intro">Finished ' + (setupKey === 'archive-rs' ? 'regular season' : 'postseason') + ' drafts you\'ve archived. Only the commissioner can see these.</p><div id="archive-list"></div>';
      renderArchives();
      if (!archives) loadArchives();
      return;
    }
    const key = setupKey;
    const rs = key === 'rs';
    const a = A();
    const importCard =
      '<section class="card sc"><h3>Import data</h3>' +
      '<p class="hint">Moving from the Google Sheet: in the sheet choose <em>Guardians Draft → Export everything for Firebase</em>, copy the text and paste it here. ' +
      'It replaces the drafts and past drafts it contains. Use the <strong>setup key</strong> you chose when deploying (or your commissioner PIN).</p>' +
      '<textarea id="import-text" rows="5" placeholder="Paste the export here"></textarea>' +
      field('Setup key or commissioner PIN', '<input id="import-key" type="password" autocomplete="off">') +
      '<div class="row-btns"><button type="button" class="btn primary" data-act="import">Import</button></div></section>';
    if (!a) {
      $('setup-body').innerHTML =
        '<div class="notice-card">The ' + (rs ? 'regular season' : 'postseason') + ' draft isn\'t set up yet. Import your data from the Google Sheet, or start it empty and fill it in here.</div>' +
        importCard +
        '<section class="card sc"><h3>Start this draft empty</h3><p class="hint">Creates the ' + (rs ? 'regular season' : 'postseason') + ' draft' + (rs ? ' with one placeholder member' : ' with the regular season members') + '. You can then fill in the rest here.</p>' +
        field('Commissioner PIN', '<input id="fresh-pin" inputmode="numeric" autocomplete="off" value="' + esc(commishPin) + '">') +
        field('Setup key', '<input id="fresh-key" type="password" autocomplete="off">', 'The private phrase you chose when deploying.') +
        '<div class="row-btns"><button type="button" class="btn" data-act="fresh">Create empty draft</button></div></section>';
      return;
    }
    const s = a.settings || {};
    const picked = new Set(((setupBoards[key] && setupBoards[key].picks) || []).filter((p) => p.itemId).map((p) => p.itemId));
    const names = sortedNames(a.members);
    const tl = !!s.timeLimitOn;
    const rem = !!s.reminderOn;

    let html = '';
    if (!rs) html += '<section class="card sc show-post"><label class="check big-check"><input type="checkbox" data-bind="settings.showTab"' + (s.showTab !== false ? ' checked' : '') + '> <span><strong>Display Postseason tab</strong><small>When unchecked, members don\'t see the Postseason tab at the top of the page. Turn it on when it\'s time for a postseason draft. Save to apply.</small></span></label></section>';
    if (rs && sentEmails) html += '<section class="card sc sync-card"><h3>Members from Season Ticket Manager</h3><div id="sync-body"></div></section>';

    html += '<section class="card sc"><h3>Settings</h3><div class="sgrid">' +
      field('Draft title', inp('settings.title', s.title)) +
      (rs ? field('Season <span class="opt">(for the MLB schedule)</span>', inp('settings.season', s.season, 'inputmode="numeric"'))
        : field('Max picks per member', inp('settings.maxPicks', s.maxPicks || '', 'inputmode="numeric" placeholder="No limit"'))) +
      (rs ? field('New commissioner PIN <span class="opt">(both drafts)</span>', '<input data-bind="newCommissionerPin" autocomplete="off" inputmode="numeric" placeholder="Leave blank to keep it">') : '') +
      '</div><div class="checks">' +
      chk('settings.open', s.open, '<strong>Draft open</strong> (members can pick)') +
      chk('settings.snake', s.snake !== false, 'Snake order (reverses every round)') +
      chk('settings.timeLimitOn', tl, 'Pick time limit') +
      '<label class="sf inline' + (tl ? '' : ' off') + '"><span>Hours per pick</span>' + inp('settings.timeLimitHours', s.timeLimitHours || 24, 'inputmode="numeric" style="width:90px"' + (tl ? '' : ' disabled')) + '</label>' +
      '</div><div class="checks reminders">' +
      chk('settings.reminderOn', rem, '<strong>Follow-up reminders</strong> to whoever is on the clock') +
      '<label class="sf inline' + (rem ? '' : ' off') + '"><span>Every</span>' + inp('settings.reminderHours', s.reminderHours || 12, 'inputmode="decimal" style="width:80px"' + (rem ? '' : ' disabled')) + '<span>hours</span></label>' +
      '<label class="sf inline' + (rem ? '' : ' off') + '"><span>Up to</span>' + inp('settings.reminderCount', s.reminderCount || 2, 'inputmode="numeric" style="width:70px"' + (rem ? '' : ' disabled')) + '<span>times per turn</span></label>' +
      '</div><p class="hint">Reminders count from the last alert and follow each member\'s own choices (email and/or push). None are sent from 11 PM to 8 AM ET (one that comes due overnight goes out at 8 AM), while the draft is paused, or to anyone who has dropped out. Checked every 10 minutes.</p></section>';

    if (rs) {
      html += '<section class="card sc"><h3>Members</h3><p class="hint">Listed by last name; anyone you add moves into place when you save. This list is used by both drafts: names, PINs and emails here update the Postseason tab too. Games purchased is each member\'s limit for the regular season. Leave a PIN blank to let someone pick without one. Adding an email turns on email alerts for that member; they can change it under <em>Notification settings</em>.</p>' +
        '<div class="tbl"><table class="stable"><thead><tr><th>Name</th><th>PIN</th><th>Games</th><th>Email (for turn alerts)</th><th></th></tr></thead><tbody>' +
        a.members.map((m, i) => {
          const where = [hasPicks('rs', m.orig) ? 'regular season' : '', hasPicks('post', m.orig) ? 'postseason' : ''].filter(Boolean);
          const lock = where.length ? m.name + ' has picks in the ' + where.join(' and ') + ' draft. Undo those first.' : '';
          return '<tr><td>' + inp('members.' + i + '.name', m.name, 'placeholder="Name"') + '</td><td>' + inp('members.' + i + '.pin', m.pin, 'autocomplete="off" inputmode="numeric" class="pin-in"') + '</td>' +
            '<td>' + inp('members.' + i + '.cap', m.cap || '', 'inputmode="numeric" class="num-in"') + '</td>' +
            '<td>' + inp('members.' + i + '.email', m.email || '', 'type="email" placeholder="Optional" class="email-in"') + '</td>' +
            '<td class="acts">' + iconBtn('del-member', i, 'Remove ' + (m.name || 'member'), '✕', lock) + '</td></tr>';
        }).join('') +
        '</tbody></table></div><div class="row-btns"><button type="button" class="btn ghost" data-act="add-member">+ Add member</button></div></section>';

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
        '<button type="button" class="btn ghost" data-act="fill-order">Rebuild from games purchased</button>' +
        '<button type="button" class="btn ghost" data-act="shuffle-order">🎲 Randomize order</button></div>' +
        '<p class="hint">Randomize shuffles the slots above (or builds them from games purchased if there are none). ' + esc(FIRST3) + ' always gets one of the first 3 picks. Click again for a new order; nothing changes until you save.</p></section>';
    } else {
      const rsMembers = (admin.rs && admin.rs.members) || [];
      const emailOf = (n) => { const m = rsMembers.find((x) => x.name === n); return m ? m.email : ''; };
      html += '<section class="card sc"><h3>Members &amp; draft order</h3><p class="hint">Members come from the <strong>Regular Season</strong> tab; change names, PINs and emails there. ' +
        'Here the list order is the postseason draft order (new members start at the end). ✕ marks someone inactive for the postseason (they keep any picks but get no more turns); ↺ brings them back.</p>' +
        '<div class="tbl"><table class="stable"><thead><tr><th>#</th><th>Name</th><th>PIN</th><th>Email</th><th></th></tr></thead><tbody>' +
        a.members.map((m, i) => '<tr' + (m.inactive ? ' class="inactive"' : '') + '><td class="num">' + (i + 1) + '</td><td>' + ro(m.name) + (m.notInRs ? ' <span class="tag">Not on the regular season list</span>' : m.inactive ? ' <span class="tag">Inactive</span>' : '') + '</td><td>' + ro(m.pin, 'pin-in') + '</td><td>' + ro(emailOf(m.name), 'email-in') + '</td>' +
          '<td class="acts">' + iconBtn('up-member', i, 'Move up', '↑', i === 0 ? 'Already first' : '') + iconBtn('down-member', i, 'Move down', '↓', i === a.members.length - 1 ? 'Already last' : '') +
          (m.inactive ? iconBtn('toggle-member', i, 'Make ' + m.name + ' active again', '↺') : iconBtn('toggle-member', i, 'Mark ' + m.name + ' inactive', '✕')) + '</td></tr>').join('') +
        '</tbody></table></div><div class="row-btns"><button type="button" class="btn ghost" data-act="shuffle-post">🎲 Randomize order</button></div>' +
        '<p class="hint">Randomize shuffles the active members (inactive ones move to the end). ' + esc(FIRST3) + ' always gets one of the first 3 picks. Click again for a new order; nothing changes until you save.</p></section>';
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
    if (rs && TEST) html += '<section class="card sc test-card"><h3>Reset test data</h3><p class="hint">Reloads the test drafts (the 2026 ticket holders on 2027 dates) and clears Ticket Swap listings and offers. The regular season draft starts open with 9 picks left: Sean, Lauren, Colleen, then Andrew, Steve, Bill, Matt, Marie and Mike. Notification settings made in test mode are kept.</p>' +
      '<div class="row-btns"><button type="button" class="btn danger" data-act="test-reset">Reset test data</button></div></section>';
    if (rs && !TEST) html += importCard;
    html += '<div class="save-bar"><span class="hint" id="setup-msg"></span><button type="button" class="btn primary" data-act="save">Save ' + (rs ? 'regular season' : 'postseason') + '</button></div>';
    $('setup-body').innerHTML = html;
    if (rs && sentEmails) renderEmailTool();
  }

  function setPath(obj, path, val) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = val;
  }
  // Re-render Setup without losing your place: keeps the scroll position and the field you're typing in.
  const redrawKeep = () => {
    const y = window.scrollY;
    const ae = document.activeElement;
    const bind = ae && ae.dataset && ae.dataset.bind;
    let sel = null;
    try { sel = bind && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null; } catch (e) { sel = null; }
    renderSetup();
    window.scrollTo(0, y);
    if (bind) {
      const el = $('setup-body').querySelector('[data-bind="' + bind + '"]');
      if (el) { el.focus({ preventScroll: true }); try { if (sel) el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ } }
    }
  };
  $('setup-body').addEventListener('input', (e) => {
    const el = e.target.closest('[data-bind]');
    const a = A();
    if (!el || !a) return;
    const path = el.dataset.bind;
    if (path === 'newCommissionerPin') { a.newCommissionerPin = el.value.trim(); return; }
    if (el.type === 'checkbox') return; // handled on change
    const rename = path.match(/^members\.(\d+)\.name$/);
    if (rename && setupKey === 'rs') {
      // Keep draft-order slots pointing at the same person while their name is edited.
      const old = a.members[Number(rename[1])].name;
      const now = el.value;
      if (old) a.order = a.order.map((n) => (n === old ? now : n));
    }
    setPath(a, path, el.value);
    if (/^order\.|\.cap$/.test(path)) redrawKeep();
  });
  $('setup-body').addEventListener('change', (e) => {
    const el = e.target.closest('[data-bind]');
    const a = A();
    if (!el || !a) return;
    const path = el.dataset.bind;
    if (el.type === 'checkbox') {
      setPath(a, path, el.checked);
      if (/timeLimitOn|reminderOn/.test(path)) redrawKeep(); // enable/disable the hours fields
      return;
    }
    if (/^members\.\d+\.name$/.test(path)) setTimeout(redrawKeep, 0); // refresh the draft-order dropdowns once focus has moved on
  });

  // Randomize: fully random, except FIRST3 always lands in the first 3 picks.
  const FIRST3 = 'James Draeger';
  function randInt(n) {
    try { const u = new Uint32Array(1); crypto.getRandomValues(u); return u[0] % n; } catch (e) { return Math.floor(Math.random() * n); }
  }
  function shuffleOrder(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = out[i]; out[i] = out[j]; out[j] = t; }
    const isMe = (n) => String(n).trim().toLowerCase() === FIRST3.toLowerCase();
    const top = Math.min(3, out.length);
    if (out.some(isMe) && !out.slice(0, top).some(isMe)) {
      const mine = out.map((n, i) => (isMe(n) ? i : -1)).filter((i) => i >= 0);
      const from = mine[randInt(mine.length)];
      const to = randInt(top);
      const t = out[to]; out[to] = out[from]; out[from] = t;
    }
    return out;
  }
  function move(list, i, d) { const j = i + d; if (j < 0 || j >= list.length) return; const t = list[i]; list[i] = list[j]; list[j] = t; }
  $('setup-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || setupBusy) return;
    const i = Number(b.dataset.i);
    const a = A();
    const act = b.dataset.act;
    if (!a && !['import', 'fresh'].includes(act)) return;
    switch (act) {
      case 'add-member': a.members.push({ name: '', pin: '', cap: 0, email: '' }); return redrawKeep();
      case 'del-member': {
        const m = a.members[i];
        if (hasPicks('rs', m.orig) || hasPicks('post', m.orig)) { toast(m.name + ' has picks. Undo those first.'); return; }
        a.members.splice(i, 1);
        if (m.name) a.order = a.order.filter((n) => n !== m.name);
        return redrawKeep();
      }
      case 'up-member': move(a.members, i, -1); return redrawKeep();
      case 'down-member': move(a.members, i, 1); return redrawKeep();
      case 'toggle-member': a.members[i].inactive = !a.members[i].inactive; return redrawKeep();
      case 'shuffle-post': {
        const active = a.members.filter((m) => !m.inactive);
        if (active.length < 2) { toast('Not enough active members to shuffle.'); return; }
        const byName = new Map(a.members.map((m) => [m.name, m]));
        a.members = shuffleOrder(active.map((m) => m.name)).map((n) => byName.get(n)).concat(a.members.filter((m) => m.inactive));
        toast('New random order. Click Save postseason to keep it.');
        return redrawKeep();
      }
      case 'add-slot': a.order.push(a.members[0] ? a.members[0].name : ''); return redrawKeep();
      case 'del-slot': a.order.splice(i, 1); return redrawKeep();
      case 'up-slot': move(a.order, i, -1); return redrawKeep();
      case 'down-slot': move(a.order, i, 1); return redrawKeep();
      case 'shuffle-order': {
        let slots = a.order.filter(Boolean);
        if (!slots.length) a.members.forEach((m) => { for (let k = 0; k < Math.floor(Number(m.cap) / 5); k++) slots.push(m.name); });
        if (!slots.length) { toast('Enter Games purchased for members first.'); return; }
        a.order = shuffleOrder(slots);
        toast('New random order. Click Save regular season to keep it.');
        return redrawKeep();
      }
      case 'fill-order': {
        const out = [];
        a.members.forEach((m) => { for (let k = 0; k < Math.floor(Number(m.cap) / 5); k++) out.push(m.name); });
        if (!out.length) { toast('Enter Games purchased for members first.'); return; }
        a.order = out;
        toast('Order rebuilt: ' + out.length + ' slots. Rearrange them into your draft order, then save.');
        return redrawKeep();
      }
      case 'add-game':
        a.inventory.push(setupKey === 'rs' ? { id: 'custom-' + Date.now(), date: '', opponent: '', time: 'TBD', promos: '', notes: '' } : { id: '', series: '', game: '', date: '', seats: '', price: 0, notes: '' });
        return redrawKeep();
      case 'del-game': a.inventory.splice(i, 1); return redrawKeep();
      case 'csv': return downloadCsv();
      case 'save': return saveSetup(b);
      case 'load-mlb': return setupCall(b, { action: 'loadSchedule', pin: commishPin, draft: 'rs' }, true);
      case 'test-reset':
        if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Yes, reset the test data'; return; }
        return setupCall(b, { action: 'testReset', pin: commishPin, draft: 'rs' }, true).then((r) => { if (r && r.ok) { states.rs = undefined; states.post = undefined; swapListings = null; } });
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
      if (res && res.inventory && body.draft && body.action !== 'import') { states[body.draft] = res; }
      if (res && res.ok) {
        toast(res.message || 'Saved.');
        if (reload) return loadAdmin(body.newPin || commishPin).then(() => res);
      } else {
        toast((res && res.error) || 'Something went wrong.');
        const m = $('setup-msg'); if (m) m.textContent = (res && res.error) || '';
      }
      return res;
    }).catch(() => toast("Couldn't reach the draft. Try again.")).finally(() => { setupBusy = false; btn.disabled = false; btn.textContent = label; });
  }
  function saveSetup(btn) {
    const a = A();
    const key = setupKey;
    // Regular season members are kept alphabetical by last name, so anyone added lands in the right row on save.
    const members = key === 'rs' ? a.members.filter((m) => String(m.name || '').trim()).slice().sort((p, q) => byLast(p.name, q.name)) : a.members;
    const body = { action: 'adminSave', pin: commishPin, draft: key, admin: { settings: a.settings, members, inventory: a.inventory } };
    if (key === 'rs') body.admin.order = a.order;
    if (key === 'rs' && a.newCommissionerPin) { body.admin.newCommissionerPin = a.newCommissionerPin; body.newPin = a.newCommissionerPin; }
    setupCall(btn, body, true).then((res) => {
      if (res && res.ok && body.newPin) { rememberPin(body.newPin); toast('Saved. The new commissioner PIN works for both drafts.'); }
      if (res && res.ok) { states.rs = undefined; states.post = undefined; if (key === 'post') setShowPost(a.settings.showTab !== false); if (key === 'rs') setRsSeason(a.settings.season); }
    });
  }
  function doImport(btn) {
    let payload;
    try { payload = JSON.parse($('import-text').value); } catch (e) { toast('That doesn\'t look like the export text. Copy all of it and try again.'); return; }
    const key = $('import-key').value.trim();
    if (!key) { toast('Enter your setup key or commissioner PIN.'); return; }
    setupCall(btn, { action: 'import', setupKey: key, payload, draft: 'rs' }).then((res) => {
      if (res && res.ok) { states.post = undefined; states.rs = undefined; admin = null; archives = null; commishPin = ''; session.set(''); showLock('Imported. Enter the commissioner PIN to continue.'); }
    });
  }
  function doFresh(btn) {
    const pin = $('fresh-pin').value.trim();
    const key = $('fresh-key').value.trim();
    if (!pin || !key) { toast('Enter a commissioner PIN and your setup key.'); return; }
    const k = setupKey;
    const rsMembers = k === 'post' && admin && admin.rs ? admin.rs.members.map((m) => ({ name: m.name, pin: m.pin })) : null;
    const payload = {};
    payload[k] = { settings: { title: k === 'rs' ? 'Regular Season Draft' : 'Postseason Draft', open: false, snake: true, season: String(new Date().getFullYear() + 1) }, commissionerPin: pin, members: rsMembers && rsMembers.length ? rsMembers : [{ name: 'Member 1' }], order: ['Member 1'], inventory: [], events: [] };
    if (k === 'post') delete payload[k].order;
    setupCall(btn, { action: 'import', setupKey: key, payload, draft: k }).then((res) => { if (res && res.ok) { admin = null; loadAdmin(pin); } });
  }

  function downloadCsv() {
    const s = setupBoards[setupKey] || states[setupKey];
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
  /* Members sent from the Season Ticket Manager (shown at the top of     */
  /* Setup → Regular season): new members, emails and games purchased.   */
  /* ------------------------------------------------------------------ */
  const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z]/g, '');
  const lcEq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  let sync = null; // { data: {drafts, members:[{name, inRs, inPost, games, email}]} } or { loading: true }
  function guessMember(from, names) {
    const exact = names.find((n) => normName(n) === normName(from));
    if (exact) return exact;
    // e.g. "Molly & Tom Jones" in the Manager vs "Molly Jones" here: every word of the draft name appears in the Manager name
    const words = String(from).toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const hits = names.filter((n) => String(n).toLowerCase().split(/[^a-z]+/).filter(Boolean).every((w) => words.includes(w)));
    return hits.length === 1 ? hits[0] : '';
  }
  function renderEmailBanner() {
    const here = view === 'setup' && setupKey === 'rs';
    const show = !!sentEmails && !here && (view === 'setup' || (!!state && !state.notSetUp));
    $('email-banner').hidden = !show;
    if (show) $('email-banner-text').textContent = sentEmails.length + ' member' + (sentEmails.length === 1 ? '' : 's') + ' arrived from the Season Ticket Manager.';
  }
  // What would change for one Manager row, given its match.
  function syncRow(e) {
    const D = sync.data;
    const cur = e.to && e.to !== '__add' ? D.members.find((m) => m.name === e.to) : null;
    const r = { cur, emailChange: false, gamesChange: false };
    if (cur) {
      r.emailChange = !!e.email && !lcEq(e.email, cur.email);
      r.gamesChange = cur.inRs && e.games != null && e.games !== Number(cur.games || 0);
    }
    return r;
  }
  function renderEmailTool() {
    const body = $('sync-body');
    if (!body || !sentEmails) return;
    if (!sync || !sync.data) {
      body.innerHTML = '<p class="hint">Checking what would change…</p>';
      if (!sync) {
        sync = { loading: true };
        apiPost({ action: 'syncMembers', preview: true, pin: commishPin, draft: 'rs' }).then((res) => {
          if (!res || !res.ok) { sync = null; if ($('sync-body')) $('sync-body').innerHTML = '<p class="form-error">' + esc((res && res.error) || 'Something went wrong.') + '</p>'; return; }
          sync = { data: res };
          renderEmailTool();
        }).catch(() => { sync = null; if ($('sync-body')) $('sync-body').innerHTML = '<p class="form-error">Couldn\'t reach the draft.</p>'; });
      }
      return;
    }
    const D = sync.data;
    const names = sortedNames(D.members);
    sentEmails.forEach((e) => { if (e.to === undefined) e.to = guessMember(e.from, names) || '__add'; if (e.emailOn === undefined) e.emailOn = true; if (e.gamesOn === undefined) e.gamesOn = true; });
    const rows = [];
    const same = [];
    sentEmails.forEach((e, i) => {
      const r = syncRow(e);
      if (r.cur && !r.emailChange && !r.gamesChange) { same.push(e.from === e.to ? e.from : e.from + ' (' + e.to + ')'); return; }
      const sel = '<select data-sm="' + i + '" aria-label="Draft member for ' + esc(e.from) + '">' +
        '<option value="__add"' + (e.to === '__add' ? ' selected' : '') + '>Add as a new member</option>' +
        '<option value=""' + (!e.to ? ' selected' : '') + '>Skip</option>' +
        '<optgroup label="Same person as…">' + names.map((n) => '<option' + (n === e.to ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</optgroup></select>';
      let detail = '';
      if (e.to === '__add') detail = '<div class="em-note">New member' + (e.games != null ? ' · ' + e.games + ' games' : '') + (e.email ? ' · ' + esc(e.email) : '') + '</div>';
      else if (!e.to) detail = '<div class="em-note">Not added</div>';
      else {
        if (r.emailChange) detail += '<label class="check"><input type="checkbox" data-sm-email="' + i + '"' + (e.emailOn ? ' checked' : '') + '> <span>Email: ' + (r.cur.email ? '<s>' + esc(r.cur.email) + '</s> → ' : 'add ') + '<strong>' + esc(e.email) + '</strong></span></label>';
        if (r.gamesChange) detail += '<label class="check"><input type="checkbox" data-sm-games="' + i + '"' + (e.gamesOn ? ' checked' : '') + '> <span>Games: <s>' + (Number(r.cur.games) || 0) + '</s> → <strong>' + e.games + '</strong></span></label>';
      }
      rows.push('<div class="em-row' + (e.to === '__add' ? ' is-new' : '') + '"><div><div class="em-who">' + esc(e.from) + '</div>' + detail + '</div>' + sel + '</div>');
    });
    const adds = sentEmails.filter((e) => e.to === '__add').length;
    body.innerHTML =
      (rows.length ? '<div class="email-map">' + rows.join('') + '</div>' : '<p class="hint"><strong>Everything already matches.</strong></p>') +
      (same.length ? '<p class="hint">Already up to date: ' + esc(same.join(', ')) + '.</p>' : '') +
      (adds ? '<p class="hint">New members join both drafts (active in the postseason, at the end of its order). They can pick without a PIN until you set one, and need draft-order slots below.</p>' : '') +
      '<div class="row-btns">' + (rows.length ? '<button type="button" class="btn primary" id="sync-apply">Apply changes</button>' : '') +
      '<button type="button" class="btn ghost" id="sync-dismiss">' + (rows.length ? 'Dismiss' : 'Done') + '</button></div>';
  }
  function syncPayload() {
    const emails = [], games = [], add = [];
    sentEmails.forEach((e) => {
      if (e.to === '__add') { add.push({ name: e.from, games: e.games, email: e.email }); return; }
      if (!e.to) return;
      const r = syncRow(e);
      if (r.emailChange && e.emailOn) emails.push({ name: e.to, email: e.email });
      if (r.gamesChange && e.gamesOn) games.push({ name: e.to, games: e.games });
    });
    return { emails, games, add };
  }
  function endSync() {
    sentEmails = null;
    sync = null;
    try { history.replaceState(null, '', location.pathname + location.search + '#' + VIEWS[view]); } catch (e) { /* ignore */ }
    renderEmailBanner();
  }
  $('setup-body').addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t.closest('#sync-body') || !sentEmails) return;
    if (t.dataset.sm != null) { sentEmails[Number(t.dataset.sm)].to = t.value; renderEmailTool(); return; }
    if (t.dataset.smEmail != null) { sentEmails[Number(t.dataset.smEmail)].emailOn = t.checked; return; }
    if (t.dataset.smGames != null) { sentEmails[Number(t.dataset.smGames)].gamesOn = t.checked; }
  });
  $('setup-body').addEventListener('click', (ev) => {
    const b = ev.target.closest('#sync-body button');
    if (!b || busy) return;
    if (b.id === 'sync-dismiss') { endSync(); renderSetup(); return; }
    if (b.id !== 'sync-apply') return;
    busy = true;
    b.disabled = true;
    apiPost(Object.assign({ action: 'syncMembers', pin: commishPin, draft: 'rs' }, syncPayload())).then((res) => {
      if (res && res.ok) {
        endSync();
        toast(res.message || 'Members updated.');
        states.rs = undefined; states.post = undefined;
        return loadAdmin(commishPin);
      }
      toast((res && res.error) || 'Something went wrong.');
    }).catch(() => toast("Couldn't reach the draft.")).finally(() => { busy = false; b.disabled = false; });
  });
  $('email-review').addEventListener('click', () => { setupKey = 'rs'; if (view === 'setup') { renderSetup(); renderEmailBanner(); } else switchView('setup'); });
  window.addEventListener('hashchange', () => {
    const e = readEmailHash();
    if (e) { sentEmails = e; sync = null; setupKey = 'rs'; if (view === 'setup') { renderSetup(); renderEmailBanner(); } else switchView('setup'); }
  });

  /* ------------------------------------------------------------------ */
  /* Ticket Swap: members post regular season games to trade away and    */
  /* send each other offers. A board only — draft records don't change.  */
  /* ------------------------------------------------------------------ */
  const SWAP_ME_KEY = 'guardians-swap-me';
  let swapListings = null;
  let swapAuth = null;            // { name, pin } once someone has entered their PIN here
  let swapBusy = false;
  const swapMe = () => store.get(SWAP_ME_KEY) || me || '';
  const ICON_MAIL = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/></svg>';
  const ICON_PUSH = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor"><circle cx="12" cy="3.3" r="1.5"/><path d="M12 4.4c-3.5 0-5.9 2.7-5.9 6.2v3.6c0 1-.5 1.9-1.3 2.5l-.6.5c-.6.5-.3 1.4.5 1.4h14.6c.8 0 1.1-.9.5-1.4l-.6-.5c-.8-.6-1.3-1.5-1.3-2.5v-3.6c0-3.5-2.4-6.2-5.9-6.2z"/><path d="M9.4 19.7h5.2a2.6 2.6 0 0 1-5.2 0z"/></svg>';

  // Regular season games (dates, opponents) come from the regular season board.
  const rsGames = () => ((states.rs && states.rs.inventory) || []);
  const rsGame = (id) => rsGames().find((g) => g.id === id);
  const todayIso = () => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch (e) { return new Date().toISOString().slice(0, 10); } };
  const gLabel = (id) => { const g = rsGame(id); if (!g) return 'A game'; const d = ymd(g.date); return (dowOf(g.date) + ' ' + (d ? d[1] + '/' + d[2] : '') + ' vs ' + g.opponent).trim(); };
  const gChips = (list) => list.map((id) => '<span class="gchip">' + esc(gLabel(id)) + '</span>').join('');
  function ensureRs() {
    if (states.rs && states.rs.inventory) return Promise.resolve(states.rs);
    return apiGet('rs').then((r) => { if (r && r.inventory) states.rs = r; return states.rs; }).catch(() => null);
  }
  const swapPost = (body) => apiPost(Object.assign({ draft: 'rs' }, body));

  function loadSwap() {
    if (DEMO) { swapListings = swapListings || []; renderSwap(); return Promise.resolve(); }
    return swapPost({ action: 'swapList' }).then((r) => {
      if (r && r.ok) { swapListings = r.listings || []; renderSwapBadge(); if (view === 'swap') { markSynced(); renderSwap(); } }
    }).catch(() => { if (view === 'swap' && !swapListings) $('swap-list').innerHTML = '<p class="empty">Couldn\'t load Ticket Swap. Trying again…</p>'; });
  }
  function openSwap() {
    syncSwitch();
    if (!swapListings) $('swap-list').innerHTML = '<p class="empty">Loading…</p>';
    else renderSwap();
    ensureRs().then(() => loadSwap());
  }
  // Badge on the tab: new offers on this person's own listings.
  function renderSwapBadge() {
    const who = swapMe();
    const n = who && swapListings ? swapListings.filter((l) => l.member === who).reduce((t, l) => t + (l.newOffers || 0), 0) : 0;
    $('swap-badge').hidden = !n;
    $('swap-badge').textContent = n ? String(n) : '';
    $('swap-tab').setAttribute('aria-label', 'Ticket Swap' + (n ? ' (' + n + ' new offer' + (n === 1 ? '' : 's') + ')' : ''));
  }
  function renderSwap() {
    const who = swapMe();
    const list = swapListings || [];
    if (!list.length) { $('swap-list').innerHTML = '<div class="notice-card">No listings right now. Have a game you can\'t make? <strong>Post a listing</strong> and members will get an email.</div>'; return; }
    const card = (l) => {
      const own = l.member === who;
      const posted = l.createdAt ? new Date(l.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      const icons = (l.notify.email ? '<span class="sw-ico" title="Gets offers by email">' + ICON_MAIL + '<span class="sr">email</span></span>' : '') +
        (l.notify.push ? '<span class="sw-ico" title="Gets offers by push notification">' + ICON_PUSH + '<span class="sr">push</span></span>' : '');
      const offers = l.offerCount ? l.offerCount + ' offer' + (l.offerCount === 1 ? '' : 's') : 'No offers yet';
      return '<article class="card swap-card' + (own ? ' mine' : '') + '">' +
        '<div class="sw-top"><span class="sw-who">' + esc(l.member) + (own ? ' <span class="tag mine">Your listing</span>' : '') + '</span>' + (icons ? '<span class="sw-icons">' + icons + '</span>' : '') + '<span class="sw-when">' + esc(posted) + '</span></div>' +
        '<div class="sw-row"><span class="sw-k">Trading away</span><div class="gchips">' + gChips(l.liveGames) + '</div></div>' +
        '<div class="sw-row"><span class="sw-k">Tickets</span><span>' + l.qty + (l.split ? ' · will split into 2' : '') + '</span></div>' +
        '<div class="sw-row"><span class="sw-k">Looking for</span>' + (l.seekAny || !l.seek.length ? '<span>Any game</span>' : '<div class="gchips">' + gChips(l.seek) + '</div>') + '</div>' +
        '<div class="sw-actions"><span class="hint">' + offers + '</span>' +
          (own
            ? '<button type="button" class="btn ghost small" data-sw="offers" data-id="' + esc(l.id) + '">Offers' + (l.newOffers ? ' <span class="tab-badge">' + l.newOffers + '</span>' : '') + '</button>' +
              '<button type="button" class="btn ghost small" data-sw="edit" data-id="' + esc(l.id) + '">Edit</button>'
            : '<button type="button" class="btn primary small" data-sw="offer" data-id="' + esc(l.id) + '">Make an offer</button>' +
              (commishPin ? '<button type="button" class="btn ghost small" data-sw="edit" data-id="' + esc(l.id) + '">Edit</button>' : '')) +
        '</div></article>';
    };
    // Your own listings get their own section at the top.
    const mine = list.filter((l) => l.member === who);
    const others = list.filter((l) => l.member !== who);
    $('swap-list').innerHTML = mine.length
      ? '<h3 class="sw-sec">Your listings</h3>' + mine.map(card).join('') +
        '<h3 class="sw-sec">Other members\' listings</h3>' + (others.length ? others.map(card).join('') : '<p class="empty sw-none">No other listings right now.</p>')
      : others.map(card).join('');
  }

  /* One dialog, filled in for each step. */
  function swapDlg(title, html, actions) {
    $('swap-dlg-title').textContent = title;
    $('swap-dlg-body').innerHTML = html;
    $('swap-error').textContent = '';
    $('swap-dlg-actions').innerHTML = actions.map((a) => '<button type="' + (a.submit ? 'submit' : 'button') + '" class="btn ' + (a.cls || 'ghost') + '" data-sa="' + a.id + '">' + a.label + '</button>').join('');
    swapActions = {};
    actions.forEach((a) => { swapActions[a.id] = a.run; });
    if (!$('swap-dialog').open) $('swap-dialog').showModal();
  }
  let swapActions = {};
  const swapErr = (msg) => { $('swap-error').textContent = msg || ''; };
  $('swap-dlg-actions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sa]');
    if (!b) return;
    e.preventDefault();
    const fn = swapActions[b.dataset.sa];
    if (fn) fn(b);
  });
  $('swap-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const b = $('swap-dlg-actions').querySelector('button[type="submit"]');
    if (b && swapActions[b.dataset.sa]) swapActions[b.dataset.sa](b);
  });
  const close = { id: 'close', label: 'Close', run: () => $('swap-dialog').close() };
  function busyRun(btn, fn) {
    if (swapBusy) return;
    swapBusy = true;
    btn.disabled = true;
    swapErr('');
    Promise.resolve().then(fn).catch((e) => { console.warn(e); swapErr("Couldn't reach the draft. Try again."); })
      .finally(() => { swapBusy = false; btn.disabled = false; });
  }

  /* Who are you? Name + PIN, once per visit. */
  function swapWho(title, intro, next) {
    if (swapAuth) return next(swapAuth);
    const members = (states.rs && states.rs.members) || [];
    const names = sortedNames(members);
    const pre = names.includes(swapMe()) ? swapMe() : '';
    swapDlg(title, '<p class="hint">' + intro + '</p>' +
      '<label>Your name<select id="sw-name"><option value="">Choose your name…</option>' + names.map((n) => '<option' + (n === pre ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select></label>' +
      '<label id="sw-pin-wrap">Your PIN<input id="sw-pin" inputmode="numeric" type="password" autocomplete="off" placeholder="Your PIN"></label>',
      [close, { id: 'go', label: 'Continue', cls: 'primary', submit: true, run: (b) => {
        const name = $('sw-name').value;
        if (!name) return swapErr('Choose your name.');
        const pin = $('sw-pin').value.trim();
        busyRun(b, async () => {
          const r = await swapPost({ action: 'swapMine', name, pin });
          if (!r || !r.ok) return swapErr((r && r.error) || 'Something went wrong.');
          swapAuth = { name, pin, mine: r.games || [], email: !!r.email, push: !!r.push };
          store.set(SWAP_ME_KEY, name);
          setViewer(name);
          renderSwapBadge();
          renderSwap();
          next(swapAuth);
        });
      } }]);
    const sync = () => { const m = members.find((x) => x.name === $('sw-name').value); $('sw-pin-wrap').hidden = !!m && !m.needsPin; };
    $('sw-name').addEventListener('change', sync);
    sync();
  }
  // Refresh "my games" and alert options (they can change while the page is open).
  async function refreshAuth() {
    const r = await swapPost({ action: 'swapMine', name: swapAuth.name, pin: swapAuth.pin });
    if (r && r.ok) Object.assign(swapAuth, { mine: r.games || [], email: !!r.email, push: !!r.push });
  }

  const checkList = (name, ids, picked, extra) => '<div class="sw-checks">' + (ids.length ? ids.map((id) =>
    '<label class="check"><input type="checkbox" data-' + name + '="' + esc(id) + '"' + (picked.includes(id) ? ' checked' : '') + '> <span>' + esc(gLabel(id)) + (extra ? extra(id) : '') + '</span></label>').join('') : '<p class="hint">None.</p>') + '</div>';
  const checked = (name) => Array.from($('swap-dlg-body').querySelectorAll('input[data-' + name + ']:checked')).map((x) => x.getAttribute('data-' + name));

  /* "Tell me about offers by" choices. Missing ones link to Notification settings,
     which opens on top of the listing so nothing typed is lost. */
  function offerAlertOpts(a, n) {
    const own = a === swapAuth;
    const link = (txt) => own ? ' <button type="button" class="link-btn sw-notify-link">' + txt + '</button>' : ' <small class="hint">(not set up)</small>';
    return '<label class="check"><input type="checkbox" id="sw-n-push"' + (n.push && a.push ? ' checked' : '') + (a.push ? '' : ' disabled') + '> <span>Push notification</span></label>' + (a.push ? '' : link('Set up push')) +
      '<label class="check"><input type="checkbox" id="sw-n-email"' + (n.email && a.email ? ' checked' : '') + (a.email ? '' : ' disabled') + '> <span>Email</span></label>' + (a.email ? '' : link('Add your email')) +
      (own && a.push && a.email ? '<p class="hint"><button type="button" class="link-btn sw-notify-link">Notification &amp; PIN settings</button></p>' : '');
  }
  function wireOfferAlerts(a) {
    const box = $('sw-notify');
    if (!box) return;
    box.querySelectorAll('.sw-notify-link').forEach((b) => b.addEventListener('click', () => {
      const before = { push: a.push, email: a.email };
      const keep = { push: $('sw-n-push').checked, email: $('sw-n-email').checked };
      openNotify({ name: a.name, pin: a.pin, onClose: async () => {
        await refreshAuth();
        if (!$('swap-dialog').open || !$('sw-notify')) return;
        // Tick anything that was just turned on; keep the rest as they were.
        const n = { push: keep.push || (!before.push && a.push), email: keep.email || (!before.email && a.email) };
        $('sw-notify').innerHTML = offerAlertOpts(a, n);
        wireOfferAlerts(a);
      } });
    }));
  }

  /* Post or edit a listing */
  function listingForm(L, who) {
    const a = who || swapAuth;
    const today = todayIso();
    const ownerGames = L ? Array.from(new Set(a.mine.concat(L.liveGames))) : a.mine;
    const away = ownerGames.slice().sort((x, y) => String((rsGame(x) || {}).date).localeCompare(String((rsGame(y) || {}).date)));
    const others = rsGames().filter((g) => String(g.date) >= today && !away.includes(g.id)).map((g) => g.id);
    const qty = L ? L.qty : 4;
    const seekAny = L ? (L.seekAny || !L.seek.length) : true;
    const n = L ? L.notify : { email: a.email, push: a.push };
    const html =
      (L && a.pin === commishPin && L.member !== swapMe() ? '<p class="hint">Editing <strong>' + esc(L.member) + '</strong>\'s listing as commissioner.</p>' : '') +
      '<fieldset class="nset"><legend>Games to trade away</legend>' +
        (away.length > 1 ? '<button type="button" class="link-btn sw-all" id="sw-away-all">Select all</button>' : '') +
        (away.length ? checkList('away', away, L ? L.liveGames : (away.length === 1 ? away : [])) : '<p class="hint">You don\'t have any upcoming regular season games to trade.</p>') + '</fieldset>' +
      '<fieldset class="nset"><legend>Tickets</legend><div class="sw-inline">' +
        '<label class="check"><input type="radio" name="sw-qty" value="4"' + (qty === 4 ? ' checked' : '') + '> <span>4 tickets</span></label>' +
        '<label class="check"><input type="radio" name="sw-qty" value="2"' + (qty === 2 ? ' checked' : '') + '> <span>2 tickets</span></label></div>' +
        '<label class="check" id="sw-split-wrap"><input type="checkbox" id="sw-split"' + (L && L.split ? ' checked' : '') + '> <span>Open to trading just 2 of the 4</span></label></fieldset>' +
      '<fieldset class="nset"><legend>Looking for</legend><div class="sw-inline">' +
        '<label class="check"><input type="radio" name="sw-seek" value="any"' + (seekAny ? ' checked' : '') + '> <span>Any game</span></label>' +
        '<label class="check"><input type="radio" name="sw-seek" value="pick"' + (seekAny ? '' : ' checked') + '> <span>Specific games</span></label></div>' +
        '<div id="sw-seek-list"' + (seekAny ? ' hidden' : '') + '>' + checkList('seek', others, L ? L.seek : []) + '</div></fieldset>' +
      '<fieldset class="nset"><legend>Tell me about offers by</legend><div id="sw-notify">' + offerAlertOpts(a, n) + '</div>' +
        '<p class="hint">You\'ll also see a number on the Ticket Swap tab when an offer comes in.</p></fieldset>';
    const actions = [close];
    if (L) {
      actions.unshift({ id: 'remove', label: 'Remove listing', cls: 'danger', run: (b) => setStatus(b, L, 'removed', a) });
      actions.unshift({ id: 'done', label: 'Mark fulfilled', cls: 'ghost', run: (b) => setStatus(b, L, 'fulfilled', a) });
    }
    actions.push({ id: 'save', label: L ? 'Save changes' : 'Post listing', cls: 'primary', submit: true, run: (b) => {
      const games = checked('away');
      if (!games.length) return swapErr('Choose at least one game to trade away.');
      const q = Number((($('swap-dlg-body').querySelector('input[name="sw-qty"]:checked')) || {}).value) || 4;
      const any = ((($('swap-dlg-body').querySelector('input[name="sw-seek"]:checked')) || {}).value || 'any') === 'any';
      const seek = any ? [] : checked('seek');
      if (!any && !seek.length) return swapErr('Choose the games you\'re looking for, or pick Any game.');
      const notify = { push: $('sw-n-push').checked, email: $('sw-n-email').checked };
      busyRun(b, async () => {
        const r = await swapPost({ action: 'swapSave', name: a.name, pin: a.pin, listing: { id: L ? L.id : undefined, games, qty: q, split: q === 4 && $('sw-split').checked, seekAny: any, seek, notify } });
        if (!r || !r.ok) return swapErr((r && r.error) || 'Something went wrong.');
        $('swap-dialog').close();
        toast(r.message || 'Saved.');
        loadSwap();
      });
    } });
    swapDlg(L ? 'Edit listing' : 'Post a listing', html, actions);
    const body = $('swap-dlg-body');
    const syncQty = () => { const q = (body.querySelector('input[name="sw-qty"]:checked') || {}).value; $('sw-split-wrap').hidden = q !== '4'; };
    const syncSeek = () => { $('sw-seek-list').hidden = (body.querySelector('input[name="sw-seek"]:checked') || {}).value !== 'pick'; };
    body.querySelectorAll('input[name="sw-qty"]').forEach((x) => x.addEventListener('change', syncQty));
    body.querySelectorAll('input[name="sw-seek"]').forEach((x) => x.addEventListener('change', syncSeek));
    syncQty();
    // Select all / Clear all for the games to trade away.
    const allBtn = $('sw-away-all');
    if (allBtn) {
      const boxes = () => Array.from(body.querySelectorAll('input[data-away]'));
      const syncAll = () => { allBtn.textContent = boxes().every((x) => x.checked) ? 'Clear all' : 'Select all'; };
      allBtn.addEventListener('click', () => { const on = !boxes().every((x) => x.checked); boxes().forEach((x) => { x.checked = on; }); syncAll(); });
      boxes().forEach((x) => x.addEventListener('change', syncAll));
      syncAll();
    }
    wireOfferAlerts(a);
    if (!away.length) $('swap-dlg-actions').querySelector('[data-sa="save"]').disabled = true;
  }
  function setStatus(btn, L, status, a) {
    if (status === 'removed' && !btn.classList.contains('armed')) { btn.classList.add('armed'); btn.textContent = 'Yes, remove it'; return; }
    busyRun(btn, async () => {
      const r = await swapPost({ action: 'swapStatus', id: L.id, status, name: a.name, pin: a.pin });
      if (!r || !r.ok) return swapErr((r && r.error) || 'Something went wrong.');
      $('swap-dialog').close();
      toast(r.message || 'Saved.');
      loadSwap();
    });
  }

  /* Make an offer on someone else's listing */
  function offerForm(L) {
    const a = swapAuth;
    if (a.name === L.member) { swapDlg('Make an offer', '<p class="hint">That\'s your own listing. Use <strong>Edit</strong> to change it.</p>', [close]); return; }
    const canTwo = L.qty === 2 || L.split;
    const seekOnly = !L.seekAny && L.seek.length > 0;
    // When the lister named games, only those (that you hold) can be offered.
    const mine = a.mine.filter((id) => !seekOnly || L.seek.includes(id))
      .sort((x, y) => String((rsGame(x) || {}).date).localeCompare(String((rsGame(y) || {}).date)));
    const html =
      '<p class="hint"><strong>' + esc(L.member) + '</strong> is trading away ' + L.liveGames.length + ' game' + (L.liveGames.length === 1 ? '' : 's') + '. They\'ll get your offer' +
        (L.notify.push && L.notify.email ? ' by push and email' : L.notify.push ? ' by push notification' : L.notify.email ? ' by email' : ' on the Ticket Swap page') + '.</p>' +
      '<fieldset class="nset"><legend>Game(s) you\'re interested in</legend>' + checkList('want', L.liveGames, L.liveGames.length === 1 ? L.liveGames : []) + '</fieldset>' +
      '<fieldset class="nset"><legend>Tickets</legend>' +
        (canTwo && L.qty === 4
          ? '<div class="sw-inline"><label class="check"><input type="radio" name="sw-oqty" value="4" checked> <span>4 tickets</span></label><label class="check"><input type="radio" name="sw-oqty" value="2"> <span>2 tickets</span></label></div>'
          : '<p>' + L.qty + ' tickets</p>') + '</fieldset>' +
      '<fieldset class="nset"><legend>What you\'d trade</legend>' +
        '<p class="hint">' + (seekOnly ? esc(L.member) + ' is looking for: ' + esc(L.seek.map(gLabel).join(', ')) + '.' : esc(L.member) + ' is open to any game.') +
          (seekOnly && !mine.length ? ' You don\'t hold any of those, so choose Other and explain in the note.' : '') + '</p>' +
        '<div class="sw-checks">' + mine.map((id) => '<label class="check"><input type="checkbox" data-give="' + esc(id) + '"' + (mine.length === 1 ? ' checked' : '') + '> <span>' + esc(gLabel(id)) + '</span></label>').join('') +
          '<label class="check"><input type="checkbox" id="sw-other"' + (mine.length ? '' : ' checked') + '> <span>Other (see note)</span></label></div></fieldset>' +
      '<label><span>Note <span class="opt" id="sw-note-opt">(optional)</span></span><textarea id="sw-note" rows="3" maxlength="1000" placeholder="e.g. Happy to do just 2, or I can meet you at the gate"></textarea></label>' +
      '<fieldset class="nset"><legend>Tell me if they accept or reject by</legend><div id="sw-notify">' + offerAlertOpts(a, { push: a.push, email: a.email }) + '</div></fieldset>';
    swapDlg('Offer to ' + L.member, html, [close, { id: 'send', label: 'Send offer', cls: 'primary', submit: true, run: (b) => {
      const wants = checked('want');
      if (!wants.length) return swapErr('Choose the game(s) you\'re interested in.');
      const gives = checked('give');
      const other = $('sw-other').checked;
      if (!gives.length && !other) return swapErr('Choose what you\'d trade, or Other and explain in the note.');
      if (other && !$('sw-note').value.trim()) return swapErr('Add a note explaining your Other offer.');
      const q = Number((($('swap-dlg-body').querySelector('input[name="sw-oqty"]:checked')) || {}).value) || L.qty;
      const notify = { push: $('sw-n-push').checked, email: $('sw-n-email').checked };
      busyRun(b, async () => {
        const r = await swapPost({ action: 'swapOffer', id: L.id, name: a.name, pin: a.pin, wants, gives, giveOther: other, qty: q, note: $('sw-note').value, notify });
        if (!r || !r.ok) return swapErr((r && r.error) || 'Something went wrong.');
        $('swap-dialog').close();
        toast(r.message || 'Offer sent.');
        loadSwap();
      });
    } }]);
    wireOfferAlerts(a);
    const syncOther = () => { $('sw-note-opt').textContent = $('sw-other').checked ? '(required for Other)' : '(optional)'; };
    $('sw-other').addEventListener('change', syncOther);
    syncOther();
  }

  /* Offers on your listing */
  function offersView(L) {
    swapDlg('Offers on your listing', '<p class="empty">Loading…</p>', [close]);
    swapPost({ action: 'swapOffers', id: L.id, name: swapAuth.name, pin: swapAuth.pin }).then((r) => {
      if (!r || !r.ok) { $('swap-dlg-body').innerHTML = ''; return swapErr((r && r.error) || 'Something went wrong.'); }
      const offers = r.offers || [];
      $('swap-dlg-body').innerHTML = '<p class="hint">Trading away: ' + esc(L.liveGames.map(gLabel).join(', ')) + '. Accept or reject each offer; they\'ll hear back the way they asked. Accepting one rejects the other offers for the same game(s). Accepted games come off your listing, and once they\'re all traded it\'s marked fulfilled.</p>' +
        (offers.length ? offers.map((o) => {
          const when = o.createdAt ? new Date(o.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
          const first = esc(o.from.split(' ')[0]);
          const mail = (o.email ? '<a class="btn ghost small" href="mailto:' + esc([o.email, o.email2].filter(Boolean).join(',')) + '?subject=' + encodeURIComponent('Ticket Swap: ' + L.liveGames.map(gLabel).join(', ')) + '">Email ' + first + '</a>' : '') +
            (o.phone ? '<a class="btn ghost small" href="sms:' + esc(o.phone.replace(/\D/g, '')) + '" title="' + esc(o.phone) + '">Text ' + first + '</a>' : '') ||
            '<span class="hint">No email or phone on file</span>';
          const st = o.status || 'pending';
          const tag = st === 'accepted' ? ' <span class="tag ok">Accepted</span>' : st === 'rejected' ? ' <span class="tag">Rejected' + (o.autoRejected ? ' (traded to someone else)' : '') + '</span>' : o.seen ? '' : ' <span class="tag new">New</span>';
          const decide = st === 'pending' ? '<button type="button" class="btn small ghost" data-resp="reject" data-oid="' + esc(o.id) + '">Reject</button><button type="button" class="btn small primary" data-resp="accept" data-oid="' + esc(o.id) + '">Accept</button>' : '';
          return '<div class="offer offer-' + st + (o.seen || st !== 'pending' ? '' : ' new') + '"><div class="sw-top"><span class="sw-who">' + esc(o.from) + tag + '</span><span class="sw-when">' + esc(when) + '</span></div>' +
            '<div class="sw-row"><span class="sw-k">Wants</span><div class="gchips">' + gChips(o.wants) + '</div></div>' +
            '<div class="sw-row"><span class="sw-k">Tickets</span><span>' + o.qty + '</span></div>' +
            '<div class="sw-row"><span class="sw-k">Offers</span>' + (o.gives.length || o.giveOther ? '<div class="gchips">' + gChips(o.gives) + (o.giveOther ? '<span class="gchip other">Other (see note)</span>' : '') + '</div>' : '<span class="hint">Nothing listed</span>') + '</div>' +
            (o.note ? '<div class="sw-row"><span class="sw-k">Note</span><span class="sw-note">' + esc(o.note) + '</span></div>' : '') +
            '<div class="sw-actions">' + mail + '<span class="sw-decide">' + decide + '</span></div></div>';
        }).join('') : '<p class="empty">No offers yet.</p>');
      $('swap-dlg-body').querySelectorAll('button[data-resp]').forEach((b) => b.addEventListener('click', () => {
        const accept = b.dataset.resp === 'accept';
        if (!b.classList.contains('armed')) {
          $('swap-dlg-body').querySelectorAll('button[data-resp].armed').forEach((x) => { x.classList.remove('armed'); x.textContent = x.dataset.resp === 'accept' ? 'Accept' : 'Reject'; });
          b.classList.add('armed');
          b.textContent = accept ? 'Yes, accept' : 'Yes, reject';
          return;
        }
        busyRun(b, async () => {
          const res = await swapPost({ action: 'swapRespond', offerId: b.dataset.oid, decision: b.dataset.resp, name: swapAuth.name, pin: swapAuth.pin });
          if (!res || !res.ok) return swapErr((res && res.error) || 'Something went wrong.');
          toast(res.message);
          const o = offers.find((x) => x.id === b.dataset.oid);
          offersView(accept && o ? Object.assign({}, L, { liveGames: L.liveGames.filter((g) => !o.wants.includes(g)) }) : L);
        });
      }));
      loadSwap();
    }).catch(() => swapErr("Couldn't reach the draft."));
  }

  $('swap-new').addEventListener('click', () => {
    ensureRs().then(() => swapWho('Post a listing', 'Choose your name and enter your PIN to post games you\'d like to trade away.', async () => { await refreshAuth(); listingForm(null); }));
  });
  $('swap-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sw]');
    if (!b) return;
    const L = (swapListings || []).find((x) => x.id === b.dataset.id);
    if (!L) return;
    const act = b.dataset.sw;
    ensureRs().then(() => {
      if (act === 'offer') swapWho('Make an offer', 'Choose your name and enter your PIN to send ' + esc(L.member) + ' an offer.', async () => { await refreshAuth(); offerForm(L); });
      if (act === 'edit' && commishPin && L.member !== swapMe()) {
        // Commissioner (Setup unlocked) editing someone else's listing.
        swapPost({ action: 'swapMine', name: L.member, pin: commishPin }).then((r) => {
          if (!r || !r.ok) { toast((r && r.error) || 'Something went wrong.'); return; }
          listingForm(L, { name: L.member, pin: commishPin, mine: r.games || [], email: !!r.email, push: !!r.push });
        });
        return;
      }
      if (act === 'edit') swapWho('Edit listing', 'Enter your PIN to change this listing.', async () => {
        if (swapAuth.name !== L.member) { swapDlg('Edit listing', '<p class="hint">Only ' + esc(L.member) + ' can change this listing.</p>', [close]); return; }
        await refreshAuth();
        listingForm(L);
      });
      if (act === 'offers') swapWho('Offers', 'Enter your PIN to see the offers on your listing.', () => offersView(L));
    });
  });
  // Keep the tab badge current in the background, and the list current while it's open.
  if (!DEMO) setInterval(() => { if (!document.hidden && !$('swap-dialog').open) loadSwap(); }, view === 'swap' ? 30000 : 60000);

  /* ------------------------------------------------------------------ */
  /* Email & push alerts: each member chooses what they get               */
  /* ------------------------------------------------------------------ */
  const PUSH_TOKEN_KEY = 'guardians-draft-push-token';
  let notifyName = '';
  let notifyPin = '';
  let notifyPrefs = null;
  let notifySuggest = '';   // member's address to pre-fill when none is saved yet
  let notifyBusy = false;

  function notifyPost(body) {
    body.name = notifyName;
    body.pin = notifyPin;
    return apiPost(body);
  }
  // Members for Notification settings: the draft on screen, or the regular season draft (Ticket Swap, Setup).
  const notifyMembers = () => (state && state.members) || (states.rs && states.rs.members) || null;
  let notifyOnClose = null;
  async function openNotify(opts) {
    opts = opts && opts.name ? opts : {};
    if (!notifyMembers()) {
      if (view !== 'rs' && view !== 'post') await ensureRs();
      if (!notifyMembers()) { toast('One moment, the draft is still loading.'); if (isDraftView(view)) wantNotify = true; return; }
    }
    // Coming from Ticket Swap: already signed in, so go straight to the settings.
    if (opts.name && !(notifyPrefs && notifyName === opts.name)) {
      notifyName = opts.name;
      notifyPin = opts.pin || '';
      try {
        const res = await notifyPost({ action: 'notifyGet', token: store.get(PUSH_TOKEN_KEY) || '' });
        if (res && res.ok) { notifyPrefs = res.prefs || {}; notifySuggest = res.suggestEmail || ''; rememberNotifyOn(notifyPrefs); } else notifyPrefs = null;
      } catch (e) { notifyPrefs = null; }
    }
    notifyOnClose = opts.onClose || null;
    const names = sortedNames(notifyMembers());
    $('notify-name').innerHTML = '<option value="">Choose your name…</option>' + names.map((n) => '<option>' + esc(n) + '</option>').join('');
    $('notify-name').value = names.includes(notifyName) ? notifyName : (names.includes(me) ? me : '');
    $('notify-pin').value = '';
    $('notify-error').textContent = '';
    showNotifyStep(!!notifyPrefs && $('notify-name').value === notifyName);
    syncNotifyPinField();
    $('notify-dialog').showModal();
  }
  function syncNotifyPinField() {
    const m = (notifyMembers() || []).find((x) => x.name === $('notify-name').value);
    $('notify-pin-wrap').hidden = !!m && !m.needsPin;
  }
  function showNotifyStep(settings) {
    $('notify-who').hidden = settings;
    $('notify-settings').hidden = !settings;
    $('notify-dialog').classList.toggle('wide', settings); // two columns on wider screens
    if (settings) fillNotify();
  }
  function fillNotify() {
    const p = notifyPrefs || {};
    showPinFields(false);
    $('notify-for').textContent = notifyName;
    // On-screen alerts: on if this device already follows this member, or if nobody is set yet.
    // (ticked to start, until this browser has saved a choice)
    $('notify-screen').checked = me ? me === notifyName : !store.get('guardians-screen-chosen');
    $('notify-email').value = p.email || (!p.email2 && notifySuggest) || '';
    $('notify-email2').value = p.email2 || '';
    $('notify-phone').value = p.phone || '';
    $('notify-email-on').checked = !!p.emailOn;
    $('notify-swap').checked = p.swapEmails !== false;
    $('notify-next').checked = !!p.nextUp;
    syncNextUp();
    $('notify-push-on').checked = p.pushOn !== false;
    renderPushStatus();
  }
  async function renderPushStatus() {
    const st = window.DraftPush ? await window.DraftPush.status() : 'off';
    const p = notifyPrefs || {};
    // Draft turn push only makes sense once a device is on.
    const anyDevice = (p.devices || 0) > 0;
    $('notify-push-on').disabled = !anyDevice;
    $('notify-push-hint').hidden = anyDevice;
    if (!anyDevice) $('notify-push-on').checked = false;
    syncNextUp();
    const mine = !!store.get(PUSH_TOKEN_KEY) && p.hasThisDevice;
    const btn = $('push-btn');
    btn.hidden = false;
    btn.disabled = false;
    if (st === 'off') {
      $('push-status').textContent = DEMO ? 'Push works once the draft is live.' : "Push isn't set up yet. Email works now.";
      btn.hidden = true;
    } else if (st === 'ios-install') {
      $('push-status').innerHTML = 'On iPhone or iPad, first add this page to your Home Screen: tap <strong>Share</strong> → <strong>Add to Home Screen</strong>. Then open the draft from that icon and come back here.';
      btn.hidden = true;
    } else if (st === 'unsupported') {
      $('push-status').textContent = "This browser can't receive push notifications. Try Chrome, Edge, Firefox or Safari, or use email.";
      btn.hidden = true;
    } else if (st === 'denied') {
      $('push-status').textContent = 'Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.';
      btn.hidden = true;
    } else if (mine) {
      $('push-status').innerHTML = '<span class="push-on">✓ On for this device.</span>';
      btn.textContent = 'Turn off for this device';
      btn.dataset.mode = 'off';
    } else {
      $('push-status').textContent = 'Get a notification on this ' + (/Mobi|Android|iPhone/i.test(navigator.userAgent) ? 'phone' : 'device') + " when it's your turn.";
      btn.textContent = 'Turn on for this device';
      btn.dataset.mode = 'on';
    }
  }
  // ✓ on the Notification settings button when this person has any alert turned on:
  // on-screen alerts in this browser, push on this device, or (from their saved settings) email or push anywhere.
  const NOTIFY_ON_KEY = 'guardians-notify-on';
  function rememberNotifyOn(p) {
    const on = !!p && ((!!p.emailOn && !!(p.email || p.email2)) || Number(p.devices) > 0);
    store.set(NOTIFY_ON_KEY, on ? '1' : '');
    renderNotifyCheck();
  }
  function renderNotifyCheck() {
    const on = !!me || !!store.get(PUSH_TOKEN_KEY) || store.get(NOTIFY_ON_KEY) === '1';
    ['notify-btn', 'swap-notify-btn'].forEach((id) => {
      $(id).classList.toggle('is-on', on);
      $(id).setAttribute('aria-label', 'Notification & PIN settings' + (on ? ' (on)' : ''));
    });
  }
  function notifyDone(res) {
    if (res && res.ok) {
      if (res.prefs) notifyPrefs = Object.assign({}, notifyPrefs, res.prefs, { hasThisDevice: 'hasThisDevice' in res.prefs ? res.prefs.hasThisDevice : notifyPrefs && notifyPrefs.hasThisDevice });
      rememberNotifyOn(notifyPrefs);
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
  const notifyForm = () => ({ email: $('notify-email').value.trim(), email2: $('notify-email2').value.trim(), phone: $('notify-phone').value.trim(), emailOn: $('notify-email-on').checked, pushOn: $('notify-push-on').checked, swapEmails: $('notify-swap').checked, nextUp: $('notify-next').checked });

  $('notify-btn').addEventListener('click', () => openNotify());
  $('swap-notify-btn').addEventListener('click', () => openNotify(swapAuth ? { name: swapAuth.name, pin: swapAuth.pin } : undefined));
  $('notify-dialog').addEventListener('close', () => { const f = notifyOnClose; notifyOnClose = null; if (f) f(); });
  $('notify-cancel').addEventListener('click', () => $('notify-dialog').close());
  $('notify-name').addEventListener('change', syncNotifyPinField);
  $('notify-change').addEventListener('click', () => { notifyPrefs = null; showNotifyStep(false); });
  // "Up next" needs push or email ticked for drafts; otherwise there's nothing to send it by.
  function syncNextUp() {
    const any = $('notify-push-on').checked || $('notify-email-on').checked;
    $('notify-next').disabled = !any;
    $('nextup-opt').classList.toggle('off', !any);
    $('nextup-hint').textContent = any
      ? 'Goes out by whichever of push and email you ticked above, one pick before your turn. The on-screen banner always shows when you\'re up next.'
      : 'Tick push or email above to use this. The on-screen banner always shows when you\'re up next.';
  }
  ['notify-push-on', 'notify-email-on'].forEach((id) => $(id).addEventListener('change', syncNextUp));

  /* Change your own PIN (saved to the member list the commissioner sees in Setup). */
  function showPinFields(on) {
    $('pin-fields').hidden = !on;
    $('pin-open').hidden = on;
    ['pin-old', 'pin-new', 'pin-new2'].forEach((id) => { $(id).value = ''; });
    $('pin-error').textContent = '';
    if (on) $('pin-old').focus();
  }
  $('pin-open').addEventListener('click', () => showPinFields(true));
  $('pin-cancel').addEventListener('click', () => showPinFields(false));
  $('pin-save').addEventListener('click', () => {
    const oldPin = $('pin-old').value.trim(), n1 = $('pin-new').value.trim(), n2 = $('pin-new2').value.trim();
    const err = (t) => { $('pin-error').textContent = t; };
    if (!/^\d{4,8}$/.test(n1)) return err('Your new PIN must be 4 to 8 digits.');
    if (n1 !== n2) return err('The new PINs don\'t match. Type it the same way twice.');
    if (notifyBusy) return;
    notifyBusy = true;
    $('pin-save').disabled = true;
    err('');
    apiPost({ draft: 'rs', action: 'notifyPin', name: notifyName, oldPin, newPin: n1 })
      .then((r) => {
        if (!r || !r.ok) return err((r && r.error) || 'Something went wrong.');
        // Keep using the new PIN for this visit.
        notifyPin = n1;
        if (swapAuth && swapAuth.name === notifyName) swapAuth.pin = n1;
        showPinFields(false);
        toast(r.message || 'PIN changed.');
      })
      .catch(() => err("Couldn't reach the draft. Try again."))
      .finally(() => { notifyBusy = false; $('pin-save').disabled = false; });
  });
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
      notifySuggest = res.suggestEmail || '';
      setViewer(notifyName);
      rememberNotifyOn(notifyPrefs);
      showNotifyStep(true);
      if (state) render(null);
    });
  });
  function applyScreen() {
    store.set('guardians-screen-chosen', '1');
    if ($('notify-screen').checked) setMe(notifyName);
    else if (me === notifyName) setMe('');
  }
  $('notify-screen').addEventListener('change', applyScreen);
  $('notify-save').addEventListener('click', () => withNotifyBusy($('notify-save'), async () => {
    const f = notifyForm();
    if (f.emailOn && !f.email && !f.email2) { $('notify-error').textContent = 'Enter your email address, or untick the email box.'; return; }
    if (notifyDone(await notifyPost({ action: 'notifySave', prefs: f }))) { applyScreen(); toast('Saved. ' + summaryOf(notifyPrefs)); $('notify-dialog').close(); }
  }));
  $('notify-test').addEventListener('click', () => withNotifyBusy($('notify-test'), async () => {
    // Save first so the test uses what's on screen.
    if (!notifyDone(await notifyPost({ action: 'notifySave', prefs: notifyForm() }))) return;
    // Phones only show a banner when the draft isn't on screen, so give them time to leave the app.
    toast('Test coming in 5 seconds. Close the app or lock your phone now to see the banner.');
    const res = await notifyPost({ action: 'notifyTest', delay: 5 });
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
        if (notifyDone(res)) { store.set(PUSH_TOKEN_KEY, token); notifyPrefs.hasThisDevice = true; $('notify-push-on').checked = true; syncNextUp(); renderNotifyCheck(); toast('Push notifications are on for this device.'); }
      } else {
        const token = store.get(PUSH_TOKEN_KEY);
        const res = await notifyPost({ action: 'notifySave', prefs: notifyForm(), removeToken: token });
        if (notifyDone(res)) {
          store.set(PUSH_TOKEN_KEY, '');
          notifyPrefs.hasThisDevice = false;
          renderNotifyCheck();
          if (window.DraftPush) await window.DraftPush.disable();
          toast('Push notifications are off for this device.');
        }
      }
      renderPushStatus();
    });
  });
  function summaryOf(p) {
    const ways = [];
    if (me && me === notifyName) ways.push('on-screen alerts here');
    if (p.emailOn && p.email) ways.push('email');
    if (p.devices && p.pushOn !== false) ways.push('push on ' + p.devices + ' device' + (p.devices === 1 ? '' : 's'));
    const list = ways.length > 1 ? ways.slice(0, -1).join(', ') + ' and ' + ways[ways.length - 1] : ways[0];
    return ways.length ? "You'll get " + list + " when it's your turn" + (p.nextUp ? ' and when you\'re up next.' : '.') : "You won't get any alerts outside this page.";
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

  let wasMine = false;
  function renderMe(s, done) {
    const names = s.members.map((m) => m.name);
    if (me && !names.includes(me)) me = '';
    $('me-status').textContent = me ? 'On-screen alerts in this browser: ' + me : '';
    renderWho();

    const meMember = s.members.find((m) => m.name === me);
    const mine = !!me && !done && s.current && s.current.name === me && !(meMember && meMember.out);
    const nextUp = !mine && !!me && !done && (s.upcoming || []).find((u) => !u.out);
    const isNext = !!nextUp && nextUp.name === me;

    if (mine && !wasMine && mtab !== 'games') { mtab = 'games'; applyMtab(); } // your turn: show the games to pick from
    wasMine = mine;
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

  // On-screen alerts follow the member chosen in Notification settings (both drafts).
  /* "Who are you?": pick your name (and PIN) without setting up notifications. */
  function renderWho() {
    const v = viewer();
    // Phones show just the first name so it fits beside the notifications button.
    $('who-label').innerHTML = v ? 'You: <span class="wl-full">' + esc(v) + '</span><span class="wl-short">' + esc(v.split(' ')[0]) + '</span>' : 'Who are you?';
    $('who-btn').classList.toggle('is-set', !!v);
    $('legend-mine').hidden = !v;
  }
  async function openWho() {
    if (!notifyMembers()) await ensureRs();
    const members = notifyMembers() || [];
    const names = sortedNames(members);
    const v = viewer();
    $('who-name').innerHTML = '<option value="">Choose your name…</option>' + names.map((n) => '<option' + (n === v ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
    $('who-pin').value = '';
    $('who-error').textContent = '';
    $('who-forget').hidden = !v;
    syncWhoPin();
    $('who-dialog').showModal();
  }
  function syncWhoPin() {
    const m = (notifyMembers() || []).find((x) => x.name === $('who-name').value);
    $('who-pin-wrap').hidden = !!m && !m.needsPin;
  }
  $('who-btn').addEventListener('click', openWho);
  $('who-name').addEventListener('change', syncWhoPin);
  $('who-cancel').addEventListener('click', () => $('who-dialog').close());
  $('who-forget').addEventListener('click', () => {
    const v = viewer();
    store.set(VIEWER_KEY, '');
    store.set('guardians-swap-me', '');
    if (me && me === v) setMe('');
    whoPin = '';
    if (notifyName === v) { notifyName = ''; notifyPin = ''; notifyPrefs = null; }
    if (swapAuth && swapAuth.name === v) swapAuth = null;
    $('who-dialog').close();
    renderWho();
    if (state) render(null);
    toast('This browser no longer knows who you are.');
  });
  $('who-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('who-name').value;
    if (!name) { $('who-error').textContent = 'Choose your name.'; return; }
    const pin = $('who-pin').value.trim();
    $('who-go').disabled = true;
    $('who-error').textContent = '';
    apiPost({ draft: 'rs', action: 'notifyGet', name, pin, token: store.get(PUSH_TOKEN_KEY) || '' })
      .then((res) => {
        if (!res || !res.ok) { $('who-error').textContent = (res && res.error) || 'Something went wrong.'; return; }
        setViewer(name);
        store.set('guardians-swap-me', name);
        whoPin = pin;
        // Signed in for this visit: Notification & PIN settings and Ticket Swap won't ask again.
        notifyName = name; notifyPin = pin; notifyPrefs = res.prefs || {}; notifySuggest = res.suggestEmail || '';
        rememberNotifyOn(notifyPrefs);
        if (!swapAuth || swapAuth.name !== name) swapAuth = { name, pin, mine: [], email: !!(notifyPrefs.email || notifyPrefs.email2), push: (notifyPrefs.devices || 0) > 0 };
        $('who-dialog').close();
        renderWho();
        if (state) render(null);
        if (typeof renderSwap === 'function' && swapListings) { renderSwapBadge(); renderSwap(); }
        toast('Thanks, ' + name.split(' ')[0] + '. This browser will remember you.');
      })
      .catch(() => { $('who-error').textContent = "Couldn't reach the draft. Try again."; })
      .finally(() => { $('who-go').disabled = false; });
  });
  renderWho();

  function setMe(name) {
    me = name || '';
    ['rs', 'post'].forEach((k) => store.set(meKey(k), me));
    renderNotifyCheck();
    if (state && isDraftView(view)) render(null);
  }

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

  /* Phones and small tablets: the draft page is split into tabs (Games, Draft Order, Pick Log, Members).
     On bigger screens everything shows side by side and these tabs are hidden (see style.css). */
  let mtab = 'games';
  function applyMtab() {
    document.querySelectorAll('[data-mpanel]').forEach((el) => el.classList.toggle('m-hide', el.dataset.mpanel !== mtab));
    document.querySelectorAll('#mtabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.mt === mtab ? 'page' : 'false'));
  }
  $('mtabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mt]');
    if (!b || b.dataset.mt === mtab) return;
    mtab = b.dataset.mt;
    applyMtab();
    const top = $('mtabs').getBoundingClientRect().top + window.scrollY - 8;
    if (window.scrollY > top) window.scrollTo(0, top);
  });
  applyMtab();

  /* Footer: when the site was last published (GitHub Pages stamps each file when you push). */
  (function siteUpdated() {
    const el = $('site-updated');
    if (!el) return;
    const fmt = (d) => {
      try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d) + ' ET'; } catch (e) { return d.toLocaleString(); }
    };
    const show = (d) => { if (d && !isNaN(d)) el.textContent = 'Site updated ' + fmt(d) + '.'; };
    const fromRepo = () => fetch('https://api.github.com/repos/draegs34/Guardians/commits/main', { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && j.commit) show(new Date(j.commit.committer.date)); }).catch(() => {});
    // The page's Last-Modified time is when it was published. If the server didn't send one,
    // the browser reports "now", so fall back to the latest commit on GitHub.
    fetch('app.js?v=' + Date.now(), { method: 'HEAD', cache: 'no-store' })
      .then((r) => {
        const lm = r.headers.get('Last-Modified');
        const d = lm ? new Date(lm) : null;
        if (d && !isNaN(d) && Date.now() - d.getTime() > 5000) show(d); else return fromRepo();
      })
      .catch(fromRepo);
  })();

  /* Hooks for live.js (Firebase live updates) */
  window.DraftApp = {
    currentView: () => view,
    onLive(draft, s) {
      liveOn[draft] = true;
      if (draft === 'post' && s && !s.notSetUp) setShowPost(s.showTab);
      if (draft === 'rs' && s && !s.notSetUp && 'season' in s) setRsSeason(s.season);
      if (draft !== view) { if (s && !s.notSetUp) states[draft] = s; return; }
      if (s && s.notSetUp) { states[draft] = s; state = s; markSynced(); renderNotSetUp(); return; }
      staleViews.delete(draft);
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
  setInterval(() => { if (state && !busy && isDraftView(view) && !document.querySelector('dialog[open]')) render(null); }, 60000);

  $('post-tab').hidden = !showPost;
  $('test-banner').hidden = !TEST;
  if (!DEMO && view !== 'swap') setTimeout(loadSwap, 1500); // for the new-offer badge on the Ticket Swap tab
  renderNotifyCheck();
  setRsSeason(store.get(RS_SEASON_KEY) || '');
  if (view !== 'rs' && !DEMO) apiGet('rs').then((r) => { if (r && r.ok !== false && !r.notSetUp && 'season' in r) { states.rs = states.rs || r; setRsSeason(r.season); } }).catch(() => {});
  if (view !== 'post' && !DEMO) apiGet('post').then((p) => { if (p && p.ok !== false && !p.notSetUp) { states.post = states.post || p; setShowPost(p.showTab); } }).catch(() => {});
  if (history.replaceState && !sentPrices && !sentEmails) history.replaceState(null, '', '#' + VIEWS[view]);
  syncSwitch();
  if (view === 'setup') { $('title').textContent = 'Commissioner setup'; document.title = 'Setup'; if (window.DraftLive) window.DraftLive.watch(null); openSetupView(); }
  else if (view === 'swap') { $('title').textContent = 'Ticket Swap'; document.title = 'Ticket Swap'; if (window.DraftLive) window.DraftLive.watch(null); openSwap(); }
  else showDraft();
  refresh();
  // Keep checking in background tabs too (more slowly) so turn alerts still fire.
  let lastBg = 0;
  setInterval(() => {
    if (busy || !isDraftView(view)) return;
    if (liveOn[view] && Date.now() - lastPoll < 60000) return; // live updates are on; just a slow safety check
    if (!document.hidden) { refresh(); return; }
    if (me && Date.now() - lastBg >= 30000) { lastBg = Date.now(); refresh(); }
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && isDraftView(view)) refresh(); });
})();
