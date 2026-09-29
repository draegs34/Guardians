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


  /* ------------------------------------------------------------------ */
  /* Draft order — keep in sync with computeTurn() in apps-script/Code.gs */
  /* ------------------------------------------------------------------ */
  function computeTurn(members, picks, maxPicks, snake, upcomingCount) {
    upcomingCount = upcomingCount || members.length;
    const n = members.length;
    const out = { current: null, upcoming: [] };
    if (!n) return out;
    const sim = {};
    members.forEach((m) => { sim[m.name] = 0; });
    let made = 0;
    const limit = maxPicks > 0 ? maxPicks : Infinity;
    const maxSlots = (picks.length + upcomingCount + 1) * n + n * 2;
    for (let slot = 0; slot < maxSlots; slot++) {
      const round = Math.floor(slot / n) + 1;
      let idx = slot % n;
      if (snake && round % 2 === 0) idx = n - 1 - idx;
      const m = members[idx];
      if (sim[m.name] >= limit) {
        if (members.every((x) => sim[x.name] >= limit)) break;
        continue;
      }
      if (made < picks.length) { sim[m.name]++; made++; continue; }
      const turn = { name: m.name, round, pick: made + 1 + out.upcoming.length + (out.current ? 1 : 0) };
      if (!out.current) out.current = turn; else out.upcoming.push(turn);
      sim[m.name]++;
      if (out.upcoming.length >= upcomingCount) break;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Demo backend (in-memory, this tab only)                             */
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
    const picks = [];

    function pub() {
      const done = picks.length >= inventory.length;
      const t = done ? { current: null, upcoming: [] } : computeTurn(members, picks.filter((p) => !p.assigned), settings.maxPicks, settings.snake, members.length);
      t.upcoming = t.upcoming.slice(0, Math.max(0, inventory.length - picks.length - 1));
      return {
        ok: true, title: settings.title, snake: settings.snake, maxPicks: settings.maxPicks, open: settings.open,
        members: members.map((m) => ({ order: m.order, name: m.name, needsPin: !!m.pin })),
        inventory, picks: picks.slice(), current: t.current, upcoming: t.upcoming, serverTime: new Date().toISOString(),
      };
    }
    function post(body) {
      const r = (function () {
        const isC = String(body.pin || '').trim() === settings.commissionerPin;
        if (body.action === 'undo') {
          if (!isC) return { ok: false, error: 'Only the commissioner can undo picks.' };
          if (!picks.length) return { ok: false, error: 'There are no picks to undo.' };
          const p = picks.pop();
          return { ok: true, message: p.assigned ? 'Removed the assignment to ' + p.member + '.' : 'Undid pick #' + p.number + ' (' + p.member + ').' };
        }
        if (body.action === 'assign') {
          if (!isC) return { ok: false, error: "That commissioner PIN doesn't match." };
          const m = members.find((x) => x.name === body.name);
          if (!m) return { ok: false, error: 'Choose a member.' };
          const it = inventory.find((i) => i.id === body.itemId);
          if (!it) return { ok: false, error: 'Choose a game and seats.' };
          if (picks.some((p) => p.itemId === it.id)) return { ok: false, error: 'That one is already taken.' };
          picks.push({ number: null, assigned: true, round: null, member: m.name, itemId: it.id, time: new Date().toISOString() });
          return { ok: true, message: 'Assigned ' + it.series + ' ' + it.game + ', seats ' + it.seats + ' to ' + m.name + '.' };
        }
        if (!settings.open) return { ok: false, error: 'The draft is paused right now.' };
        const t = computeTurn(members, picks.filter((p) => !p.assigned), settings.maxPicks, settings.snake, 1);
        if (!t.current || picks.length >= inventory.length) return { ok: false, error: 'The draft is complete.' };
        const onClock = t.current.name;
        if (body.name !== onClock) return { ok: false, error: 'The board changed — ' + onClock + ' is on the clock now. Take another look and try again.' };
        const mem = members.find((x) => x.name === onClock);
        const pin = String(body.pin || '').trim();
        if (mem && mem.pin && pin !== mem.pin && !isC) return { ok: false, error: pin ? "That PIN doesn't match." : 'Enter your PIN.' };
        const item = inventory.find((i) => i.id === body.itemId);
        if (!item) return { ok: false, error: "That game/seat option wasn't found." };
        if (picks.some((p) => p.itemId === item.id)) return { ok: false, error: 'Sorry — that one was just taken.' };
        picks.push({ number: picks.filter((p) => !p.assigned).length + 1, round: t.current.round, member: onClock, itemId: item.id, time: new Date().toISOString() });
        return { ok: true, message: onClock + ' took ' + item.series + ' ' + item.game + ', seats ' + item.seats + '.' };
      })();
      return Object.assign(pub(), r);
    }
    return { get: () => Promise.resolve(pub()), post: (b) => new Promise((res) => setTimeout(() => res(post(b)), 250)) };
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

  function refresh() {
    return apiGet().then((s) => {
      if (!s || s.ok === false) throw new Error((s && s.error) || 'Bad response');
      apply(s);
      $('sync').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      $('sync').classList.remove('err');
    }).catch((err) => {
      console.error(err);
      $('sync').textContent = "Can't reach the draft — retrying…";
      $('sync').classList.add('err');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                            */
  /* ------------------------------------------------------------------ */
  function apply(s) {
    const prevIds = state ? new Set(state.picks.map((p) => p.itemId)) : null;
    state = s;
    render(prevIds);
    if (lastPickCount !== null && s.picks.length > lastPickCount && !busy) {
      const p = s.picks[s.picks.length - 1];
      const item = s.inventory.find((i) => i.id === p.itemId);
      if (item) toast(p.member + ' took ' + item.series.replace(/^AL /, '') + ' ' + item.game + ' · ' + item.seats);
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
    document.title = s.title || 'Postseason Draft';
    $('title').textContent = s.title || 'Postseason Draft';
    $('demo-banner').hidden = !DEMO;

    const takenBy = {};
    s.picks.forEach((p) => { takenBy[p.itemId] = p; });
    const done = s.picks.length >= s.inventory.length || !s.current;

    // On the clock
    const clock = $('clock');
    clock.classList.toggle('done', done);
    clock.classList.toggle('paused', !done && !s.open);
    if (done) {
      $('clock-name').textContent = 'Draft complete';
      $('clock-meta').textContent = s.picks.length + ' picks made. See you at the ballpark.';
      clock.querySelector('.clock-label').textContent = 'Final';
    } else {
      clock.querySelector('.clock-label').textContent = s.open ? 'On the clock' : 'Draft paused';
      $('clock-name').textContent = s.current.name;
      const left = s.inventory.length - s.picks.length;
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

    const canPick = !done && s.open;
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
      ? up.map((t) => '<li><span>' + esc(t.name) + '</span><span class="meta">Rd ' + t.round + ' · #' + t.pick + '</span></li>').join('')
      : '<li class="empty">Nothing left to pick.</li>';

    // Totals
    const tot = {};
    s.members.forEach((m) => { tot[m.name] = { n: 0, owed: 0 }; });
    s.picks.forEach((p) => {
      const it = s.inventory.find((i) => i.id === p.itemId);
      if (!tot[p.member]) tot[p.member] = { n: 0, owed: 0 };
      tot[p.member].n++;
      tot[p.member].owed += it ? it.price : 0;
    });
    $('totals').innerHTML = Object.keys(tot).map((name) =>
      '<tr><td>' + esc(name) + '</td><td class="num">' + tot[name].n + '</td><td class="num">' + money(tot[name].owed) + '</td></tr>'
    ).join('');

    // Log
    $('log').innerHTML = s.picks.length
      ? s.picks.slice().reverse().map((p) => {
          const it = s.inventory.find((i) => i.id === p.itemId);
          const what = it ? it.series.replace(/^AL /, '') + ' ' + it.game + ' · Seats ' + it.seats : p.itemId;
          return '<li><b>' + (p.assigned ? '' : '#' + p.number + ' ') + esc(p.member) + '</b> — ' + esc(what) + (p.assigned ? ' <span class="meta">(assigned)</span>' : '') + '</li>';
        }).join('')
      : '<li class="empty">No picks yet.</li>';
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
    apiPost({ action: 'pick', name: pendingName, pin: $('pick-pin').value, itemId: pendingItem.id })
      .then((res) => {
        if (res && res.inventory) apply(res);
        if (res && res.ok) {
          $('pick-dialog').close();
          toast(res.message || 'Pick saved.');
          render(null);
        } else {
          $('pick-error').textContent = (res && res.error) || 'Something went wrong.';
        }
      })
      .catch(() => { $('pick-error').textContent = "Couldn't reach the draft. Check your connection and try again."; })
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
    const taken = new Set(state.picks.map((p) => p.itemId));
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
    apiPost(body)
      .then((res) => {
        if (res && res.inventory) apply(res);
        if (res && res.ok) { $('commish-dialog').close(); toast(res.message || 'Done.'); }
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

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // Start
  refresh();
  setInterval(() => { if (!document.hidden && !busy) refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
