/**
 * Guardians Ticket Drafts — Google Apps Script backend
 *
 * Runs two drafts from one Google Sheet:
 *   • Postseason draft      — tabs "Draft Settings", "Draft Members", "Draft Inventory", "Draft Picks"
 *   • Regular season draft  — tabs "RS Settings", "RS Members", "RS Draft Order", "RS Games", "RS Picks"
 *
 * Paste this whole file into your Google Sheet: Extensions → Apps Script, save,
 * then Deploy → Manage deployments → ✏️ → Version: New version → Deploy.
 * A "Guardians Draft" menu appears in the sheet (reload the sheet once) with:
 *   • Set up postseason tabs
 *   • Set up regular season draft     (creates the RS tabs and loads the schedule from MLB)
 *   • Refresh regular season schedule from MLB   (updates dates, times, promotions)
 * Setup never overwrites a tab that already exists.
 */

const TEAM_ID = 114; // Cleveland Guardians (MLB Stats API team id)

const DRAFTS = {
  post: {
    kind: 'post',
    defaultTitle: 'Postseason Draft',
    tabs: { settings: 'Draft Settings', members: 'Draft Members', inventory: 'Draft Inventory', picks: 'Draft Picks' },
  },
  rs: {
    kind: 'rs',
    defaultTitle: 'Regular Season Draft',
    tabs: { settings: 'RS Settings', members: 'RS Members', order: 'RS Draft Order', inventory: 'RS Games', picks: 'RS Picks' },
  },
};
const ARCHIVE_PREFIX = 'Archive · ';

const PICK_HEADERS = ['Pick #', 'Round', 'Member', 'Item ID', 'Series', 'Game', 'Date', 'Seats', 'Price', 'Timestamp'];
const RS_GAME_HEADERS = ['Game ID', 'Date', 'Day', 'Opponent', 'Time (ET)', 'Promotions', 'Notes'];

function draftKey_(v) { return v === 'rs' ? 'rs' : 'post'; }

/* ----------------------------------------------------------------------- */
/* Sheet menu                                                               */
/* ----------------------------------------------------------------------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Guardians Draft')
    .addItem('Set up postseason tabs', 'setup')
    .addItem('Set up regular season draft', 'setupRegularSeason')
    .addSeparator()
    .addItem('Refresh regular season schedule from MLB', 'refreshSchedule')
    .addSeparator()
    .addItem('Export everything for Firebase', 'exportForFirebase')
    .addToUi();
}

/* ----------------------------------------------------------------------- */
/* One-time setup: postseason                                               */
/* ----------------------------------------------------------------------- */

function setup() {
  const ss = SpreadsheetApp.getActive();
  const T = DRAFTS.post.tabs;

  ensureTab_(ss, T.settings, [
    ['Setting', 'Value', 'Notes'],
    ['Draft title', '2026 Guardians Postseason Draft', 'Shown at the top of the page'],
    ['Snake draft', 'TRUE', 'TRUE = order reverses every round (1→N, then N→1)'],
    ['Max picks per member', '', 'Leave blank for no limit. Members at the limit are skipped.'],
    ['Draft open', 'TRUE', 'Set to FALSE to pause all picking'],
    ['Commissioner PIN', 'change-me', 'Undo picks, and make a pick for whoever is on the clock'],
  ]);

  ensureTab_(ss, T.members, [
    ['Draft order', 'Name', 'PIN'],
    [1, 'Member 1', '1111'],
    [2, 'Member 2', '2222'],
    [3, 'Member 3', '3333'],
    [4, 'Member 4', '4444'],
  ], [3]);

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
  ensureTab_(ss, T.inventory, inv);
  ensureTab_(ss, T.picks, [PICK_HEADERS]);

  SpreadsheetApp.getUi().alert(
    'Postseason draft tabs are ready.\n\n' +
    '1. Fill in Draft Members (order, names, PINs).\n' +
    '2. Check Draft Inventory (games, seats, prices).\n' +
    '3. Change the Commissioner PIN in Draft Settings.'
  );
}

