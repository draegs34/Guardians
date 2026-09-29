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

const PICK_HEADERS = ['Pick #', 'Round', 'Member', 'Item ID', 'Series', 'Game', 'Date', 'Seats', 'Price', 'Timestamp', 'Entered by'];

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
    ['Commissioner PIN', 'change-me', 'Lets the commissioner pick for whoever is on the clock, or undo the last pick'],
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
    ['ALCS-H4', 'AL Championship Series', 'Home Game 4', 'TBD', 646, 'If necessary'],
    ['WS-H1', 'World Series', 'Home Game 1', 'TBD', 1090, 'If Guardians advance'],
    ['WS-H2', 'World Series', 'Home Game 2', 'TBD', 1090, 'If Guardians advance'],
    ['WS-H3', 'World Series', 'Home Game 3', 'TBD', 1090, 'If necessary'],
    ['WS-H4', 'World Series', 'Home Game 4', 'TBD', 1090, 'If necessary'],
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

function doGet() {
  return json_(publicState_(readAll_()));
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
    let result;
    if (body.action === 'pick') result = makePick_(data, body);
    else if (body.action === 'undo') result = undoLast_(data, body);
    else result = { ok: false, error: 'Unknown action.' };

    const fresh = publicState_(readAll_());
    fresh.ok = result.ok;
    if (result.error) fresh.error = result.error;
    if (result.message) fresh.message = result.message;
    return json_(fresh);
  } finally {
    lock.releaseLock();
  }
}

function makePick_(data, body) {
  const s = data.settings;
  const isCommish = s.commissionerPin && String(body.pin || '').trim() === s.commissionerPin;

  if (!s.open && !isCommish) return { ok: false, error: 'The draft is paused right now.' };

  const turn = computeTurn(data.members, data.picks, s.maxPicks, s.snake, 1);
  if (!turn.current || data.picks.length >= data.inventory.length) return { ok: false, error: 'The draft is complete.' };

  const onClock = turn.current.name;
  const member = data.members.filter(function (m) { return m.name === body.name; })[0];

  if (!isCommish) {
    if (!member) return { ok: false, error: 'Pick your name from the list.' };
    if (String(body.pin || '').trim() !== member.pin) return { ok: false, error: 'That PIN doesn\'t match.' };
    if (member.name !== onClock) return { ok: false, error: 'It\'s not your turn — ' + onClock + ' is on the clock.' };
  }

  const item = data.inventory.filter(function (i) { return i.id === body.itemId; })[0];
  if (!item) return { ok: false, error: 'That game/seat option wasn\'t found.' };
  const taken = data.picks.some(function (p) { return p.itemId === item.id; });
  if (taken) return { ok: false, error: 'Sorry — that one was just taken.' };

  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.picks);
  sh.appendRow([
    data.picks.length + 1,
    turn.current.round,
    onClock,
    item.id,
    item.series,
    item.game,
    item.date,
    item.seats,
    item.price,
    new Date(),
    isCommish && body.name !== onClock ? 'Commissioner' : onClock,
  ]);
  return { ok: true, message: onClock + ' took ' + item.series + ' ' + item.game + ', seats ' + item.seats + '.' };
}

function undoLast_(data, body) {
  const s = data.settings;
  if (!s.commissionerPin || String(body.pin || '').trim() !== s.commissionerPin) {
    return { ok: false, error: 'Only the commissioner can undo picks.' };
  }
  if (!data.picks.length) return { ok: false, error: 'There are no picks to undo.' };
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.picks);
  const last = data.picks[data.picks.length - 1];
  sh.deleteRow(last.row);
  return { ok: true, message: 'Undid pick #' + last.number + ' (' + last.member + ').' };
}

/* ----------------------------------------------------------------------- */
/* Draft order — keep in sync with computeTurn() in app.js                  */
/* ----------------------------------------------------------------------- */

/**
 * Walks draft slots in order (snake or straight), skipping members who have
 * hit the pick limit, and matches existing picks to slots. Returns who is on
 * the clock now plus the next few turns.
 */
