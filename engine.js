/* ==========================================================================
 * DRAFT ENGINE — the draft rules, shared by the web page (demo mode) and the
 * Google Apps Script backend. apps-script/Code.gs contains an exact copy of
 * this block; if you change one, copy it into the other.
 *
 * Used by both drafts (postseason and regular season).
 *
 * The picks tab is an event log. Each row is one of:
 *   pick    — a normal draft pick (Round = number, Item ID = inventory ID)
 *   assign  — commissioner assignment (Round = "Assigned"); uses no turn
 *   skip    — on-clock member skipped (Item ID = "SKIPPED"), by the
 *             commissioner or automatically when the pick time limit runs out
 *   drop    — member dropped out (Item ID = "DROPPED OUT"); uses their turn
 *             only if they were on the clock at the time
 *
 * data = {
 *   settings:  { title, snake, maxPicks, open, commissionerPin, timeLimitOn, timeLimitHours, kind },
 *   members:   [{ name, pin, cap? }]   — people (cap = most picks they can get, 0/blank = no cap)
 *   order?:    ['Name', 'Name', ...]   — draft slots for one round; a name can appear more than once.
 *                                        Without it, members is the order (one slot each).
 *   inventory: [{ id, ... }],
 *   events:    [...rowToEvent()]
 * }
 * ========================================================================== */