/* ----------------------------------------------------------------------- */
/* One-time setup: regular season                                           */
/* ----------------------------------------------------------------------- */

function setupRegularSeason() {
  const ss = SpreadsheetApp.getActive();
  const T = DRAFTS.rs.tabs;
  const P = DRAFTS.post.tabs;

  // Start from the postseason member list and commissioner PIN (edit freely afterwards).
  let people = [];
  let commishPin = 'change-me';
  if (ss.getSheetByName(P.members)) {
    people = rows_(P.members)
      .filter(function (r) { return String(r[1]).trim() !== ''; })
      .sort(function (a, b) { return (Number(a[0]) || 999) - (Number(b[0]) || 999); })
      .map(function (r) { return [String(r[1]).trim(), String(r[2] == null ? '' : r[2]).trim()]; });
  }
  if (ss.getSheetByName(P.settings)) commishPin = readSettings_('post').commissionerPin || commishPin;
  if (!people.length) people = [['Member 1', '1111'], ['Member 2', '2222']];

  const nextSeason = new Date().getFullYear() + 1;
  ensureTab_(ss, T.settings, [
    ['Setting', 'Value', 'Notes'],
    ['Draft title', nextSeason + ' Guardians Regular Season Draft', 'Shown at the top of the page'],
    ['Season', String(nextSeason), 'Which MLB season to load from Guardians Draft → Refresh regular season schedule'],
    ['Snake draft', 'TRUE', 'TRUE = order reverses every round'],
    ['Draft open', 'FALSE', 'Set to TRUE when the draft starts. FALSE pauses all picking.'],
    ['Pick time limit on', 'FALSE', 'TRUE = skip a member automatically when their time runs out'],
    ['Pick time limit (hours)', 24, 'Hours each member gets once they are on the clock (clock starts after the first pick)'],
    ['Commissioner PIN', commishPin, 'Undo, skip, assign games, archive. Can also pick for whoever is on the clock.'],
  ], [2]);

  ensureTab_(ss, T.members, [['Name', 'PIN', 'Games purchased']].concat(
    people.map(function (p) { return [p[0], p[1], '']; })
  ), [2]);

  ensureTab_(ss, T.order, [['Slot', 'Name', 'How this works']].concat(
    people.map(function (p, i) {
      return [i + 1, p[0], i === 0 ? 'One row per draft slot in a round. List a member once for every 5 games they purchased (10 games = 2 rows). A round = number of rows here. Snake order reverses each round.' : ''];
    })
  ));

  ensureTab_(ss, T.inventory, [RS_GAME_HEADERS], [2, 3, 5]);
  ensureTab_(ss, T.picks, [PICK_HEADERS]);

  let loaded = '';
  try { loaded = refreshSchedule_(); } catch (e) { loaded = 'Could not load the schedule from MLB yet (' + e.message + '). Try Guardians Draft → Refresh regular season schedule from MLB.'; }

  SpreadsheetApp.getUi().alert(
    'Regular season draft tabs are ready.\n\n' + loaded + '\n\n' +
    '1. RS Members: check names and PINs, and fill in Games purchased.\n' +
    '2. RS Draft Order: one row per slot (each member once per 5 games).\n' +
    '3. RS Settings: set Draft open to TRUE when you start.'
  );
}

/* ----------------------------------------------------------------------- */
/* Schedule from MLB                                                        */
/* ----------------------------------------------------------------------- */

