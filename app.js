(function () {
  'use strict';

  const API = (window.DRAFT_API_URL || '').trim();
  const DEMO = !API;
  const REFRESH_MS = Math.max(5, Number(window.DRAFT_REFRESH_SECONDS) || 10) * 1000;

  const $ = (id) => document.getElementById(id);
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let state = null;
  let lastPickCount = null;
  let pendingItem = null;
  let pendingName = null;
  let busy = false;

  // Which member this device belongs to, for turn alerts. Per-device, stored locally.
  const ME_KEY = 'guardians-draft-me';
  let me = '';
  try { me = localStorage.getItem(ME_KEY) || ''; } catch (e) { /* storage blocked: alerts just won't persist */ }


  /* ------------------------------------------------------------------ */
  /* Demo backend: an in-memory "sheet" run through the same DraftEngine  */
  /* the Apps Script uses (engine.js).                                    */
  /* ------------------------------------------------------------------ */
  const demo = (function () {
    const members = [
      { order: 1, name: 'Alex', pin: '1111' },
      { order: 2, name: 'Jordan', pin: '2222' },
      { order: 3, name: 'Casey', pin: '3333' },
      { order: 4, name: 'Morgan', pin: '4444' },
    ];
    const games = [
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
    const inventory = [];
    games.forEach((g) => ['7 & 8', '9 & 10'].forEach((seats) => {
      inventory.push({ id: g[0] + '-S' + seats.split(' ')[0], series: g[1], game: g[2], date: g[3], seats, price: g[4], notes: g[5] });
    }));
    const settings = { title: '2026 Guardians Postseason Draft', snake: true, maxPicks: 0, open: true, commissionerPin: '0000' };
    let rows = []; // like the Draft Picks tab, minus the header

    const data = () => ({
      settings, members, inventory,
      events: rows.map((r, i) => DraftEngine.rowToEvent(r, i + 2)),
    });
    function post(body) {
      const r = DraftEngine.apply(data(), body);
      if (r.ok && r.append) rows.push(r.append);
      if (r.ok && r.deleteRow) rows.splice(r.deleteRow - 2, 1);
      return Object.assign(DraftEngine.publicState(data()), { ok: r.ok, error: r.error, message: r.message });
    }
    return {
      get: () => Promise.resolve(DraftEngine.publicState(data())),
      post: (b) => new Promise((res) => setTimeout(() => res(post(b)), 250)),
    };
  })();

  /* ------------------------------------------------------------------ */
  /* Network                                                              */
  /* ------------------------------------------------------------------ */
  function apiGet() {
    if (DEMO) return demo.get();
    return fetch(API + (API.includes('?') ? '&' : '?') + 't=' + Date.now(), { method: 'GET' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function apiPost(body) {
    if (DEMO) return demo.post(body);
    // text/plain avoids a CORS preflight, which Apps Script doesn't answer.
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Apps Script sometimes saves a change but the reply never makes it back to
   * the browser (it's redirected through a second Google server). When a POST
   * fails, re-read the board and check whether the change actually landed
   * before telling anyone it failed.
   */
  async function postVerified(body, landed) {
    const before = state;
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
        try { s = await apiGet(); } catch (e) { continue; }
        if (!s || s.ok === false || !s.inventory) continue;
        apply(s);
        markSynced();
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

  /* Saved copy of the last board, shown instantly on the next visit while the
     live data loads. Picking stays locked until the live board arrives. */
  const CACHE_KEY = 'guardians-draft-board:' + API;
  let stale = false;
  function saveCache(s) {
    if (DEMO) return;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), s })); } catch (e) { /* full or blocked */ }
  }
  function loadCache() {
    if (DEMO) return null;
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (c && c.s && c.s.inventory && Date.now() - c.at < 7 * 24 * 3600 * 1000) return c;
    } catch (e) { /* ignore */ }
    return null;
  }

  function refresh() {
    return apiGet().then((s) => {
      if (!s || s.ok === false) throw new Error((s && s.error) || 'Bad response');
      stale = false;
      apply(s);
      saveCache(s);
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
  /* Rendering                                                            */
  /* ------------------------------------------------------------------ */
  // First-load messaging: Apps Script can take several seconds to wake up.
  let loaded = false;
  $('clock').classList.add('loading');
  const loadMsgs = [
    [4000, 'Waking up the Google Sheet — this can take a few seconds…'],
    [10000, 'Almost there…'],
    [20000, 'Still working. Check your connection if this keeps going.'],
  ];
  const loadTimers = loadMsgs.map(([ms, text]) => setTimeout(() => {
    if (!loaded && $('load-msg')) $('load-msg').textContent = text;
  }, ms));

  function apply(s) {
    if (!stale && s && s.inventory) saveCache(s);
    if (!loaded) {
      loaded = true;
      loadTimers.forEach(clearTimeout);
      $('clock').classList.remove('loading');
      $('board').removeAttribute('aria-busy');
    }
    const prevIds = state ? new Set(state.picks.map((p) => p.itemId)) : null;
    state = s;
    render(prevIds);
    if (lastPickCount !== null && s.picks.length > lastPickCount && !busy) {
      const p = s.picks[s.picks.length - 1];
      const item = s.inventory.find((i) => i.id === p.itemId);
      if (p.type === 'drop') toast(p.member + ' dropped out of the draft');
      else if (p.type === 'skip') toast(p.member + "'s turn was skipped");
      else if (item) toast(p.member + (p.assigned ? ' was assigned ' : ' took ') + item.series.replace(/^AL /, '') + ' ' + item.game + ' · ' + item.seats);
    }
    lastPickCount = s.picks.length;
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

  function render(prevIds) {
    const s = state;
    if (!titleTimer) document.title = s.title || 'Postseason Draft';
    $('title').textContent = s.title || 'Postseason Draft';
    $('demo-banner').hidden = !DEMO;

    const takenBy = {};
    s.picks.forEach((p) => { if (p.itemId) takenBy[p.itemId] = p; });
    const itemPicks = s.picks.filter((p) => p.itemId);
    const left = s.inventory.length - itemPicks.length;
    const done = !s.current;

    // On the clock
    const clock = $('clock');
    clock.classList.toggle('done', done);
    clock.classList.toggle('paused', !done && !s.open);
    if (done) {
      $('clock-name').textContent = 'Draft complete';
      $('clock-meta').textContent = itemPicks.length + ' seat pairs claimed' + (left > 0 ? ', ' + left + ' unclaimed' : '') + '.';
      clock.querySelector('.clock-label').textContent = 'Final';
    } else {
      clock.querySelector('.clock-label').textContent = s.open ? 'On the clock' : 'Draft paused';
      // Slow-pick indicator: over an hour since the last pick/turn change.
      const since = turnStartedAt(s);
      const waited = since ? Date.now() - since : 0;
      const slow = waited >= 60 * 60 * 1000;
      $('clock-name').innerHTML = esc(s.current.name) + (slow
        ? ' <span class="slow-clock" title="On the clock for ' + esc(fmtWait(waited)) + '" role="img" aria-label="On the clock for ' + esc(fmtWait(waited)) + '">' + CLOCK_SVG + '<span>' + esc(fmtWait(waited)) + '</span></span>'
        : '');
      $('clock-meta').textContent = 'Round ' + s.current.round + ' · Pick ' + s.current.pick + ' · ' + left + ' left' + (s.snake ? ' · Snake order' : '');
    }

    // Board
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

    const canPick = !done && s.open && !stale;
    document.body.classList.toggle('stale', stale);
    if (stale) $('clock-meta').textContent += ' · Updating…';
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
            const p = takenBy[it.id];
            const fresh = prevIds && p && !prevIds.has(it.id) ? ' just' : '';
            if (p) {
              return '<div class="seat taken' + fresh + '" title="' + (p.assigned ? 'Assigned by commissioner' : 'Pick #' + p.number) + '"><span class="s-label">Seats ' + esc(sc) + '</span><span class="s-val">' + esc(p.member) + '</span></div>';
            }
            if (!canPick) {
              return '<div class="seat"><span class="s-label">Seats ' + esc(sc) + '</span><span class="s-val">Available</span></div>';
            }
            return '<button type="button" class="seat open" data-id="' + esc(it.id) + '" aria-label="Pick ' + esc(sr.name + ' ' + g.game + ' seats ' + sc) + '"><span class="s-label">Seats ' + esc(sc) + '</span><span class="s-val">Pick</span></button>';
          }).join('');
          return '<div class="game" style="--cols:' + seatCols.length + '">' + info + cells + '</div>';
        }).join('') + '</div>';
    }).join('');

    // Up next
    const up = done ? [] : [s.current].concat(s.upcoming || []);
    $('upcoming').innerHTML = up.length
      ? up.map((t) => t.out
          ? '<li class="out"><s>' + esc(t.name) + '</s><span class="meta">Out</span></li>'
          : '<li' + (me && t.name === me ? ' class="me"' : '') + '><span>' + esc(t.name) + '</span><span class="meta">Rd ' + t.round + ' · #' + t.pick + '</span></li>').join('')
      : '<li class="empty">Nothing left to pick.</li>';

    // Totals
    const tot = {};
    const outNames = {};
    s.members.forEach((m) => { tot[m.name] = { n: 0, owed: 0 }; if (m.out) outNames[m.name] = true; });
    itemPicks.forEach((p) => {
      const it = s.inventory.find((i) => i.id === p.itemId);
      if (!tot[p.member]) tot[p.member] = { n: 0, owed: 0 };
      tot[p.member].n++;
      tot[p.member].owed += it ? it.price : 0;
    });
    $('totals').innerHTML = Object.keys(tot).map((name) =>
      '<tr' + (outNames[name] ? ' class="out"' : '') + '><td>' + (outNames[name] ? '<s>' + esc(name) + '</s> <span class="meta">out</span>' : esc(name)) + '</td><td class="num">' + tot[name].n + '</td><td class="num">' + money(tot[name].owed) + '</td></tr>'
    ).join('');

    // Log
    $('log').innerHTML = s.picks.length
      ? s.picks.slice().reverse().map((p) => {
          const it = s.inventory.find((i) => i.id === p.itemId);
          const num = p.number ? '#' + p.number + ' ' : '';
          const when = etTime(p.time);
          const stamp = when ? '<time class="log-time" datetime="' + esc(p.time) + '">' + esc(when) + '</time>' : '';
          let body;
          if (p.type === 'skip') body = '<b>' + num + esc(p.member) + '</b> — <span class="meta">turn skipped</span>';
          else if (p.type === 'drop') body = '<b>' + num + esc(p.member) + '</b> — <span class="meta">dropped out of the draft</span>';
          else {
            const what = it ? it.series.replace(/^AL /, '') + ' ' + it.game + ' · Seats ' + it.seats : p.itemId;
            body = '<b>' + (p.assigned ? '' : num) + esc(p.member) + '</b> — ' + esc(what) + (p.assigned ? ' <span class="meta">(assigned)</span>' : '');
          }
          return '<li>' + body + stamp + '</li>';
        }).join('')
      : '<li class="empty">No picks yet.</li>';

    renderMe(s, done);
    $('skip-who').textContent = s.current ? s.current.name : 'nobody';
    $('skip-btn').disabled = !s.current;
  }

  /* ------------------------------------------------------------------ */
  /* Pick flow                                                            */
  /* ------------------------------------------------------------------ */
  $('board').addEventListener('click', (e) => {
    const btn = e.target.closest('.seat.open');
    if (!btn || !state) return;
    const item = state.inventory.find((i) => i.id === btn.dataset.id);
    if (!item) return;
    pendingItem = item;
    $('pick-item').innerHTML = '<div class="pi-title">' + esc(item.series) + ' — ' + esc(item.game) + '</div>' +
      '<div class="pi-sub">Seats ' + esc(item.seats) + ' · ' + (item.date && item.date !== 'TBD' ? esc(item.date) + ' · ' : '') + money(item.price) + '</div>';
    pendingName = state.current ? state.current.name : null;
    $('pick-for').textContent = pendingName || '';
    $('pick-submit').textContent = 'Lock it in for ' + (pendingName || '');
    $('pick-error').textContent = '';
    const mem = state.members.find((m) => m.name === pendingName);
    const needsPin = !mem || mem.needsPin !== false; // older script versions don't send needsPin
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
        lastPickCount = state ? state.picks.length : lastPickCount;
        $('pick-submit').disabled = false;
        $('pick-submit').textContent = 'Lock it in for ' + (pendingName || '');
      });
  });

  /* Commissioner */
  function fillAssignLists() {
    if (!state) return;
    const taken = new Set(state.picks.filter((p) => p.itemId).map((p) => p.itemId));
    $('assign-member').innerHTML = '<option value="">Choose member…</option>' +
      state.members.map((m) => '<option>' + esc(m.name) + '</option>').join('');
    const open = state.inventory.filter((i) => !taken.has(i.id));
    $('assign-item').innerHTML = '<option value="">' + (open.length ? 'Choose game & seats…' : 'Nothing left to assign') + '</option>' +
      open.map((i) => '<option value="' + esc(i.id) + '">' + esc(i.series.replace(/^AL /, '') + ' — ' + i.game + ' · Seats ' + i.seats + ' · ' + money(i.price)) + '</option>').join('');
  }

  $('commish-btn').addEventListener('click', () => {
    $('commish-pin').value = '';
    $('commish-error').textContent = '';
    fillAssignLists();
    $('commish-dialog').showModal();
    setTimeout(() => $('commish-pin').focus(), 50);
  });
  $('commish-cancel').addEventListener('click', () => $('commish-dialog').close());
  $('commish-form').addEventListener('submit', (e) => e.preventDefault());

  function commishAction(body, btn) {
    if (busy) return;
    if (!$('commish-pin').value.trim()) { $('commish-error').textContent = 'Enter your commissioner PIN.'; return; }
    busy = true;
    btn.disabled = true;
    $('commish-error').textContent = '';
    body.pin = $('commish-pin').value;
    postVerified(body, changed)
      .then((res) => {
        if (res && res.inventory) apply(res);
        if (res && res.ok) { $('commish-dialog').close(); toast(res.message || 'Saved.'); }
        else { $('commish-error').textContent = (res && res.error) || 'Something went wrong.'; fillAssignLists(); }
      })
      .catch(() => { $('commish-error').textContent = "Couldn't reach the draft."; })
      .finally(() => { busy = false; btn.disabled = false; lastPickCount = state ? state.picks.length : lastPickCount; });
  }

  $('assign-btn').addEventListener('click', () => {
    const name = $('assign-member').value;
    const itemId = $('assign-item').value;
    if (!name || !itemId) { $('commish-error').textContent = 'Choose a member and a game/seat pair.'; return; }
    commishAction({ action: 'assign', name, itemId }, $('assign-btn'));
  });
  $('undo-btn').addEventListener('click', () => commishAction({ action: 'undo' }, $('undo-btn')));
  $('skip-btn').addEventListener('click', () => {
    if (!state || !state.current) return;
    commishAction({ action: 'skip', name: state.current.name }, $('skip-btn'));
  });

  /* Drop out */
  $('drop-btn').addEventListener('click', () => {
    if (!state) return;
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
      .finally(() => { busy = false; $('drop-submit').disabled = false; lastPickCount = state ? state.picks.length : lastPickCount; });
  });

  /* ------------------------------------------------------------------ */
  /* Turn alerts (visual only — no sounds)                                */
  /* ------------------------------------------------------------------ */
  let titleTimer = null;
  let baseTitle = 'Postseason Draft';

  function renderMe(s, done) {
    // Keep the "this is me" list in sync with the member list.
    const sel = $('me-select');
    const names = s.members.map((m) => m.name);
    const sig = names.join('|');
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
    if (mine) {
      $('turn-alert-text').textContent = s.open
        ? "You're on the clock, " + me + '! Tap an open seat pair below to make your pick.'
        : "You're on the clock, " + me + ', but the draft is paused right now.';
      bar.hidden = false;
    } else if (isNext) {
      $('turn-alert-text').textContent = "Heads up, " + me + " — you're up next.";
      bar.hidden = false;
    } else {
      bar.hidden = true;
    }

    baseTitle = s.title || 'Postseason Draft';
    setTitleFlash(mine);
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
    try { if (me) localStorage.setItem(ME_KEY, me); else localStorage.removeItem(ME_KEY); } catch (err) { /* ignore */ }
    if (state) render(null);
  });

  /* When did the current member go on the clock? = time of the last entry that
     moved the draft along (a pick, a skip, or a drop-out that used a turn). */
  function turnStartedAt(s) {
    for (let i = s.picks.length - 1; i >= 0; i--) {
      const p = s.picks[i];
      if (p.type === 'pick' || p.type === 'skip' || (p.type === 'drop' && p.number)) {
        const t = new Date(p.time).getTime();
        return isNaN(t) ? null : t;
      }
    }
    return null; // no picks yet — nothing to measure from
  }
  function fmtWait(ms) {
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
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
    try { localStorage.setItem('guardians-draft-theme', dark ? 'dark' : 'light'); } catch (e) { /* ignore */ }
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

  // Start
  // Keep the slow-pick timer current even when nothing else changes.
  setInterval(() => { if (state && !busy && !document.querySelector('dialog[open]')) render(null); }, 60000);

  const cached = loadCache();
  if (cached) {
    stale = true;
    apply(cached.s);
    $('sync').innerHTML = '<span class="mini-spin" aria-hidden="true"></span>Updating…';
  }
  refresh();
  // Keep checking in background tabs too (more slowly) so turn alerts still fire.
  let lastBg = 0;
  setInterval(() => {
    if (busy) return;
    if (!document.hidden) { refresh(); return; }
    if (me && Date.now() - lastBg >= 30000) { lastBg = Date.now(); refresh(); }
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
