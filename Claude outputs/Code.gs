/**
 * Guardians Postseason Draft — Google Apps Script backend
 *
 * Paste this whole file into your Google Sheet: Extensions → Apps Script.
 * Then run setup() once, and deploy as a Web app (see README.md).
 *
 * It adds four tabs to your sheet (your existing tabs are never touched):
 *   Draft Settings   — title, snake on/off, pick limit, open/paused, commissioner PIN
 *   Draft Members    — draft order, names, and each member's PIN
 *   Draft Inventory  — every game + seat pair up for grabs, with prices
 *   Draft Picks      — filled in automatically as people pick (edit only to fix mistakes)
 */

const TAB = {
  settings: 'Draft Settings',
  members: 'Draft Members',
  inventory: 'Draft Inventory',
  picks: 'Draft Picks',
};

const PICK_HEADERS = ['Pick #', 'Round', 'Member', 'Item ID', 'Series', 'Game', 'Date', 'Seats', 'Price', 'Timestamp'];

/* ----------------------------------------------------------------------- */
/* One-time setup                                                           */
/* ----------------------------------------------------------------------- */

function setup() {
  const ss = SpreadsheetApp.getActive();

  ensureTab_(ss, TAB.settings, [
    ['Setting', 'Value', 'Notes'],
    ['Draft title', '2026 Guardians Postseason Draft', 'Shown at the top of the page'],
    ['Snake draft', 'TRUE', 'TRUE = order reverses every round (1→N, then N→1)'],
    ['Max picks per member', '', 'Leave blank for no limit. Members at the limit are skipped.'],
    ['Draft open', 'TRUE', 'Set to FALSE to pause all picking'],
    ['Commissioner PIN', 'change-me', 'Undo picks, and make a pick for whoever is on the clock'],
  ]);

  ensureTab_(ss, TAB.members, [
    ['Draft order', 'Name', 'PIN'],
    [1, 'Member 1', '1111'],
    [2, 'Member 2', '2222'],
    [3, 'Member 3', '3333'],
    [4, 'Member 4', '4444'],
  ]);

  const inv = [['Item ID', 'Series', 'Game', 'Date', 'Seats', 'Price', 'Notes']];
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
  games.forEach(function (g) {
    ['7 & 8', '9 & 10'].forEach(function (seats) {
      const id = g[0] + '-S' + seats.split(' ')[0];
      inv.push([id, g[1], g[2], g[3], seats, g[4], g[5]]);
    });
  });
  ensureTab_(ss, TAB.inventory, inv);

  ensureTab_(ss, TAB.picks, [PICK_HEADERS]);

  SpreadsheetApp.getUi().alert(
    'Draft tabs are ready.\n\n' +
    '1. Fill in Draft Members (order, names, PINs).\n' +
    '2. Check Draft Inventory (games, seats, prices).\n' +
    '3. Change the Commissioner PIN in Draft Settings.\n' +
    '4. Deploy → New deployment → Web app.'
  );
}

function ensureTab_(ss, name, rows) {
  if (ss.getSheetByName(name)) return; // never overwrite an existing tab
  const sh = ss.insertSheet(name);
  const width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
  const padded = rows.map(function (r) { while (r.length < width) r.push(''); return r; });
  sh.getRange(1, 1, padded.length, width).setValues(padded);
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#0C2340').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, width);
}

/* ----------------------------------------------------------------------- */
/* Web app endpoints                                                        */
/* ----------------------------------------------------------------------- */

// Short-lived cache so many people refreshing at once don't each re-read the
// sheet. Picks update it immediately; direct sheet edits show within a few seconds.
const CACHE_KEY = 'draft-state-v1';
const CACHE_SECONDS = 5;

function doGet() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CACHE_KEY);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  const text = JSON.stringify(DraftEngine.publicState(readAll_()));
  putCache_(text);
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function putCache_(text) {
  try { CacheService.getScriptCache().put(CACHE_KEY, text, CACHE_SECONDS); } catch (e) { /* too big or unavailable: skip */ }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request.' });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return json_({ ok: false, error: 'The draft is busy — please try again in a moment.' });
  }
  try {
    const data = readAll_();
    const result = DraftEngine.apply(data, body);
    if (result.ok) {
      const sh = ss_().getSheetByName(TAB.picks);
      // Update the in-memory copy too, so we don't have to re-read the sheet.
      if (result.append) {
        sh.appendRow(result.append);
        data.events.push(DraftEngine.rowToEvent(result.append, sh.getLastRow()));
      }
      if (result.deleteRow) {
        sh.deleteRow(result.deleteRow);
        data.events = data.events
          .filter(function (ev) { return ev.row !== result.deleteRow; })
          .map(function (ev) { if (ev.row > result.deleteRow) ev.row--; return ev; });
      }
      SpreadsheetApp.flush();
    }
    const fresh = DraftEngine.publicState(data);
    if (result.ok) putCache_(JSON.stringify(fresh));
    fresh.ok = result.ok;
    if (result.error) fresh.error = result.error;
    if (result.message) fresh.message = result.message;
    return json_(fresh);
  } finally {
    lock.releaseLock();
  }
}

/* ----------------------------------------------------------------------- */
/* Reading the sheet                                                        */
/* ----------------------------------------------------------------------- */

function readAll_() {
  const settings = readSettings_();
  const members = rows_(TAB.members)
    .filter(function (r) { return String(r[1]).trim() !== ''; })
    .map(function (r) {
      return { order: Number(r[0]) || 999, name: String(r[1]).trim(), pin: String(r[2] === undefined ? '' : r[2]).trim() };
    })
    .sort(function (a, b) { return a.order - b.order; });
  const inventory = rows_(TAB.inventory)
    .filter(function (r) { return String(r[0]).trim() !== ''; })
    .map(function (r) {
      return {
        id: String(r[0]).trim(), series: String(r[1]), game: String(r[2]),
        date: formatDate_(r[3]), seats: String(r[4]), price: Number(r[5]) || 0, notes: String(r[6] || ''),
      };
    });
  const events = rows_(TAB.picks, true)
    .filter(function (r) { return String(r.values[2]).trim() !== ''; })
    .map(function (r) { return DraftEngine.rowToEvent(r.values, r.row); });
  return { settings: settings, members: members, inventory: inventory, events: events };
}

function readSettings_() {
  const map = {};
  rows_(TAB.settings).forEach(function (r) { map[String(r[0]).trim().toLowerCase()] = r[1]; });
  const bool = function (v, dflt) {
    if (v === '' || v === undefined || v === null) return dflt;
    return v === true || String(v).trim().toUpperCase() === 'TRUE';
  };
  return {
    title: String(map['draft title'] || 'Postseason Draft'),
    snake: bool(map['snake draft'], true),
    maxPicks: Number(map['max picks per member']) || 0,
    open: bool(map['draft open'], true),
    commissionerPin: String(map['commissioner pin'] || '').trim(),
  };
}

let ss__ = null;
function ss_() { return ss__ || (ss__ = SpreadsheetApp.getActive()); }

// One read per tab (getDataRange), which is much faster than several small calls.
function rows_(tabName, withRowNumbers) {
  const sh = ss_().getSheetByName(tabName);
  if (!sh) throw new Error('Missing tab "' + tabName + '". Run setup() first.');
  const values = sh.getDataRange().getValues().slice(1);
  if (!withRowNumbers) return values;
  return values.map(function (v, i) { return { row: i + 2, values: v }; });
}

function formatDate_(v) {
  if (v instanceof Date) return (v.getMonth() + 1) + '/' + v.getDate();
  return String(v || '');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

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