function refreshSchedule() {
  const msg = refreshSchedule_();
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * Loads Cleveland home games for the season in RS Settings from the MLB Stats
 * API into RS Games. Matches rows by Game ID: updates date, day, opponent and
 * time; fills Promotions when MLB lists any (otherwise keeps what you typed);
 * never touches Notes and never deletes rows.
 */
function refreshSchedule_() {
  const T = DRAFTS.rs.tabs;
  const sh = ss_().getSheetByName(T.inventory);
  if (!sh) throw new Error('Run "Set up regular season draft" first.');
  const season = String(readSettings_('rs').season || (new Date().getFullYear() + 1)).trim();

  const url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=' + TEAM_ID +
    '&season=' + encodeURIComponent(season) + '&gameType=R&hydrate=team,game(promotions)';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('MLB returned ' + res.getResponseCode());
  const json = JSON.parse(res.getContentText());

  const seen = {};
  const games = [];
  (json.dates || []).forEach(function (d) {
    (d.games || []).forEach(function (g) {
      if (!g.teams || !g.teams.home || !g.teams.home.team || g.teams.home.team.id !== TEAM_ID) return;
      if (seen[g.gamePk]) return;
      seen[g.gamePk] = true;
      games.push(g);
    });
  });
  if (!games.length) return 'MLB has no ' + season + ' home games listed yet.';

  const values = sh.getDataRange().getValues();
  const header = values[0].length >= RS_GAME_HEADERS.length ? values[0] : RS_GAME_HEADERS;
  const rows = values.slice(1).filter(function (r) { return String(r[0]).trim() !== ''; });
  const byId = {};
  rows.forEach(function (r, i) { byId[String(r[0]).trim()] = i; });

  let added = 0, updated = 0;
  games.forEach(function (g) {
    const id = String(g.gamePk);
    const iso = g.officialDate || Utilities.formatDate(new Date(g.gameDate), 'America/New_York', 'yyyy-MM-dd');
    const day = Utilities.formatDate(new Date(iso + 'T12:00:00Z'), 'UTC', 'EEE');
    const opp = g.teams.away.team.name || '';
    const tbd = g.status && g.status.startTimeTBD;
    const time = tbd ? 'TBD' : Utilities.formatDate(new Date(g.gameDate), 'America/New_York', 'h:mm a');
    const promos = promoNames_(g);
    const dh = (g.doubleHeader === 'Y' || g.doubleHeader === 'S') ? 'Doubleheader game ' + (g.gameNumber || '') : '';
    if (id in byId) {
      const r = rows[byId[id]];
      const before = [toIso_(r[1]), r[2], r[3], timeText_(r[4]), r[5]].join('|');
      r[1] = iso; r[2] = day; r[3] = opp; r[4] = time;
      if (promos) r[5] = promos;
      if (dh && !String(r[6] || '').trim()) r[6] = dh;
      if ([r[1], r[2], r[3], r[4], r[5]].join('|') !== before) updated++;
    } else {
      rows.push([id, iso, day, opp, time, promos, dh]);
      added++;
    }
  });

  rows.sort(function (a, b) { return String(toIso_(a[1])).localeCompare(String(toIso_(b[1]))) || String(a[0]).localeCompare(String(b[0])); });
  const out = rows.map(function (r) { const x = r.slice(0, RS_GAME_HEADERS.length); while (x.length < RS_GAME_HEADERS.length) x.push(''); x[1] = toIso_(x[1]); x[4] = timeText_(x[4]); return x; });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), RS_GAME_HEADERS.length)).clearContent();
  [2, 3, 5].forEach(function (c) { sh.getRange(2, c, Math.max(out.length, 1), 1).setNumberFormat('@'); });
  if (out.length) sh.getRange(2, 1, out.length, RS_GAME_HEADERS.length).setValues(out);
  if (String(header[0]) !== RS_GAME_HEADERS[0]) sh.getRange(1, 1, 1, RS_GAME_HEADERS.length).setValues([RS_GAME_HEADERS]);
  clearCaches_();

  const tbdCount = out.filter(function (r) { return r[4] === 'TBD'; }).length;
  return 'Loaded the ' + season + ' schedule from MLB: ' + games.length + ' home games (' + added + ' new, ' + updated + ' updated)' +
    (tbdCount ? '. ' + tbdCount + ' start times are still TBD.' : '.');
}

function promoNames_(g) {
  const list = (g.promotions || (g.game && g.game.promotions) || []);
  const names = [];
  list.forEach(function (p) {
    const n = String(p.name || p.offerName || p.description || '').trim();
    if (n && names.indexOf(n) < 0) names.push(n);
  });
  return names.join('; ');
}

