/* ==========================================================================
 * DRAFT ENGINE — the draft rules, shared by the web page (demo mode) and the
 * Google Apps Script backend. apps-script/Code.gs contains an exact copy of
 * this block; if you change one, copy it into the other.
 *
 * The Draft Picks tab is an event log. Each row is one of:
 *   pick    — a normal draft pick (Round = number, Item ID = inventory ID)
 *   assign  — commissioner assignment (Round = "Assigned"); uses no turn
 *   skip    — commissioner skipped the on-clock member (Item ID = "SKIPPED")
 *   drop    — member dropped out (Item ID = "DROPPED OUT"); uses their turn
 *             only if they were on the clock at the time
 * ========================================================================== */
var DraftEngine = (function () {
  var SKIP = 'SKIPPED';
  var DROP = 'DROPPED OUT';

  /** Turn a Draft Picks row ([Pick #, Round, Member, Item ID, ...]) into an event. */
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
      time: t && typeof t.toISOString === 'function' ? t.toISOString() : String(t || ''),
    };
  }

  function droppedSet(events) {
    var d = {};
    events.forEach(function (e) { if (e.type === 'drop') d[e.member] = true; });
    return d;
  }

  /**
   * Replays the event log against the draft order (snake or straight) to work
   * out who is on the clock and who comes next. Members who dropped out, or who
   * hit the pick limit, are passed over. Dropped members still appear in the
   * upcoming list (flagged out: true) so the page can strike them through.
   */
  function computeTurn(members, events, maxPicks, snake, upcomingCount) {
    var n = members.length;
    var res = { current: null, upcoming: [] };
    if (!n) return res;
    upcomingCount = upcomingCount || n;
    var limit = maxPicks > 0 ? maxPicks : Infinity;
    var dropped = {};
    var cnt = {};
    members.forEach(function (m) { cnt[m.name] = 0; });

    function at(s) {
      var round = Math.floor(s / n) + 1;
      var idx = s % n;
      if (snake && round % 2 === 0) idx = n - 1 - idx;
      return { name: members[idx].name, round: round };
    }
    function eligible(name, c) { return !dropped[name] && (c[name] || 0) < limit; }
    function next(from, c) {
      if (!members.some(function (m) { return eligible(m.name, c); })) return -1;
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
      if ((sim[u.name] || 0) >= limit) continue;
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

  /** data = { settings, members: [{order,name,pin}], inventory: [...], events: [...] } */
  function publicState(data) {
    var s = data.settings;
    var taken = takenMap(data.events);
    var left = data.inventory.filter(function (i) { return !taken[i.id]; }).length;
    var dropped = droppedSet(data.events);
    var turn = left > 0
      ? computeTurn(data.members, data.events, s.maxPicks, s.snake, data.members.length)
      : { current: null, upcoming: [] };

    // Don't promise more upcoming turns than there are seat pairs left.
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

    return {
      ok: true,
      title: s.title,
      snake: s.snake,
      maxPicks: s.maxPicks,
      open: s.open,
      members: data.members.map(function (m) {
        return { order: m.order, name: m.name, needsPin: !!m.pin, out: !!dropped[m.name] }; // PINs never leave the backend
      }),
      inventory: data.inventory,
      picks: data.events.map(function (e) {
        return { number: e.number, type: e.type, assigned: e.type === 'assign', round: e.round, member: e.member, itemId: e.itemId, time: e.time };
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
    return [pickNo, round, member, item.id, item.series, item.game, item.date, item.seats, item.price, new Date()];
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
    var left = data.inventory.filter(function (i) { return !taken[i.id]; }).length;
    var turn = left > 0 ? computeTurn(data.members, data.events, s.maxPicks, s.snake, 1) : { current: null };
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
        if (m && m.pin && pin !== m.pin && !isCommish) return { ok: false, error: pin ? 'That PIN doesn\'t match.' : 'Enter your PIN.' };
        var item = findItem(data, body.itemId);
        if (!item) return { ok: false, error: 'That game/seat option wasn\'t found.' };
        if (taken[item.id]) return { ok: false, error: 'Sorry — that one was just taken.' };
        return {
          ok: true,
          message: cur.name + ' took ' + item.series + ' ' + item.game + ', seats ' + item.seats + '.',
          append: itemRow(cur.pick, cur.round, cur.name, item),
        };
      }

      case 'assign': {
        if (!isCommish) return { ok: false, error: 'That commissioner PIN doesn\'t match.' };
        var am = findMember(data, body.name);
        if (!am) return { ok: false, error: 'Choose a member.' };
        var ai = findItem(data, body.itemId);
        if (!ai) return { ok: false, error: 'Choose a game and seats.' };
        if (taken[ai.id]) return { ok: false, error: 'That one is already taken.' };
        return {
          ok: true,
          message: 'Assigned ' + ai.series + ' ' + ai.game + ', seats ' + ai.seats + ' to ' + am.name + '.',
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

  return { rowToEvent: rowToEvent, computeTurn: computeTurn, publicState: publicState, apply: apply };
})();
/* ======================== END DRAFT ENGINE ================================ */
