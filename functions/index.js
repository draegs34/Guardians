/**
 * Guardians Ticket Drafts — Firebase backend (Cloud Functions + Firestore)
 *
 * Firestore layout
 *   drafts/{post|rs}   public (anyone can read; only these functions write)
 *     { kind, settings:{title, season, snake, maxPicks, open, timeLimitOn, timeLimitHours},
 *       members:[{name, order, cap, needsPin}], order:[name…] (rs), inventory:[…], events:[…], updatedAt }
 *   secrets/{post|rs}  private (nobody can read from the web)
 *     { commissionerPin, pins:{ name: pin } }
 *   archives/{id}      public read
 *     { title, kind, archivedAt, rows:[…events] }
 *
 * The page reads drafts/{key} live and calls the `api` function to change anything.
 * `api` speaks the same JSON as the old Google Apps Script, so the Season Ticket
 * Manager's draft feed keeps working with just a URL change.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineString, defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const Engine = require('./engine');

admin.initializeApp();
const db = admin.firestore();

// Asked for once when you deploy. Needed only for the first import / "start fresh".
const SETUP_KEY = defineString('SETUP_KEY', { description: 'A private phrase you will type once on the site to import your data (not your commissioner PIN).' });

// Notifications: the Gmail account that sends draft emails, its App Password
// (stored as a Firebase secret), and the site address used in links.
const GMAIL_USER = defineString('GMAIL_USER', { default: '', description: 'Gmail address that sends draft emails (leave blank to turn email off)' });
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');
const SITE_URL = defineString('SITE_URL', { default: 'https://draegs34.github.io/Guardians/', description: 'Address of the draft site' });

const TEAM_ID = 114; // Cleveland Guardians
const KEYS = ['post', 'rs'];
const DEFAULT_TITLE = { post: 'Postseason Draft', rs: 'Regular Season Draft' };

/* ------------------------------------------------------------------ */
/* Converting between Firestore docs and the engine's data shape       */
/* ------------------------------------------------------------------ */

function toEngineData(key, pub, sec) {
  sec = sec || {};
  const pins = sec.pins || {};
  const s = pub.settings || {};
  const data = {
    settings: {
      kind: key,
      title: s.title || DEFAULT_TITLE[key],
      season: s.season || '',
      snake: s.snake !== false,
      maxPicks: Number(s.maxPicks) || 0,
      open: s.open !== false,
      timeLimitOn: !!s.timeLimitOn,
      timeLimitHours: Number(s.timeLimitHours) || 0,
      commissionerPin: String(sec.commissionerPin || ''),
    },
    members: (pub.members || []).map((m) => ({ name: m.name, order: m.order, cap: Number(m.cap) || 0, pin: String(pins[m.name] || '') })),
    inventory: pub.inventory || [],
    events: (pub.events || []).map((e, i) => Object.assign({}, e, { row: i + 2 })),
  };
  if (key === 'rs') data.order = pub.order || [];
  return data;
}

// A picks-tab style row from the engine → stored event object.
function rowToStored(r) {
  const ev = Engine.rowToEvent(r, 0);
  delete ev.row;
  return Object.assign(ev, {
    series: r[4] == null ? '' : String(r[4]), game: r[5] == null ? '' : String(r[5]), date: r[6] == null ? '' : String(r[6]),
    seats: r[7] == null ? '' : String(r[7]), price: r[8] === '' || r[8] == null ? '' : Number(r[8]),
  });
}
const stripRows = (events) => events.map((e) => { const x = Object.assign({}, e); delete x.row; return x; });

function publicMembers(members, pins) {
  return members.map((m, i) => ({ name: m.name, order: m.order || i + 1, cap: Number(m.cap) || 0, needsPin: !!pins[m.name] }));
}

/* ------------------------------------------------------------------ */
/* HTTP API                                                             */
/* ------------------------------------------------------------------ */

exports.api = onRequest({ cors: true, invoker: 'public', maxInstances: 10, region: 'us-central1', secrets: [GMAIL_APP_PASSWORD] }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      if (req.query.view === 'archives') return res.json(await readArchives());
      const key = req.query.draft === 'rs' ? 'rs' : 'post';
      return res.json(await readState(key));
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') body = JSON.parse((req.rawBody || '{}').toString());
    const key = body.draft === 'rs' ? 'rs' : 'post';
    if (body.action === 'syncMembers') return res.json(await syncMembers(key, body));
    if (/^notify/.test(body.action || '')) return res.json(await notifyAction(key, body));
    const before = await turnSnapshot(key);
    const out = await handle(key, body);
    if (out && out.ok !== false && out.inventory) await maybeNotify(key, before, out);
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: false, error: 'Something went wrong on the server. Please try again.' });
  }
});

async function readState(key) {
  const ref = db.doc('drafts/' + key);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, notSetUp: true, kind: key, error: "This draft hasn't been set up yet." };
  const sec = (await db.doc('secrets/' + key).get()).data() || {};
  let data = toEngineData(key, snap.data(), sec);
  if (Engine.autoSkips(data, Date.now()).length) data = await sweep(key) || data;
  return Engine.publicState(data);
}