/* ----------------------------------------------------------------------- */
/* Moving to Firebase: one-time export                                      */
/* ----------------------------------------------------------------------- */

/**
 * Shows everything (settings, members with PINs, draft order, games, picks and
 * archived drafts) as one block of text to paste into the site's
 * Commissioner tools → Import. Contains PINs: don't share it.
 */
function exportForFirebase() {
  const json = JSON.stringify(buildExport_());
  const html = HtmlService.createHtmlOutput(
    '<div style="font:14px Arial,sans-serif">' +
    '<p><b>Copy all of this</b>, then on the draft site open <i>Commissioner tools → Setup &amp; import → Import</i> and paste it. It includes PINs, so don\'t share it.</p>' +
    '<textarea id="t" readonly style="width:100%;height:300px;font:11px monospace">' + json.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</textarea>' +
    '<p><button onclick="var t=document.getElementById(\'t\');t.select();document.execCommand(\'copy\');this.textContent=\'Copied!\'">Copy to clipboard</button> ' +
    '<span style="color:#666">' + Math.round(json.length / 1024) + ' KB</span></p></div>'
  ).setWidth(640).setHeight(460);
  SpreadsheetApp.getUi().showModalDialog(html, 'Export for Firebase');
}

function buildExport_() {
  const out = { exportedAt: new Date().toISOString() };
  ['post', 'rs'].forEach(function (key) {
    if (!isSetUp_(key)) return;
    const d = readAll_(key);
    const s = d.settings;
    const tabs = DRAFTS[key].tabs;
    const events = rows_(tabs.picks, true)
      .filter(function (r) { return String(r.values[2]).trim() !== ''; })
      .map(function (r) {
        const v = r.values;
        const ev = DraftEngine.rowToEvent(v, r.row);
        delete ev.row;
        ev.series = String(v[4] || ''); ev.game = String(v[5] || '');
        ev.date = v[6] instanceof Date ? toIso_(v[6]) : String(v[6] || '');
        ev.seats = String(v[7] || ''); ev.price = v[8] === '' ? '' : Number(v[8]) || 0;
        return ev;
      });
    out[key] = {
      settings: { title: s.title, season: s.season, snake: s.snake, maxPicks: s.maxPicks, open: s.open, timeLimitOn: s.timeLimitOn, timeLimitHours: s.timeLimitHours },
      commissionerPin: s.commissionerPin,
      members: d.members.map(function (m) { return { name: m.name, pin: m.pin, cap: m.cap || 0 }; }),
      order: d.order || [],
      inventory: d.inventory,
      events: events,
    };
  });
  out.archives = readArchives_().archives;
  return out;
}

/* ----------------------------------------------------------------------- */
/* Helpers for tabs                                                         */
/* ----------------------------------------------------------------------- */

// Creates a tab with rows if it doesn't exist. textCols (1-based) are formatted
// as plain text first so Sheets keeps PINs like 0472 and dates/times as typed.
function ensureTab_(ss, name, rows, textCols) {
  if (ss.getSheetByName(name)) return false; // never overwrite an existing tab
  const sh = ss.insertSheet(name);
  const width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
  const padded = rows.map(function (r) { r = r.slice(); while (r.length < width) r.push(''); return r; });
  (textCols || []).forEach(function (c) { sh.getRange(1, c, Math.max(padded.length, 200), 1).setNumberFormat('@'); });
  sh.getRange(1, 1, padded.length, width).setValues(padded);
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#0C2340').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, width);
  return true;
}

function isSetUp_(key) {
  const tabs = DRAFTS[key].tabs;
  return Object.keys(tabs).every(function (k) { return !!ss_().getSheetByName(tabs[k]); });
}

/* ----------------------------------------------------------------------- */
/* Web app endpoints                                                        */
/* ----------------------------------------------------------------------- */