function computeTurn(members, picks, maxPicks, snake, upcomingCount) {
  upcomingCount = upcomingCount || members.length;
  const n = members.length;
  const out = { current: null, upcoming: [] };
  if (!n) return out;

  const sim = {};
  members.forEach(function (m) { sim[m.name] = 0; });
  let made = 0;
  const limit = maxPicks > 0 ? maxPicks : Infinity;
  const maxSlots = (picks.length + upcomingCount + 1) * n + n * 2;

  for (let slot = 0; slot < maxSlots; slot++) {
    const round = Math.floor(slot / n) + 1;
    let idx = slot % n;
    if (snake && round % 2 === 0) idx = n - 1 - idx;
    const m = members[idx];
    if (sim[m.name] >= limit) {
      if (members.every(function (x) { return sim[x.name] >= limit; })) break;
      continue;
    }
    if (made < picks.length) {
      sim[m.name]++;
      made++;
      continue;
    }
    const turn = { name: m.name, round: round, pick: made + 1 + out.upcoming.length + (out.current ? 1 : 0) };
    if (!out.current) { out.current = turn; sim[m.name]++; }
    else { out.upcoming.push(turn); sim[m.name]++; }
    if (out.upcoming.length >= upcomingCount) break;
  }
  return out;
}

/* ----------------------------------------------------------------------- */
/* Reading the sheet                                                        */
/* ----------------------------------------------------------------------- */

function readAll_() {
  const settings = readSettings_();
  const members = rows_(TAB.members)
    .filter(function (r) { return String(r[1]).trim() !== ''; })
    .map(function (r) { return { order: Number(r[0]) || 999, name: String(r[1]).trim(), pin: String(r[2]).trim() }; })
    .sort(function (a, b) { return a.order - b.order; });
  const inventory = rows_(TAB.inventory)
    .filter(function (r) { return String(r[0]).trim() !== ''; })
    .map(function (r) {
      return {
        id: String(r[0]).trim(), series: String(r[1]), game: String(r[2]),
        date: formatDate_(r[3]), seats: String(r[4]), price: Number(r[5]) || 0, notes: String(r[6] || ''),
      };
    });
  const picks = rows_(TAB.picks, true)
    .filter(function (r) { return String(r.values[2]).trim() !== ''; })
    .map(function (r, i) {
      const v = r.values;
      return {
        row: r.row, number: i + 1, round: Number(v[1]) || null, member: String(v[2]).trim(),
        itemId: String(v[3]).trim(), time: v[9] instanceof Date ? v[9].toISOString() : String(v[9] || ''),
        enteredBy: String(v[10] || ''),
      };
    });
  return { settings: settings, members: members, inventory: inventory, picks: picks };
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

function rows_(tabName, withRowNumbers) {
  const sh = SpreadsheetApp.getActive().getSheetByName(tabName);
  if (!sh) throw new Error('Missing tab "' + tabName + '". Run setup() first.');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  if (!withRowNumbers) return values;
  return values.map(function (v, i) { return { row: i + 2, values: v }; });
}

function formatDate_(v) {
  if (v instanceof Date) return (v.getMonth() + 1) + '/' + v.getDate();
  return String(v || '');
}

function publicState_(data) {
  const s = data.settings;
  const done = data.picks.length >= data.inventory.length;
  const turn = done ? { current: null, upcoming: [] }
    : computeTurn(data.members, data.picks, s.maxPicks, s.snake, data.members.length);
  // Don't list more upcoming turns than there are seats left.
  turn.upcoming = turn.upcoming.slice(0, Math.max(0, data.inventory.length - data.picks.length - 1));
  return {
    ok: true,
    title: s.title,
    snake: s.snake,
    maxPicks: s.maxPicks,
    open: s.open,
    members: data.members.map(function (m) { return { order: m.order, name: m.name }; }), // PINs never leave the sheet
    inventory: data.inventory,
    picks: data.picks.map(function (p) {
      return { number: p.number, round: p.round, member: p.member, itemId: p.itemId, time: p.time, enteredBy: p.enteredBy };
    }),
    current: turn.current,
    upcoming: turn.upcoming,
    serverTime: new Date().toISOString(),
  };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