async function readArchives() {
  const qs = await db.collection('archives').orderBy('archivedAt', 'desc').get();
  return { ok: true, archives: qs.docs.map((d) => d.data()) };
}

/** Writes any auto-skips (pick time limit) for a draft. Returns fresh engine data. */
async function sweep(key) {
  const before = await turnSnapshot(key);
  const data = await sweepTx(key);
  if (data && before && before.picks !== data.events.length) await maybeNotify(key, before, Engine.publicState(data));
  return data;
}
async function sweepTx(key) {
  return db.runTransaction(async (tx) => {
    const ref = db.doc('drafts/' + key);
    const [snap, secSnap] = await Promise.all([tx.get(ref), tx.get(db.doc('secrets/' + key))]);
    if (!snap.exists) return null;
    const data = toEngineData(key, snap.data(), secSnap.data());
    const rows = Engine.autoSkips(data, Date.now());
    if (!rows.length) return data;
    rows.forEach((r) => data.events.push(Object.assign(rowToStored(r), { row: data.events.length + 2 })));
    tx.update(ref, { events: stripRows(data.events), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return data;
  });
}

// Every 10 minutes: skip anyone whose pick time ran out (only does anything when the limit is on).
exports.timeLimitSweep = onSchedule({ schedule: 'every 10 minutes', region: 'us-central1', secrets: [GMAIL_APP_PASSWORD] }, async () => {
  for (const key of KEYS) {
    try { await sweep(key); } catch (e) { console.error('sweep', key, e); }
    try { await remindSweep(key); } catch (e) { console.error('reminders', key, e); }
  }
});

/** Follow-up reminders: every N hours after the last alert, up to M times per turn (Setup → Reminders). */
async function remindSweep(key) {
  const snap = await db.doc('drafts/' + key).get();
  if (!snap.exists) return;
  const pub = snap.data();
  const s = pub.settings || {};
  const hours = Number(s.reminderHours) || 0;
  const max = Math.round(Number(s.reminderCount) || 0);
  if (!s.reminderOn || hours <= 0 || max <= 0) return;
  const st = Engine.publicState(toEngineData(key, pub, {}));
  if (!st.open || !st.current) return;
  const cur = st.current;
  const turnId = cur.pick + '|' + cur.name;
  const logRef = db.doc('notify/log-' + key);
  const due = await db.runTransaction(async (tx) => {
    const log = (await tx.get(logRef)).data() || {};
    if (log.turn !== turnId) return null; // the first "you're on the clock" alert hasn't gone out yet
    const sent = Number(log.reminders) || 0;
    if (sent >= max) return null;
    const last = Date.parse(log.lastAt || log.at || '');
    // The sweep runs every 10 minutes, so allow 5 minutes early rather than up to 10 late.
    if (!last || Date.now() - last < hours * 3600e3 - 5 * 60e3) return null;
    tx.set(logRef, { reminders: sent + 1, lastAt: new Date().toISOString() }, { merge: true });
    return { n: sent + 1, since: log.at };
  });
  if (!due) return;
  const p = (((await PREFS().get()).data() || {}).prefs || {})[lc(cur.name)];
  if (!p) return;
  const et = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) + ' ET';
  const title = st.title || 'Ticket draft';
  await deliver(p, {
    subject: "Reminder: you're still on the clock — " + title,
    title: 'Reminder: it\'s still your pick, ' + cur.name,
    body: 'You\'ve been on the clock in the ' + title + ' since ' + (due.since ? et(due.since) : 'earlier') + ' (round ' + cur.round + ', pick ' + cur.pick + ').' + (st.deadline ? ' Please pick by ' + et(st.deadline) + '.' : ''),
    link: SITE_URL.value() + '#' + (key === 'rs' ? 'regular-season' : 'postseason'),
    badge: 1,
  });
}

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */

async function handle(key, body) {
  if (body.action === 'import') return importAll(body);
  if (body.action === 'loadSchedule') return loadSchedule(key, body);
  if (body.action === 'adminGet') body._prefs = ((await db.doc('notify/members').get()).data() || {}).prefs || {};
  if (body.action === 'adminSave') {
    const r = await handleTx(key, body);
    if (r.ok) await saveAdminEmails(body.admin && body.admin.members);
    return r;
  }
  return handleTx(key, body);
}

async function handleTx(key, body) {
  return db.runTransaction(async (tx) => {
    const ref = db.doc('drafts/' + key);
    const secRef = db.doc('secrets/' + key);
    const [snap, secSnap] = await Promise.all([tx.get(ref), tx.get(secRef)]);
    if (!snap.exists) return { ok: false, notSetUp: true, error: "This draft hasn't been set up yet." };
    const pub = snap.data();
    const sec = secSnap.data() || {};
    const data = toEngineData(key, pub, sec);
    const isCommish = !!data.settings.commissionerPin && String(body.pin || '').trim() === data.settings.commissionerPin;

    // Apply any expired turns first.
    const skips = Engine.autoSkips(data, Date.now());
    skips.forEach((r) => data.events.push(Object.assign(rowToStored(r), { row: data.events.length + 2 })));
    let dirty = skips.length > 0;
    let result;
    const update = {};

    switch (body.action) {
      case 'adminGet': {
        if (!isCommish) { result = { ok: false, error: "That commissioner PIN doesn't match." }; break; }
        result = {
          ok: true,
          admin: {
            settings: pub.settings || {},
            members: (pub.members || []).map((m) => ({ name: m.name, pin: String((sec.pins || {})[m.name] || ''), cap: Number(m.cap) || 0, email: (body._prefs[lc(m.name)] || {}).email || '' })),
            order: pub.order || [],
            inventory: pub.inventory || [],
          },
        };
        break;
      }

      case 'adminSave': {
        if (!isCommish) { result = { ok: false, error: "That commissioner PIN doesn't match." }; break; }
        const v = validateAdmin(key, body.admin || {});
        if (v.error) { result = { ok: false, error: v.error }; break; }
        update.settings = v.settings;
        update.members = publicMembers(v.members, v.pins);
        update.inventory = v.inventory;
        if (key === 'rs') update.order = v.order;
        const newSec = { pins: v.pins, commissionerPin: data.settings.commissionerPin };
        if (body.admin.newCommissionerPin) newSec.commissionerPin = String(body.admin.newCommissionerPin).trim();
        tx.set(secRef, newSec);
        Object.assign(data.settings, v.settings, { commissionerPin: newSec.commissionerPin });
        data.members = v.members.map((m) => Object.assign({}, m, { pin: v.pins[m.name] || '' }));
        data.inventory = v.inventory;
        if (key === 'rs') data.order = v.order;
        dirty = true;
        result = { ok: true, message: 'Setup saved.' };
        break;
      }

      case 'setPrices': {
        if (key !== 'post') { result = { ok: false, error: 'Prices only apply to the postseason draft.' }; break; }
        if (!isCommish) { result = { ok: false, error: "That commissioner PIN doesn't match." }; break; }
        const prices = body.prices || {};
        let changed = 0;
        data.inventory = data.inventory.map((it) => {
          const prefix = String(it.id).split('-')[0].toUpperCase();
          if (!Object.prototype.hasOwnProperty.call(prices, prefix)) return it;
          const p = Number(prices[prefix]);
          if (!isFinite(p) || p < 0) return it;
          if (Number(it.price) !== p) changed++;
          return Object.assign({}, it, { price: p });
        });
        if (changed) { update.inventory = data.inventory; dirty = true; }
        result = { ok: true, message: changed ? 'Updated ' + changed + ' seat price' + (changed === 1 ? '' : 's') + '.' : 'Prices already match.' };
        break;
      }

      case 'archive': {
        if (!isCommish) { result = { ok: false, error: "That commissioner PIN doesn't match." }; break; }
        if (!data.events.length) { result = { ok: false, error: 'There are no picks to archive.' }; break; }
        tx.set(db.collection('archives').doc(), {
          title: data.settings.title, kind: key, archivedAt: new Date().toISOString(), rows: stripRows(data.events),
        });
        data.events = [];
        dirty = true;
        result = { ok: true, message: 'Archived "' + data.settings.title + '". The board is cleared and ready for next time.' };
        break;
      }

      default: {
        // pick, assign, skip, drop, undo — the same rules as the Google Sheet version.
        result = Engine.apply(data, body);
        if (result.ok && result.append) { data.events.push(Object.assign(rowToStored(result.append), { row: data.events.length + 2 })); dirty = true; }
        if (result.ok && result.deleteRow) { data.events.splice(result.deleteRow - 2, 1); dirty = true; }
      }
    }

    if (dirty) {
      update.events = stripRows(data.events);
      update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      tx.update(ref, update);
    }
    data.events = data.events.map((e, i) => Object.assign(e, { row: i + 2 }));
    const out = Object.assign(Engine.publicState(data), { ok: result.ok });
    if (result.error) out.error = result.error;
    if (result.message) out.message = result.message;
    if (result.admin) out.admin = result.admin;
    return out;
  });
}

/* Commissioner setup: clean up and check what the setup screen sent. */
function validateAdmin(key, a) {
  const str = (v) => String(v == null ? '' : v).trim();
  const s = a.settings || {};
  const settings = {
    title: str(s.title) || DEFAULT_TITLE[key],
    season: str(s.season),
    snake: s.snake !== false,
    maxPicks: Math.max(0, Number(s.maxPicks) || 0),
    open: !!s.open,
    timeLimitOn: !!s.timeLimitOn,
    timeLimitHours: Math.max(0, Number(s.timeLimitHours) || 0),
    // Follow-up reminders to whoever is on the clock
    reminderOn: !!s.reminderOn,
    reminderHours: Math.min(168, Math.max(0.5, Number(s.reminderHours) || 12)),
    reminderCount: Math.min(10, Math.max(1, Math.round(Number(s.reminderCount) || 2))),
  };
  const members = [];
  const pins = {};
  const seen = {};
  for (const m of a.members || []) {
    const name = str(m.name);
    if (!name) continue;
    if (seen[name.toLowerCase()]) return { error: 'Two members are both named "' + name + '". Names must be unique.' };
    seen[name.toLowerCase()] = true;
    members.push({ name, order: members.length + 1, cap: Math.max(0, Number(m.cap) || 0) });
    if (str(m.pin)) pins[name] = str(m.pin);
  }
  if (!members.length) return { error: 'Add at least one member.' };
  let order = [];
  if (key === 'rs') {
    order = (a.order || []).map(str).filter(Boolean);
    const bad = order.filter((n) => !seen[n.toLowerCase()]);
    if (bad.length) return { error: 'The draft order includes "' + bad[0] + '", who isn\'t on the member list.' };
    // normalize capitalization to the member list
    const byLower = {};
    members.forEach((m) => { byLower[m.name.toLowerCase()] = m.name; });
    order = order.map((n) => byLower[n.toLowerCase()]);
  }
  const ids = {};
  const inventory = [];
  for (const it of a.inventory || []) {
    const id = str(it.id);
    if (!id) continue;
    if (ids[id]) return { error: 'Game ID "' + id + '" is listed twice.' };
    ids[id] = true;
    inventory.push(key === 'rs' ? rsItem(Object.assign({}, it, { id })) : {
      id, series: str(it.series), game: str(it.game), date: str(it.date), seats: str(it.seats),
      price: Number(it.price) || 0, notes: str(it.notes),
    });
  }
  return { settings, members, pins, order, inventory };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function rsItem(it) {
  const str = (v) => String(v == null ? '' : v).trim();
  const date = str(it.date);
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const day = m ? DOW[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] : str(it.day);
  const opp = str(it.opponent);
  return {
    id: str(it.id), date, day, opponent: opp, time: str(it.time) || 'TBD',
    promos: str(it.promos), notes: str(it.notes),
    series: 'Regular Season', game: 'vs ' + opp, seats: 'All 4 seats', price: '',
    label: (day ? day + ' ' : '') + (m ? +m[2] + '/' + +m[3] : '') + ' vs ' + opp,
  };
}

/* Load / refresh the regular season home schedule from MLB's Stats API. */
async function loadSchedule(key, body) {
  if (key !== 'rs') return { ok: false, error: 'The MLB schedule only applies to the regular season draft.' };
  const ref = db.doc('drafts/rs');
  const [snap, secSnap] = await Promise.all([ref.get(), db.doc('secrets/rs').get()]);
  if (!snap.exists) return { ok: false, notSetUp: true, error: "This draft hasn't been set up yet." };
  const sec = secSnap.data() || {};
  if (!sec.commissionerPin || String(body.pin || '').trim() !== sec.commissionerPin) return { ok: false, error: "That commissioner PIN doesn't match." };
  const season = String((snap.data().settings || {}).season || new Date().getFullYear() + 1);
  const url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=' + TEAM_ID + '&season=' + encodeURIComponent(season) + '&gameType=R&hydrate=team,game(promotions)';
  const r = await fetch(url);
  if (!r.ok) return { ok: false, error: 'MLB returned ' + r.status + '. Try again later.' };
  const json = await r.json();
  const games = [];
  const seen = {};
  for (const d of json.dates || []) for (const g of d.games || []) {
    if (!g.teams || !g.teams.home || !g.teams.home.team || g.teams.home.team.id !== TEAM_ID || seen[g.gamePk]) continue;
    seen[g.gamePk] = true;
    games.push(g);
  }
  if (!games.length) return { ok: false, error: 'MLB has no ' + season + ' home games listed yet.' };

  const etDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const etTime = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const promoNames = (g) => {
    const names = [];
    for (const p of g.promotions || []) { const n = String(p.name || p.offerName || p.description || '').trim(); if (n && !names.includes(n)) names.push(n); }
    return names.join('; ');
  };

  return db.runTransaction(async (tx) => {
    const s2 = await tx.get(ref);
    const pub = s2.data();
    const inv = (pub.inventory || []).slice();
    const byId = {};
    inv.forEach((it, i) => { byId[it.id] = i; });
    let added = 0, updated = 0;
    for (const g of games) {
      const id = String(g.gamePk);
      const date = g.officialDate || etDate(g.gameDate);
      const time = g.status && g.status.startTimeTBD ? 'TBD' : etTime(g.gameDate);
      const promos = promoNames(g);
      const dh = (g.doubleHeader === 'Y' || g.doubleHeader === 'S') ? 'Doubleheader game ' + (g.gameNumber || '') : '';
      if (id in byId) {
        const old = inv[byId[id]];
        const next = rsItem(Object.assign({}, old, { date, opponent: g.teams.away.team.name, time, promos: promos || old.promos, notes: old.notes || dh }));
        if (JSON.stringify(next) !== JSON.stringify(old)) updated++;
        inv[byId[id]] = next;
      } else {
        inv.push(rsItem({ id, date, opponent: g.teams.away.team.name, time, promos, notes: dh }));
        added++;
      }
    }
    inv.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
    tx.update(ref, { inventory: inv, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    const tbd = inv.filter((x) => /^tbd$/i.test(x.time)).length;
    const data = toEngineData('rs', Object.assign({}, pub, { inventory: inv }), sec);
    return Object.assign(Engine.publicState(data), {
      ok: true,
      message: 'Loaded the ' + season + ' schedule from MLB: ' + games.length + ' home games (' + added + ' new, ' + updated + ' updated)' + (tbd ? '. ' + tbd + ' start times are still TBD.' : '.'),
    });
  });
}

/* One-time move from the Google Sheet (or start fresh). Needs the SETUP_KEY you
   chose at deploy time, or the current commissioner PIN once data exists. */
async function importAll(body) {
  const key = String(body.setupKey || '').trim();
  const expected = SETUP_KEY.value();
  const p = body.payload || {};
  let allowed = !!expected && key === expected;
  if (!allowed) {
    const secs = await Promise.all(KEYS.map((k) => db.doc('secrets/' + k).get()));
    allowed = secs.some((s) => s.exists && s.data().commissionerPin && s.data().commissionerPin === key);
  }
  if (!allowed) return { ok: false, error: "That setup key doesn't match." };

  const batch = db.batch();
  const done = [];
  for (const k of KEYS) {
    const d = p[k];
    if (!d) continue;
    const v = validateAdmin(k, { settings: d.settings, members: d.members, order: d.order, inventory: d.inventory });
    if (v.error) return { ok: false, error: (k === 'rs' ? 'Regular season: ' : 'Postseason: ') + v.error };
    const pub = { kind: k, settings: v.settings, members: publicMembers(v.members, v.pins), inventory: v.inventory, events: (d.events || []).map(cleanEvent), updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (k === 'rs') pub.order = v.order;
    batch.set(db.doc('drafts/' + k), pub);
    batch.set(db.doc('secrets/' + k), { pins: v.pins, commissionerPin: String(d.commissionerPin || '').trim() || 'change-me' });
    done.push(k === 'rs' ? 'regular season (' + v.inventory.length + ' games, ' + pub.events.length + ' entries)' : 'postseason (' + v.inventory.length + ' seat pairs, ' + pub.events.length + ' entries)');
  }
  if (Array.isArray(p.archives) && p.replaceArchives !== false) {
    const old = await db.collection('archives').get();
    old.docs.forEach((doc) => batch.delete(doc.ref));
    p.archives.forEach((a) => batch.set(db.collection('archives').doc(), { title: String(a.title || 'Archived draft'), kind: a.kind || '', archivedAt: a.archivedAt || new Date().toISOString(), rows: (a.rows || []).map(cleanEvent) }));
    done.push(p.archives.length + ' archived draft' + (p.archives.length === 1 ? '' : 's'));
  }
  if (!done.length) return { ok: false, error: 'Nothing to import.' };
  await batch.commit();
  return { ok: true, message: 'Imported ' + done.join(', ') + '.' };
}

function cleanEvent(e) {
  const t = ['pick', 'assign', 'skip', 'drop'].includes(e.type) ? e.type : 'pick';
  return {
    type: t, number: Number(e.number) || null, round: Number(e.round) || null, member: String(e.member || ''),
    itemId: t === 'pick' || t === 'assign' ? String(e.itemId || '') : '', note: String(e.note || ''), time: String(e.time || ''),
    series: String(e.series || ''), game: String(e.game || ''), date: String(e.date || ''), seats: String(e.seats || ''),
    price: e.price === '' || e.price == null ? '' : Number(e.price) || 0,
  };
}


/* ------------------------------------------------------------------ */
/* Notifications: email + push when it's a member's turn                */
/* ------------------------------------------------------------------ */
// Preferences live in notify/members (never readable from the web):
//   prefs: { "<lowercase name>": { name, email, emailOn, pushOn, nextUp, tokens:[…] } }
// They're shared by both drafts, matched by member name.

const lc = (s) => String(s || '').trim().toLowerCase();
const PREFS = () => db.doc('notify/members');

async function turnSnapshot(key) {
  const snap = await db.doc('drafts/' + key).get();
  if (!snap.exists) return null;
  const st = Engine.publicState(toEngineData(key, snap.data(), {}));
  return { open: st.open, current: st.current, picks: (snap.data().events || []).length };
}

async function checkMemberPin(key, name, pin) {
  const sec = (await db.doc('secrets/' + key).get()).data() || {};
  pin = String(pin || '').trim();
  if (sec.commissionerPin && pin === sec.commissionerPin) return true;
  const pins = sec.pins || {};
  const real = Object.keys(pins).find((n) => lc(n) === lc(name));
  const pub = (await db.doc('drafts/' + key).get()).data() || {};
  const isMember = (pub.members || []).some((m) => lc(m.name) === lc(name));
  if (!isMember) return false;
  return real ? pins[real] === pin : true; // members without a PIN don't need one
}

function cleanPrefs(old, incoming, name) {
  const p = Object.assign({ name, email: '', email2: '', emailOn: false, pushOn: false, nextUp: false, tokens: [] }, old || {});
  if (incoming) {
    if ('email' in incoming) p.email = String(incoming.email || '').trim().slice(0, 200);
    if ('email2' in incoming) p.email2 = String(incoming.email2 || '').trim().slice(0, 200);
    ['emailOn', 'pushOn', 'nextUp'].forEach((k) => { if (k in incoming) p[k] = !!incoming[k]; });
  }
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return { error: 'That email address doesn\'t look right.' };
  if (p.email2 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email2)) return { error: 'The second email address doesn\'t look right.' };
  if (!p.email && p.email2) { p.email = p.email2; p.email2 = ''; }
  if (p.email2 && lc(p.email2) === lc(p.email)) p.email2 = '';
  p.name = name;
  return { prefs: p };
}

async function notifyAction(key, body) {
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'Choose your name.' };
  if (!(await checkMemberPin(key, name, body.pin))) return { ok: false, error: 'That PIN doesn\'t match.' };
  const ref = PREFS();
  if (body.action === 'notifyGet') {
    const p = (((await ref.get()).data() || {}).prefs || {})[lc(name)] || {};
    return { ok: true, prefs: { email: p.email || '', email2: p.email2 || '', emailOn: !!p.emailOn, pushOn: !!p.pushOn, nextUp: !!p.nextUp, devices: (p.tokens || []).length, hasThisDevice: !!(body.token && (p.tokens || []).includes(body.token)) }, emailReady: !!GMAIL_USER.value() };
  }
  if (body.action === 'notifySave') {
    const result = await db.runTransaction(async (tx) => {
      const doc = (await tx.get(ref)).data() || {};
      const prefs = doc.prefs || {};
      const c = cleanPrefs(prefs[lc(name)], body.prefs, name);
      if (c.error) return { ok: false, error: c.error };
      const p = c.prefs;
      const tokens = new Set(p.tokens || []);
      if (body.addToken) tokens.add(String(body.addToken));
      if (body.removeToken) tokens.delete(String(body.removeToken));
      p.tokens = Array.from(tokens).slice(-10);
      prefs[lc(name)] = p;
      tx.set(ref, { prefs }, { merge: true });
      return { ok: true, message: 'Notification settings saved.', prefs: { email: p.email, email2: p.email2 || '', emailOn: p.emailOn, pushOn: p.pushOn, nextUp: p.nextUp, devices: p.tokens.length } };
    });
    return result;
  }
  if (body.action === 'notifyTest') {
    const p = (((await ref.get()).data() || {}).prefs || {})[lc(name)];
    if (!p) return { ok: false, error: 'Save your settings first.' };
    // A short wait lets the member close the app or lock the phone, so the test shows as a real banner.
    const wait = Math.min(15, Math.max(0, Number(body.delay) || 0));
    if (wait) await new Promise((r) => setTimeout(r, wait * 1000));
    const sent = await deliver(p, {
      subject: 'Test from the Guardians Ticket Draft',
      title: 'Test notification',
      body: 'This is a test. You\'ll get messages like this when it\'s your turn to pick.',
      link: SITE_URL.value(),
      badge: 1,
    });
    return { ok: true, message: sent.length ? 'Sent a test by ' + sent.join(' and ') + '.' : 'Nothing sent. Turn on email or push first.' };
  }
  return { ok: false, error: 'Unknown action.' };
}

/* Members sent from the Season Ticket Manager (commissioner only): preview what's
   there now, then add new members, update games purchased and email addresses. */
async function syncMembers(key, body) {
  const sec = (await db.doc('secrets/' + key).get()).data() || {};
  if (!sec.commissionerPin || String(body.pin || '').trim() !== sec.commissionerPin) return { ok: false, error: 'That commissioner PIN doesn\'t match.' };
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
  const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

  if (body.preview) {
    const prefs = ((await PREFS().get()).data() || {}).prefs || {};
    const drafts = {};
    const all = new Map();
    for (const k of ['rs', 'post']) {
      const snap = await db.doc('drafts/' + k).get();
      drafts[k] = snap.exists;
      ((snap.exists && snap.data().members) || []).forEach((m) => {
        const a = all.get(lc(m.name)) || { name: m.name, inRs: false, inPost: false, games: null, email: (prefs[lc(m.name)] || {}).email || '' };
        if (k === 'rs') { a.inRs = true; a.games = Number(m.cap) || 0; } else a.inPost = true;
        all.set(lc(m.name), a);
      });
    }
    return { ok: true, drafts, members: Array.from(all.values()) };
  }

  const games = (Array.isArray(body.games) ? body.games : []).slice(0, 200);
  const add = (Array.isArray(body.add) ? body.add : []).slice(0, 200).map((a) => ({ name: str(a && a.name, 80), games: Math.max(0, Math.round(Number(a && a.games) || 0)), email: str(a && a.email) })).filter((a) => a.name);
  const emails = (Array.isArray(body.emails) ? body.emails : []).slice(0, 200).map((e) => ({ name: str(e && e.name, 80), email: str(e && e.email) }));
  const addTo = { rs: !!(body.addTo && body.addTo.rs), post: !!(body.addTo && body.addTo.post) };
  const out = { added: { rs: [], post: [] }, games: 0, emails: 0, bad: [] };
  const known = new Set();

  for (const k of ['rs', 'post']) {
    const ref = db.doc('drafts/' + k);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const members = (snap.data().members || []).map((m) => Object.assign({}, m));
      const byLc = new Map(members.map((m) => [lc(m.name), m]));
      let dirty = false;
      if (k === 'rs') {
        games.forEach((g) => {
          const m = byLc.get(lc(g && g.name));
          const n = Math.max(0, Math.round(Number(g && g.games) || 0));
          if (m && Number(m.cap || 0) !== n) { m.cap = n; out.games++; dirty = true; }
        });
      }
      if (addTo[k]) {
        add.forEach((a) => {
          if (byLc.has(lc(a.name))) return;
          const m = { name: a.name, order: members.length + 1, cap: k === 'rs' ? a.games : 0, needsPin: false };
          members.push(m);
          byLc.set(lc(a.name), m);
          out.added[k].push(a.name);
          dirty = true;
        });
      }
      members.forEach((m) => known.add(lc(m.name)));
      if (dirty) tx.update(ref, { members, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
  }

  add.forEach((a) => { if (a.email) emails.push({ name: a.name, email: a.email }); });
  if (emails.length) {
    await db.runTransaction(async (tx) => {
      const ref = PREFS();
      const prefs = ((await tx.get(ref)).data() || {}).prefs || {};
      emails.forEach((e) => {
        if (!known.has(lc(e.name))) return;
        if (!okEmail(e.email)) { out.bad.push(e.name); return; }
        const p = prefs[lc(e.name)];
        if (p && lc(p.email) === lc(e.email)) return;
        // A member's first address turns email alerts on; a changed address keeps their on/off choice.
        prefs[lc(e.name)] = p && p.email ? Object.assign(p, { email: e.email }) : Object.assign({ pushOn: false, nextUp: false, tokens: [] }, p || {}, { name: e.name, email: e.email, emailOn: true });
        out.emails++;
      });
      tx.set(ref, { prefs }, { merge: true });
    });
  }

  const bits = [];
  const label = { rs: 'the regular season draft', post: 'the postseason draft' };
  ['rs', 'post'].forEach((k) => { if (out.added[k].length) bits.push('added ' + out.added[k].join(', ') + ' to ' + label[k]); });
  if (out.games) bits.push('updated games for ' + out.games + ' member' + (out.games === 1 ? '' : 's'));
  if (out.emails) bits.push('updated ' + out.emails + ' email address' + (out.emails === 1 ? '' : 'es'));
  if (out.bad.length) bits.push('skipped an invalid email for ' + out.bad.join(', '));
  let msg = bits.join('; ');
  msg = msg ? msg.charAt(0).toUpperCase() + msg.slice(1) + '.' : 'Nothing needed changing.';
  if (out.added.rs.length) msg += ' Give new members draft-order slots in Setup.';
  return { ok: true, message: msg, result: out };
}

/* Commissioner Setup can fill in members' email addresses. */
async function saveAdminEmails(members) {
  if (!Array.isArray(members)) return;
  const ref = PREFS();
  await db.runTransaction(async (tx) => {
    const doc = (await tx.get(ref)).data() || {};
    const prefs = doc.prefs || {};
    let changed = false;
    members.forEach((m) => {
      const name = String(m.name || '').trim();
      if (!name || !('email' in m)) return;
      const email = String(m.email || '').trim();
      const old = prefs[lc(name)];
      if (!old && !email) return;
      if (old && (old.email || '') === email) return;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
      // New address from the commissioner: email turns on unless the member had turned it off.
      prefs[lc(name)] = Object.assign({ name, emailOn: true, pushOn: false, nextUp: false, tokens: [] }, old || {}, { name, email });
      changed = true;
    });
    if (changed) tx.set(ref, { prefs }, { merge: true });
  });
}

/* After any change: if someone new is on the clock (or up next), tell them once. */
async function maybeNotify(key, before, after) {
  try {
    if (!after || !after.open || !after.current) return;
    const cur = after.current;
    const turnId = cur.pick + '|' + cur.name;
    const beforeId = before && before.open && before.current ? before.current.pick + '|' + before.current.name : '';
    if (turnId === beforeId) return;
    const next = (after.upcoming || []).find((u) => !u.out && u.name !== cur.name);
    const nextId = next ? next.pick + '|' + next.name : '';

    const logRef = db.doc('notify/log-' + key);
    const todo = await db.runTransaction(async (tx) => {
      const log = (await tx.get(logRef)).data() || {};
      const out = [];
      if (log.turn !== turnId) out.push({ type: 'turn', name: cur.name });
      if (next && log.next !== nextId && log.turn !== turnId) out.push({ type: 'next', name: next.name });
      const now = new Date().toISOString();
      // A new turn starts the reminder clock over.
      tx.set(logRef, log.turn !== turnId ? { turn: turnId, next: nextId, at: now, lastAt: now, reminders: 0 } : { next: nextId }, { merge: true });
      return out;
    });
    if (!todo.length) return;

    const prefs = ((await PREFS().get()).data() || {}).prefs || {};
    const link = SITE_URL.value() + '#' + (key === 'rs' ? 'regular-season' : 'postseason');
    const title = after.title || 'Ticket draft';
    const deadline = after.deadline ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(after.deadline)) + ' ET' : '';
    await Promise.allSettled(todo.map((t) => {
      const p = prefs[lc(t.name)];
      if (!p) return null;
      if (t.type === 'next' && !p.nextUp) return null;
      const msg = t.type === 'turn'
        ? { subject: "You're on the clock — " + title, title: "You're on the clock, " + t.name + '!',
            body: 'It\'s your pick in the ' + title + ' (round ' + cur.round + ', pick ' + cur.pick + ').' + (deadline ? ' Please pick by ' + deadline + '.' : ''), link, badge: 1 }
        : { subject: "You're up next — " + title, title: "You're up next, " + t.name,
            body: cur.name + ' is picking now in the ' + title + '. You\'re next.', link };
      return deliver(p, msg);
    }));
  } catch (e) {
    console.error('notify', e); // never let a notification problem break a pick
  }
}

let transporter = null;
function mailer() {
  const user = GMAIL_USER.value();
  let pass = '';
  try { pass = GMAIL_APP_PASSWORD.value(); } catch (e) { pass = ''; }
  if (!user || !pass) return null;
  if (!transporter) transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass: pass.replace(/\s+/g, '') } });
  return transporter;
}

async function deliver(p, msg) {
  const sent = [];
  const jobs = [];
  if (p.emailOn && p.email && mailer()) {
    const settings = SITE_URL.value() + '#notifications';
    jobs.push(mailer().sendMail({
      from: '"Guardians Ticket Draft" <' + GMAIL_USER.value() + '>',
      to: [p.email, p.email2].filter(Boolean).join(', '),
      subject: msg.subject,
      text: msg.body + '\n\nOpen the draft: ' + msg.link + '\n\nChange your notification settings: ' + settings,
      html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#13213a">' +
        '<p style="font-size:18px;font-weight:bold;margin:0 0 8px">' + escHtml(msg.title) + '</p>' +
        '<p style="margin:0 0 16px">' + escHtml(msg.body) + '</p>' +
        '<p style="margin:0 0 24px"><a href="' + msg.link + '" style="background:#D50032;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open the draft</a></p>' +
        '<p style="font-size:12px;color:#5d6b82;margin:0">Private draft page for our season ticket group. <a href="' + settings + '" style="color:#5d6b82">Change your notification settings</a>.</p></div>',
    }).then(() => sent.push('email')).catch((e) => console.error('email', e.message)));
  }
  const tokens = p.pushOn ? (p.tokens || []) : [];
  if (tokens.length) {
    jobs.push(admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: msg.title, body: msg.body },
      data: { badge: msg.badge ? String(msg.badge) : '0' },
      webpush: { fcmOptions: { link: msg.link }, notification: { icon: SITE_URL.value() + 'icon-192.png', badge: SITE_URL.value() + 'icon-192.png', tag: 'draft-turn', renotify: true } },
    }).then(async (r) => {
      if (r.successCount) sent.push('push');
      const dead = [];
      r.responses.forEach((x, i) => {
        const code = x.error && x.error.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token' || code === 'messaging/invalid-argument') dead.push(tokens[i]);
      });
      if (dead.length) await removeTokens(p.name, dead);
    }).catch((e) => console.error('push', e.message)));
  }
  await Promise.allSettled(jobs);
  return sent;
}

async function removeTokens(name, dead) {
  const ref = PREFS();
  await db.runTransaction(async (tx) => {
    const doc = (await tx.get(ref)).data() || {};
    const prefs = doc.prefs || {};
    const p = prefs[lc(name)];
    if (!p) return;
    p.tokens = (p.tokens || []).filter((t) => !dead.includes(t));
    tx.set(ref, { prefs }, { merge: true });
  });
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