// Short-lived cache so many people refreshing at once don't each re-read the
// sheet. Picks update it immediately; direct sheet edits show within a few seconds.
const CACHE_PREFIX = 'draft-state-v2-';
const CACHE_SECONDS = 5;

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.view === 'archives') return json_(readArchives_());
  const key = draftKey_(p.draft);
  if (!isSetUp_(key)) return json_({ ok: false, notSetUp: true, kind: key, error: 'This draft hasn\'t been set up yet.' });

  const cache = CacheService.getScriptCache();
  const hit = cache.get(CACHE_PREFIX + key);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);

  let data = readAll_(key);
  if (DraftEngine.autoSkips(data, Date.now()).length) {
    // Pick time limit ran out for someone: record the skip(s) under the lock.
    const lock = LockService.getScriptLock();
    if (lock.tryLock(10000)) {
      try { data = readAll_(key); writeAutoSkips_(key, data); } finally { lock.releaseLock(); }
    }
  }
  const text = JSON.stringify(DraftEngine.publicState(data));
  putCache_(key, text);
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function putCache_(key, text) {
  try { CacheService.getScriptCache().put(CACHE_PREFIX + key, text, CACHE_SECONDS); } catch (e) { /* too big or unavailable: skip */ }
}
function clearCaches_() {
  try { CacheService.getScriptCache().removeAll([CACHE_PREFIX + 'post', CACHE_PREFIX + 'rs']); } catch (e) { /* ignore */ }
}

