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
const { defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Engine = require('./engine');

admin.initializeApp();
const db = admin.firestore();

// Asked for once when you deploy. Needed only for the first import / "start fresh".
const SETUP_KEY = defineString('SETUP_KEY', { description: 'A private phrase you will type once on the site to import your data (not your commissioner PIN).' });

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

exports.api = onRequest({ cors: true, invoker: 'public', maxInstances: 10, region: 'us-central1' }, async (req, res) => {
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
    return res.json(await handle(key, body));
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
exports.timeLimitSweep = onSchedule({ schedule: 'every 10 minutes', region: 'us-central1' }, async () => {
  for (const key of KEYS) {
    try { await sweep(key); } catch (e) { console.error('sweep', key, e); }
  }
});

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */

async function handle(key, body) {
  if (body.action === 'import') return importAll(body);
  if (body.action === 'loadSchedule') return loadSchedule(key, body);

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
            members: (pub.members || []).map((m) => ({ name: m.name, pin: String((sec.pins || {})[m.name] || ''), cap: Number(m.cap) || 0 })),
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