var DraftEngine = (function () {
  var SKIP = 'SKIPPED';
  var DROP = 'DROPPED OUT';

  /** Turn a picks-tab row ([Pick #, Round, Member, Item ID, Series, Game, ..., Timestamp]) into an event. */
  function rowToEvent(v, rowNum) {
    var round = String(v[1] == null ? '' : v[1]).trim();
    var item = String(v[3] == null ? '' : v[3]).trim();
    var up = item.toUpperCase();
    var type = round.toLowerCase() === 'assigned' ? 'assign' : up === SKIP ? 'skip' : up === DROP ? 'drop' : 'pick';
    var t = v[9];
    return {
      row: rowNum,
      type: type,
      number: Number(v[0]) || null,
      round: Number(round) || null,
      member: String(v[2] == null ? '' : v[2]).trim(),
      itemId: type === 'pick' || type === 'assign' ? item : '',
      note: type === 'skip' || type === 'drop' ? String(v[5] == null ? '' : v[5]) : '',
      time: t && typeof t.toISOString === 'function' ? t.toISOString() : String(t || ''),
    };
  }

  function droppedSet(events) {
    var d = {};
    events.forEach(function (e) { if (e.type === 'drop') d[e.member] = true; });
    return d;
  }

  function slotsOf(data) {
    if (data.order && data.order.length) return data.order.map(function (n) { return { name: n }; });
    return data.members;
  }
  function capsOf(data) {
    var c = {};
    data.members.forEach(function (m) { if (Number(m.cap) > 0) c[m.name] = Number(m.cap); });
    return c;
  }

  /**
   * Replays the event log against the draft order (snake or straight) to work
   * out who is on the clock and who comes next. Members who dropped out, or who
   * hit their pick limit, are passed over. Dropped members still appear in the
   * upcoming list (flagged out: true).
   *
   * maxPicks: limit for everyone (0 = none). caps: { name: limit } per member;
   * per-member caps also count commissioner assignments.
   */
  function computeTurn(slots, events, maxPicks, snake, upcomingCount, caps) {
    var n = slots.length;
    var res = { current: null, upcoming: [] };
    if (!n) return res;
    caps = caps || {};
    upcomingCount = upcomingCount || n;
    var globalLimit = maxPicks > 0 ? maxPicks : Infinity;
    var dropped = {};
    var cnt = {};      // draft picks per member
    var assigned = {}; // commissioner assignments per member
    slots.forEach(function (m) { cnt[m.name] = 0; assigned[m.name] = 0; });
    events.forEach(function (e) { if (e.type === 'assign') assigned[e.member] = (assigned[e.member] || 0) + 1; });

    function at(s) {
      var round = Math.floor(s / n) + 1;
      var idx = s % n;
      if (snake && round % 2 === 0) idx = n - 1 - idx;
      return { name: slots[idx].name, round: round };
    }
    function eligible(name, c) {
      if (dropped[name]) return false;
      var made = c[name] || 0;
      if (made >= globalLimit) return false;
      if (caps[name] && made + (assigned[name] || 0) >= caps[name]) return false;
      return true;
    }
    function next(from, c) {
      if (!slots.some(function (m) { return eligible(m.name, c); })) return -1;
      for (var s = from; ; s++) if (eligible(at(s).name, c)) return s;
    }

    var slot = 0;
    var turns = 0;
    events.forEach(function (ev) {
      if (ev.type === 'assign') return;
      var cur = next(slot, cnt);
      if (ev.type === 'drop') {
        if (cur >= 0 && at(cur).name === ev.member) { slot = cur + 1; turns++; }
        dropped[ev.member] = true;
        return;
      }
      if (cur < 0) return;
      slot = cur + 1;
      turns++;
      if (ev.type === 'pick') cnt[at(cur).name]++;
    });

    var cur = next(slot, cnt);
    if (cur < 0) return res;
    var t = at(cur);
    res.current = { name: t.name, round: t.round, pick: turns + 1 };

    var sim = {};
    Object.keys(cnt).forEach(function (k) { sim[k] = cnt[k]; });
    sim[t.name]++;
    var pickNo = turns + 1;
    var shown = 0;
    for (var s = cur + 1; s < cur + 1 + n * (upcomingCount + 2) && shown < upcomingCount; s++) {
      var u = at(s);
      if (dropped[u.name]) { res.upcoming.push({ name: u.name, round: u.round, out: true }); continue; }
      if (!eligible(u.name, sim)) continue;
      sim[u.name]++;
      pickNo++;
      shown++;
      res.upcoming.push({ name: u.name, round: u.round, pick: pickNo });
    }
    return res;
  }

  function takenMap(events) {
    var taken = {};
    events.forEach(function (e) { if (e.itemId) taken[e.itemId] = e; });
    return taken;
  }
  function leftCount(data, events) {
    var taken = takenMap(events);
    return data.inventory.filter(function (i) { return !taken[i.id]; }).length;
  }

  /** When the current turn started: the last entry that moved the draft along. */
  function turnStart(events) {
    for (var i = events.length - 1; i >= 0; i--) {
      var e = events[i];
      if (e.type === 'pick' || e.type === 'skip' || (e.type === 'drop' && e.number)) {
        var t = new Date(e.time).getTime();
        return isNaN(t) ? null : t;
      }
    }
    return null; // no picks yet: the clock starts with the first pick
  }
  function limitMs(s) {
    return s.timeLimitOn && Number(s.timeLimitHours) > 0 ? Number(s.timeLimitHours) * 3600000 : 0;
  }

  /**
   * Pick time limit: rows to append for members whose time ran out (can be
   * several if a few deadlines passed in a row). Empty when the limit is off,
   * the draft is paused, or no picks have been made yet.
   */
  function autoSkips(data, nowMs) {
    var s = data.settings;
    var ms = limitMs(s);
    var rows = [];
    if (!ms || !s.open) return rows;
    var events = data.events.slice();
    for (var guard = 0; guard < 200; guard++) {
      if (leftCount(data, events) <= 0) break;
      var t = computeTurn(slotsOf(data), events, s.maxPicks, s.snake, 1, capsOf(data)).current;
      if (!t) break;
      var start = turnStart(events);
      if (start == null || nowMs < start + ms) break;
      var row = noteRow(t.pick, t.round, t.name, SKIP, 'Auto-skipped (time limit)');
      row[9] = new Date(start + ms);
      rows.push(row);
      events.push(rowToEvent(row, -1));
    }
    return rows;
  }

  function labelOf(item) {
    return item.label || (item.series + ' ' + item.game + ', seats ' + item.seats);
  }

  function publicState(data) {
    var s = data.settings;
    var slots = slotsOf(data);
    var caps = capsOf(data);
    var left = leftCount(data, data.events);
    var dropped = droppedSet(data.events);
    var turn = left > 0
      ? computeTurn(slots, data.events, s.maxPicks, s.snake, slots.length, caps)
      : { current: null, upcoming: [] };

    // Don't promise more upcoming turns than there are items left.
    var upcoming = [];
    var elig = 0;
    for (var i = 0; i < turn.upcoming.length; i++) {
      var u = turn.upcoming[i];
      if (!u.out) { if (elig >= left - 1) break; elig++; }
      var prev = upcoming[upcoming.length - 1];
      if (u.out && prev && prev.out && prev.name === u.name) continue; // snake turn: show once
      upcoming.push(u);
    }
    while (upcoming.length && upcoming[upcoming.length - 1].out) upcoming.pop();

    var ms = limitMs(s);
    var start = turnStart(data.events);
    var deadline = ms && s.open && turn.current && start != null ? new Date(start + ms).toISOString() : null;

    return {
      ok: true,
      kind: s.kind || 'post',
      title: s.title,
      snake: s.snake,
      maxPicks: s.maxPicks,
      open: s.open,
      timeLimit: { on: !!ms, hours: ms ? Number(s.timeLimitHours) : null },
      deadline: deadline,
      members: data.members.map(function (m) {
        // PINs never leave the backend
        return { order: m.order, name: m.name, needsPin: !!m.pin, out: !!dropped[m.name], cap: Number(m.cap) > 0 ? Number(m.cap) : null };
      }),
      order: slots.map(function (m) { return m.name; }),
      caps: caps,
      inventory: data.inventory,
      picks: data.events.map(function (e) {
        return { number: e.number, type: e.type, assigned: e.type === 'assign', round: e.round, member: e.member, itemId: e.itemId, note: e.note, time: e.time };
      }),
      left: left,
      current: turn.current,
      upcoming: upcoming,
      serverTime: new Date().toISOString(),
    };
  }

  function findMember(data, name) {
    return data.members.filter(function (m) { return m.name === name; })[0];
  }
  function findItem(data, id) {
    return data.inventory.filter(function (i) { return i.id === id; })[0];
  }
  function itemRow(pickNo, round, member, item) {
    return [pickNo, round, member, item.id, item.series, item.game, item.date, item.seats, item.price === '' || item.price == null ? '' : item.price, new Date()];
  }
  function noteRow(pickNo, round, member, code, note) {
    return [pickNo, round, member, code, '', note, '', '', '', new Date()];
  }

  /**
   * Validates an action and returns what to write:
   *   { ok, error?, message?, append?: rowArray, deleteRow?: rowNumber }
   */
  function apply(data, body) {
    var s = data.settings;
    var pin = String(body.pin || '').trim();
    var isCommish = !!s.commissionerPin && pin === s.commissionerPin;
    var taken = takenMap(data.events);
    var left = leftCount(data, data.events);
    var turn = left > 0 ? computeTurn(slotsOf(data), data.events, s.maxPicks, s.snake, 1, capsOf(data)) : { current: null };
    var cur = turn.current;
    var dropped = droppedSet(data.events);

    switch (body.action) {
      case 'pick': {
        if (!s.open) return { ok: false, error: 'The draft is paused right now.' };
        if (!cur) return { ok: false, error: 'The draft is complete.' };
        if (body.name !== cur.name) {
          return { ok: false, error: 'The board changed — ' + cur.name + ' is on the clock now. Take another look and try again.' };
        }
        var m = findMember(data, cur.name);
        if (!m && !isCommish) return { ok: false, error: cur.name + ' isn\'t on the member list. Ask the commissioner to make this pick.' };
        if (m && m.pin && pin !== m.pin && !isCommish) return { ok: false, error: pin ? 'That PIN doesn\'t match.' : 'Enter your PIN.' };
        var item = findItem(data, body.itemId);
        if (!item) return { ok: false, error: 'That game wasn\'t found.' };
        if (taken[item.id]) return { ok: false, error: 'Sorry — that one was just taken.' };
        return {
          ok: true,
          message: cur.name + ' took ' + labelOf(item) + '.',
          append: itemRow(cur.pick, cur.round, cur.name, item),
        };
      }

      case 'assign': {
        if (!isCommish) return { ok: false, error: 'That commissioner PIN doesn\'t match.' };
        var am = findMember(data, body.name);
        if (!am) return { ok: false, error: 'Choose a member.' };
        var ai = findItem(data, body.itemId);
        if (!ai) return { ok: false, error: 'Choose a game.' };
        if (taken[ai.id]) return { ok: false, error: 'That one is already taken.' };
        return {
          ok: true,
          message: 'Assigned ' + labelOf(ai) + ' to ' + am.name + '.',
          append: itemRow('', 'Assigned', am.name, ai),
        };
      }

      case 'skip': {
        if (!isCommish) return { ok: false, error: 'That commissioner PIN doesn\'t match.' };
        if (!cur) return { ok: false, error: 'Nobody is on the clock.' };
        if (body.name && body.name !== cur.name) {
          return { ok: false, error: 'The board changed — ' + cur.name + ' is on the clock now.' };
        }
        return {
          ok: true,
          message: 'Skipped ' + cur.name + '\'s turn.',
          append: noteRow(cur.pick, cur.round, cur.name, SKIP, 'Turn skipped by commissioner'),
        };
      }

      case 'drop': {
        var dm = findMember(data, body.name);
        if (!dm) return { ok: false, error: 'Choose your name.' };
        if (dropped[dm.name]) return { ok: false, error: dm.name + ' has already dropped out.' };
        if (dm.pin && pin !== dm.pin && !isCommish) return { ok: false, error: pin ? 'That PIN doesn\'t match.' : 'Enter your PIN.' };
        var onClock = cur && cur.name === dm.name;
        return {
          ok: true,
          message: dm.name + ' dropped out of the draft.',
          append: noteRow(onClock ? cur.pick : '', onClock ? cur.round : '', dm.name, DROP, 'Dropped out of the draft'),
        };
      }

      case 'undo': {
        if (!isCommish) return { ok: false, error: 'That commissioner PIN doesn\'t match.' };
        if (!data.events.length) return { ok: false, error: 'There\'s nothing to undo.' };
        var last = data.events[data.events.length - 1];
        var msg = last.type === 'assign' ? 'Removed the assignment to ' + last.member + '.'
          : last.type === 'skip' ? 'Undid the skip — ' + last.member + ' is back on the clock.'
          : last.type === 'drop' ? last.member + ' is back in the draft.'
          : 'Undid pick #' + last.number + ' (' + last.member + ').';
        return { ok: true, message: msg, deleteRow: last.row };
      }
    }
    return { ok: false, error: 'Unknown action.' };
  }

  return {
    rowToEvent: rowToEvent, computeTurn: computeTurn, publicState: publicState, apply: apply,
    autoSkips: autoSkips, turnStart: turnStart,
  };
})();
/* ======================== END DRAFT ENGINE ================================ */