function writeAutoSkips_(key, data) {
  const rows = DraftEngine.autoSkips(data, Date.now());
  if (!rows.length) return;
  const sh = ss_().getSheetByName(DRAFTS[key].tabs.picks);
  rows.forEach(function (r) {
    sh.appendRow(r);
    data.events.push(DraftEngine.rowToEvent(r, sh.getLastRow()));
  });
  SpreadsheetApp.flush();
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request.' });
  }
  const key = draftKey_(body.draft);
  if (!isSetUp_(key)) return json_({ ok: false, notSetUp: true, error: 'This draft hasn\'t been set up yet.' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return json_({ ok: false, error: 'The draft is busy — please try again in a moment.' });
  }
  try {
    const data = readAll_(key);
    writeAutoSkips_(key, data); // apply any expired turns before acting
    if (body.action === 'setPrices') {
      // Prices sent from the Season Ticket Manager (postseason draft only).
      const r = key === 'post' ? setPrices_(data, body) : { ok: false, error: 'Prices only apply to the postseason draft.' };
      const fresh2 = DraftEngine.publicState(r.ok ? readAll_(key) : data);
      if (r.ok) putCache_(key, JSON.stringify(fresh2));
      fresh2.ok = r.ok;
      if (r.error) fresh2.error = r.error;
      if (r.message) fresh2.message = r.message;
      return json_(fresh2);
    }
    const result = body.action === 'archive' ? archive_(key, data, body) : DraftEngine.apply(data, body);
    if (result.ok && body.action !== 'archive') {
      const sh = ss_().getSheetByName(DRAFTS[key].tabs.picks);
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
    if (result.ok && body.action === 'archive') data.events = [];
    const fresh = DraftEngine.publicState(data);
    if (result.ok) putCache_(key, JSON.stringify(fresh));
    fresh.ok = result.ok;
    if (result.error) fresh.error = result.error;
    if (result.message) fresh.message = result.message;
    return json_(fresh);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Commissioner-only: update Draft Inventory prices by round.
 * body.prices = { ALDS: 432, ALCS: 646, WS: 1090 } — keyed by the Item ID prefix.
 * Picks already in Draft Picks keep the price recorded when they were made.
 */
function setPrices_(data, body) {
  const pin = String(body.pin || '').trim();
  if (!data.settings.commissionerPin || pin !== data.settings.commissionerPin) {
    return { ok: false, error: 'That commissioner PIN doesn\'t match.' };
  }
  const prices = body.prices || {};
  const sh = ss_().getSheetByName(DRAFTS.post.tabs.inventory);
  const last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'Draft Inventory is empty.' };
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  const priceRange = sh.getRange(2, 6, last - 1, 1);
  const cur = priceRange.getValues();
  let changed = 0;
  const next = cur.map(function (row, i) {
    const prefix = String(ids[i][0]).trim().split('-')[0].toUpperCase();
    if (!prefix || !Object.prototype.hasOwnProperty.call(prices, prefix)) return row;
    const p = Number(prices[prefix]);
    if (!isFinite(p) || p < 0) return row;
    if (Number(row[0]) !== p) changed++;
    return [p];
  });
  if (!changed) return { ok: true, message: 'Prices already match.' };
  priceRange.setValues(next);
  SpreadsheetApp.flush();
  return { ok: true, message: 'Updated ' + changed + ' seat price' + (changed === 1 ? '' : 's') + '.' };
}

/* ----------------------------------------------------------------------- */
/* Archive                                                                  */
/* ----------------------------------------------------------------------- */

/** Copies the picks tab to "Archive · <title>" and clears the picks so the draft can be reused. */
function archive_(key, data, body) {
  const s = data.settings;
  if (!s.commissionerPin || String(body.pin || '').trim() !== s.commissionerPin) {
    return { ok: false, error: 'That commissioner PIN doesn\'t match.' };
  }
  if (!data.events.length) return { ok: false, error: 'There are no picks to archive.' };
  const ss = ss_();
  const sh = ss.getSheetByName(DRAFTS[key].tabs.picks);
  let name = (ARCHIVE_PREFIX + (s.title || DRAFTS[key].defaultTitle)).slice(0, 90);
  if (ss.getSheetByName(name)) name = (name.slice(0, 75) + ' (' + Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd HHmm') + ')');
  const copy = sh.copyTo(ss).setName(name);
  copy.getRange(1, 12).setValue('Archived');
  copy.getRange(1, 13).setValue(new Date());
  copy.getRange(2, 12).setValue('Draft');
  copy.getRange(2, 13).setValue(key);
  const last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
  SpreadsheetApp.flush();
  clearCaches_();
  return { ok: true, message: 'Archived "' + (s.title || 'this draft') + '". The board is cleared and ready for next time.' };
}

function readArchives_() {
  const tz = 'America/New_York';
  const out = ss_().getSheets()
    .filter(function (sh) { return sh.getName().indexOf(ARCHIVE_PREFIX) === 0; })
    .map(function (sh) {
      const v = sh.getDataRange().getValues();
      const at = v[0] && v[0][12];
      const kind = v[1] && v[1][12] ? String(v[1][12]) : '';
      return {
        title: sh.getName().slice(ARCHIVE_PREFIX.length),
        kind: kind,
        archivedAt: at instanceof Date ? at.toISOString() : String(at || ''),
        rows: v.slice(1).filter(function (r) { return String(r[2]).trim() !== ''; }).map(function (r) {
          const ev = DraftEngine.rowToEvent(r, 0);
          return {
            number: ev.number, type: ev.type, round: ev.round, member: ev.member, note: ev.note, time: ev.time,
            series: String(r[4] || ''), game: String(r[5] || ''),
            date: r[6] instanceof Date ? Utilities.formatDate(r[6], tz, 'yyyy-MM-dd') : String(r[6] || ''),
            seats: String(r[7] || ''), price: r[8] === '' ? '' : Number(r[8]) || '',
          };
        }),
      };
    })
    .sort(function (a, b) { return String(b.archivedAt).localeCompare(String(a.archivedAt)); });
  return { ok: true, archives: out };
}

/* ----------------------------------------------------------------------- */
/* Reading the sheet                                                        */
/* ----------------------------------------------------------------------- */

function readAll_(key) {
  const T = DRAFTS[key].tabs;
  const settings = readSettings_(key);
  let members, order = null, inventory;

  if (key === 'rs') {
    members = rows_(T.members)
      .filter(function (r) { return String(r[0]).trim() !== ''; })
      .map(function (r) {
        return { name: String(r[0]).trim(), pin: String(r[1] == null ? '' : r[1]).trim(), cap: Number(r[2]) || 0 };
      });
    order = rows_(T.order)
      .filter(function (r) { return String(r[1]).trim() !== ''; })
      .map(function (r, i) { return { slot: Number(r[0]) || 1000 + i, name: String(r[1]).trim() }; })
      .sort(function (a, b) { return a.slot - b.slot; })
      .map(function (o) { return o.name; });
    inventory = rows_(T.inventory)
      .filter(function (r) { return String(r[0]).trim() !== ''; })
      .map(rsGame_);
  } else {
    members = rows_(T.members)
      .filter(function (r) { return String(r[1]).trim() !== ''; })
      .map(function (r) {
        return { order: Number(r[0]) || 999, name: String(r[1]).trim(), pin: String(r[2] === undefined ? '' : r[2]).trim() };
      })
      .sort(function (a, b) { return a.order - b.order; });
    inventory = rows_(T.inventory)
      .filter(function (r) { return String(r[0]).trim() !== ''; })
      .map(function (r) {
        return {
          id: String(r[0]).trim(), series: String(r[1]), game: String(r[2]),
          date: formatDate_(r[3]), seats: String(r[4]), price: Number(r[5]) || 0, notes: String(r[6] || ''),
        };
      });
  }

  const events = rows_(T.picks, true)
    .filter(function (r) { return String(r.values[2]).trim() !== ''; })
    .map(function (r) { return DraftEngine.rowToEvent(r.values, r.row); });
  const data = { settings: settings, members: members, inventory: inventory, events: events };
  if (order) data.order = order;
  return data;
}

function rsGame_(r) {
  const iso = toIso_(r[1]);
  const opp = String(r[3] || '').trim();
  const day = String(r[2] || '').trim() || (iso ? Utilities.formatDate(new Date(iso + 'T12:00:00Z'), 'UTC', 'EEE') : '');
  const md = iso ? Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10)) : '';
  return {
    id: String(r[0]).trim(),
    date: iso, day: day, opponent: opp, time: timeText_(r[4]),
    promos: String(r[5] || ''), notes: String(r[6] || ''),
    series: 'Regular Season', game: 'vs ' + opp, seats: 'All 4 seats', price: '',
    label: (day ? day + ' ' : '') + md + ' vs ' + opp,
  };
}

function readSettings_(key) {
  const map = {};
  rows_(DRAFTS[key].tabs.settings).forEach(function (r) { map[String(r[0]).trim().toLowerCase()] = r[1]; });
  const bool = function (v, dflt) {
    if (v === '' || v === undefined || v === null) return dflt;
    return v === true || String(v).trim().toUpperCase() === 'TRUE';
  };
  return {
    kind: key,
    title: String(map['draft title'] || DRAFTS[key].defaultTitle),
    season: String(map['season'] || ''),
    snake: bool(map['snake draft'], true),
    maxPicks: Number(map['max picks per member']) || 0,
    open: bool(map['draft open'], true),
    timeLimitOn: bool(map['pick time limit on'], false),
    timeLimitHours: Number(map['pick time limit (hours)']) || 0,
    commissionerPin: String(map['commissioner pin'] == null ? '' : map['commissioner pin']).trim(),
  };
}

let ss__ = null;
function ss_() { return ss__ || (ss__ = SpreadsheetApp.getActive()); }

// One read per tab (getDataRange), which is much faster than several small calls.
function rows_(tabName, withRowNumbers) {
  const sh = ss_().getSheetByName(tabName);
  if (!sh) throw new Error('Missing tab "' + tabName + '". Run setup first.');
  const values = sh.getDataRange().getValues().slice(1);
  if (!withRowNumbers) return values;
  return values.map(function (v, i) { return { row: i + 2, values: v }; });
}

function formatDate_(v) {
  if (v instanceof Date) return (v.getMonth() + 1) + '/' + v.getDate();
  return String(v || '');
}
// Dates as yyyy-mm-dd whether the cell holds text or a real date.
function toIso_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
  return s;
}
// Times as "7:10 PM" whether the cell holds text or a real time.
function timeText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'h:mm a');
  return String(v || '').trim();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

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

// Lets the Firebase Cloud Functions (Node) load this same file.
if (typeof module !== "undefined" && module.exports) module.exports = DraftEngine;
