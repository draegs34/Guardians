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
const rawDb = admin.firestore();

/* Test mode (the site opened with ?test): the same code runs against a separate set of
   documents — drafts/rs-test, secrets/post-test, notify/members-test, swapsTest, … —
   so testing never touches the real drafts, members' alert settings or emails. */
const { AsyncLocalStorage } = require('node:async_hooks');
const NS = new AsyncLocalStorage();
const isTest = () => !!(NS.getStore() && NS.getStore().test);
const TEST_COLS = { archives: 'archivesTest', swaps: 'swapsTest', swapOffers: 'swapOffersTest' };
function mapPath(p) {
  if (!isTest()) return p;
  const seg = p.split('/');
  if (seg.length === 2 && ['drafts', 'secrets', 'notify'].includes(seg[0])) return seg[0] + '/' + seg[1] + '-test';
  if (TEST_COLS[seg[0]]) seg[0] = TEST_COLS[seg[0]];
  return seg.join('/');
}
const db = {
  doc: (p) => rawDb.doc(mapPath(p)),
  collection: (c) => rawDb.collection(isTest() && TEST_COLS[c] ? TEST_COLS[c] : c),
  runTransaction: (fn) => rawDb.runTransaction(fn),
  batch: () => rawDb.batch(),
};

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
      showTab: s.showTab !== false,
      timeLimitOn: !!s.timeLimitOn,
      timeLimitHours: Number(s.timeLimitHours) || 0,
      commissionerPin: String(sec.commissionerPin || ''),
    },
    members: (pub.members || []).map((m) => ({ name: m.name, order: m.order, cap: Number(m.cap) || 0, pin: String(pins[m.name] || ''), inactive: !!m.inactive })),
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
  return members.map((m, i) => {
    const o = { name: m.name, order: m.order || i + 1, cap: Number(m.cap) || 0, needsPin: !!pins[m.name] };
    if (m.inactive) o.inactive = true;
    if (m.notInRs) o.notInRs = true;
    return o;
  });
}

/* A member changes their own PIN (Notification & PIN settings). The regular season list is the
   source of truth; the postseason copy is refreshed from it. The commissioner sees it in Setup. */
async function changePin(name, body) {
  const oldPin = String(body.oldPin || '').trim();
  const newPin = String(body.newPin || '').trim();
  if (!/^\d{4,8}$/.test(newPin)) return { ok: false, error: 'Your new PIN must be 4 to 8 digits.' };
  const res = await db.runTransaction(async (tx) => {
    const rsRef = db.doc('drafts/rs'), secRef = db.doc('secrets/rs');
    const [pubSnap, secSnap] = await Promise.all([tx.get(rsRef), tx.get(secRef)]);
    const pub = pubSnap.data() || {};
    const sec = secSnap.data() || {};
    const m = (pub.members || []).find((x) => lc(x.name) === lc(name));
    if (!m) return { ok: false, error: 'PINs are set on the regular season member list. Ask the commissioner to change yours.' };
    const pins = Object.assign({}, sec.pins || {});
    const cur = String(pins[m.name] || '');
    const commish = String(sec.commissionerPin || '');
    if (cur ? oldPin !== cur && !(commish && oldPin === commish) : oldPin && oldPin !== commish) return { ok: false, error: 'Your current PIN doesn\'t match.' };
    if (newPin === cur) return { ok: false, error: 'That\'s already your PIN.' };
    pins[m.name] = newPin;
    tx.set(secRef, Object.assign({}, sec, { pins }));
    if (!m.needsPin) tx.update(rsRef, { members: (pub.members || []).map((x) => (x === m ? Object.assign({}, x, { needsPin: true }) : x)) });
    return { ok: true, name: m.name };
  });
  if (!res.ok) return res;
  await syncPostFromRs({});
  return { ok: true, message: 'PIN changed. Use your new PIN from now on.' };
}

/* One commissioner PIN for both drafts. Either draft's PIN is accepted (they're kept the same once Setup is saved). */
async function commishPinOk(pin) {
  pin = String(pin || '').trim();
  if (!pin) return false;
  const snaps = await Promise.all(KEYS.map((k) => db.doc('secrets/' + k).get()));
  return snaps.some((sn) => sn.exists && sn.data().commissionerPin && String(sn.data().commissionerPin) === pin);
}

/* ------------------------------------------------------------------ */
/* HTTP API                                                             */
/* ------------------------------------------------------------------ */

exports.api = onRequest({ cors: true, invoker: 'public', maxInstances: 10, region: 'us-central1', secrets: [GMAIL_APP_PASSWORD] }, (req, res) => {
  let test = !!(req.query && req.query.test === '1');
  if (req.method === 'POST') {
    try {
      let b = req.body;
      if (typeof b === 'string') b = JSON.parse(b || '{}');
      if (!b || typeof b !== 'object') b = JSON.parse((req.rawBody || '{}').toString());
      test = test || !!b.test;
    } catch (e) { /* the handler reports bad input */ }
  }
  return NS.run({ test }, async () => {
    if (test) {
      try { await ensureTestData(); } catch (e) { console.error('test data', e); }
    }
    return apiHandler(req, res);
  });
});

async function apiHandler(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      if (req.query.view === 'archives') return res.json({ ok: false, error: 'Past drafts are only available to the commissioner, under Setup.' });
      const key = req.query.draft === 'rs' ? 'rs' : 'post';
      return res.json(await readState(key));
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') body = JSON.parse((req.rawBody || '{}').toString());
    const key = body.draft === 'rs' ? 'rs' : 'post';
    if (body.action === 'archives') return res.json(await commishPinOk(body.pin) ? await readArchives() : { ok: false, error: "That commissioner PIN doesn't match." });
    if (body.action === 'testReset') return res.json(await testReset(body));
    if (body.action === 'syncMembers') return res.json(await syncMembers(key, body));
    if (/^swap/.test(body.action || '')) return res.json(await swapAction(body));
    if (body.action === 'gamesMail') return res.json(await gamesMail(key, body));
    if (/^notify/.test(body.action || '')) return res.json(await notifyAction(key, body));
    const before = await turnSnapshot(key);
    const out = await handle(key, body);
    if (out && out.ok !== false && out.inventory) await maybeNotify(key, before, out);
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: false, error: 'Something went wrong on the server. Please try again.' });
  }
}

async function readState(key) {
  const ref = db.doc('drafts/' + key);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, notSetUp: true, kind: key, error: "This draft hasn't been set up yet." };
  const sec = (await db.doc('secrets/' + key).get()).data() || {};
  let data = toEngineData(key, snap.data(), sec);
  if (Engine.autoSkips(data, Date.now()).length) data = await sweep(key) || data;
  const st = Engine.publicState(data);
  if (snap.data().mlbCheck) st.mlbCheck = snap.data().mlbCheck;
  return st;
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
  for (const test of [false, true]) {
    await NS.run({ test }, async () => {
      for (const key of KEYS) {
        try { await sweep(key); } catch (e) { console.error('sweep', key, test ? '(test)' : '', e); }
        try { await remindSweep(key); } catch (e) { console.error('reminders', key, test ? '(test)' : '', e); }
      }
    });
  }
});

/** Quiet hours for reminders: none from 11 PM to 8 AM Eastern. One that comes due overnight goes out at 8 AM. */
const QUIET_START = 23;
const QUIET_END = 8;
function quietNow(when) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(when || new Date()));
  return QUIET_START > QUIET_END ? (h >= QUIET_START || h < QUIET_END) : (h >= QUIET_START && h < QUIET_END);
}

/** Follow-up reminders: every N hours after the last alert, up to M times per turn (Setup → Reminders). */
async function remindSweep(key) {
  const snap = await db.doc('drafts/' + key).get();
  if (!snap.exists) return;
  const pub = snap.data();
  const s = pub.settings || {};
  const hours = Number(s.reminderHours) || 0;
  const max = Math.round(Number(s.reminderCount) || 0);
  if (!s.reminderOn || hours <= 0 || max <= 0) return;
  if (quietNow()) return;
  const st = Engine.publicState(toEngineData(key, pub, {}));
  if (!st.open || !st.current) return;
  const cur = st.current;
  // Never remind someone who has dropped out.
  if ((st.members || []).some((m) => lc(m.name) === lc(cur.name) && m.out)) return;
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
  // Re-check right before sending, in case they dropped out or picked in the meantime.
  const fresh = (await db.doc('drafts/' + key).get()).data();
  const now = fresh && Engine.publicState(toEngineData(key, fresh, {}));
  if (!now || !now.open || !now.current || now.current.pick + '|' + now.current.name !== turnId) return;
  if ((now.members || []).some((m) => lc(m.name) === lc(cur.name) && m.out)) return;
  const p = (((await PREFS().get()).data() || {}).prefs || {})[lc(cur.name)];
  if (!p) return;
  const et = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) + ' ET';
  const title = st.title || 'Ticket draft';
  await deliver(p, {
    subject: "Reminder: you're still on the clock — " + title,
    title: 'Reminder: it\'s still your pick, ' + firstName(cur.name),
    body: 'You\'ve been on the clock in the ' + title + ' since ' + (due.since ? et(due.since) : 'earlier') + ' (round ' + cur.round + ', pick ' + cur.pick + ').' + (st.deadline ? ' Please pick by ' + et(st.deadline) + '.' : ''),
    link: siteLink(key === 'rs' ? 'regular-season' : 'postseason'),
    badge: 1,
    extra: draftOrderBlock(now, cur.name),
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
    const oldRs = key === 'rs' ? ((await db.doc('drafts/rs').get()).data() || {}).members || [] : [];
    const r = await handleTx(key, body);
    if (r.ok && key === 'rs') {
      const renames = renamesOf(body.admin && body.admin.members);
      const now = new Set(((body.admin && body.admin.members) || []).map((m) => lc(m.name)));
      const removed = oldRs.map((m) => renames[m.name] || m.name).filter((n) => !now.has(lc(n)));
      await renamePrefs(renames);
      await syncPostFromRs(renames, removed);
    }
    if (r.ok && key === 'rs') await saveAdminEmails(body.admin && body.admin.members);
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
    const otherSec = (await tx.get(db.doc('secrets/' + (key === 'rs' ? 'post' : 'rs')))).data() || {};
    const pinIn = String(body.pin || '').trim();
    const isCommish = !!pinIn && [data.settings.commissionerPin, String(otherSec.commissionerPin || '')].filter(Boolean).includes(pinIn);
    if (isCommish) data.settings.commissionerPin = pinIn; // the engine checks this for commissioner actions

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
            members: (pub.members || []).map((m) => ({ name: m.name, pin: String((sec.pins || {})[m.name] || ''), cap: Number(m.cap) || 0, email: (body._prefs[lc(m.name)] || {}).email || '', inactive: !!m.inactive, notInRs: !!m.notInRs })),
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
        if (key === 'post') {
          // Postseason members come from the regular season list: only their order and active/inactive change here.
          const cur = pub.members || [];
          const byLc = new Map(cur.map((m) => [lc(m.name), m]));
          const seen = new Set();
          const list = [];
          v.members.forEach((m) => { const c = byLc.get(lc(m.name)); if (c && !seen.has(lc(c.name))) { seen.add(lc(c.name)); list.push({ name: c.name, cap: 0, inactive: !!m.inactive, notInRs: !!c.notInRs }); } });
          cur.forEach((c) => { if (!seen.has(lc(c.name))) list.push({ name: c.name, cap: 0, inactive: !!c.inactive, notInRs: !!c.notInRs }); });
          v.members = list.map((m, i) => Object.assign(m, { order: i + 1 }));
          v.pins = Object.assign({}, sec.pins || {});
        } else {
          // Regular season: removing someone isn't allowed while they have picks in either draft.
          const renames = renamesOf(body.admin.members);
          const kept = new Set(v.members.map((m) => lc(m.name)));
          const postEv = ((await tx.get(db.doc('drafts/post'))).data() || {}).events || [];
          for (const m of pub.members || []) {
            const now = lc(renames[m.name] || m.name);
            if (kept.has(now)) continue;
            const where = [data.events.some((e) => lc(e.member) === lc(m.name)) ? 'regular season' : '', postEv.some((e) => lc(e.member) === lc(m.name)) ? 'postseason' : ''].filter(Boolean);
            if (where.length) { v.error = m.name + ' has picks in the ' + where.join(' and ') + ' draft' + (where.length > 1 ? 's' : '') + '. Undo those first, or keep them on the list.'; break; }
          }
          if (v.error) { result = { ok: false, error: v.error }; break; }
          if (Object.keys(renames).length) {
            data.events.forEach((e) => { if (renames[e.member]) e.member = renames[e.member]; });
          }
        }
        update.settings = v.settings;
        update.members = publicMembers(v.members, v.pins);
        update.inventory = v.inventory;
        if (key === 'rs') update.order = v.order;
        const newSec = { pins: v.pins, commissionerPin: data.settings.commissionerPin };
        if (key === 'rs' && body.admin.newCommissionerPin) newSec.commissionerPin = String(body.admin.newCommissionerPin).trim();
        tx.set(secRef, newSec);
        Object.assign(data.settings, v.settings, { commissionerPin: newSec.commissionerPin });
        data.members = v.members.map((m) => Object.assign({}, m, { pin: v.pins[m.name] || '' }));
        dirty = true; // events may have been renamed
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
    if (snap.data().mlbCheck) out.mlbCheck = snap.data().mlbCheck;
    if (result.error) out.error = result.error;
    if (result.message) out.message = result.message;
    if (result.admin) out.admin = result.admin;
    return out;
  });
}

/* Regular season Setup sends each member's original name as "orig"; a changed name is a rename. */
function renamesOf(members) {
  const r = {};
  (members || []).forEach((m) => {
    const from = String((m && m.orig) || '').trim();
    const to = String((m && m.name) || '').trim();
    if (from && to && from !== to) r[from] = to;
  });
  return r;
}

async function renamePrefs(renames) {
  const from = Object.keys(renames || {});
  if (!from.length) return;
  await db.runTransaction(async (tx) => {
    const ref = PREFS();
    const prefs = ((await tx.get(ref)).data() || {}).prefs || {};
    let changed = false;
    from.forEach((f) => {
      const p = prefs[lc(f)];
      if (!p || prefs[lc(renames[f])]) return;
      prefs[lc(renames[f])] = Object.assign({}, p, { name: renames[f] });
      delete prefs[lc(f)];
      changed = true;
    });
    if (changed) tx.set(ref, { prefs });
  });
}

/**
 * The regular season member list is the source of truth. Bring the postseason in line:
 * renames carried over, new members added (active, at the end), PINs and the commissioner
 * PIN copied. Someone no longer on the regular season list stays (inactive) only if they
 * have postseason picks.
 */
async function syncPostFromRs(renames, removed) {
  renames = renames || {};
  const gone = new Set((removed || []).map(lc));
  await db.runTransaction(async (tx) => {
    const rsRef = db.doc('drafts/rs'), postRef = db.doc('drafts/post');
    const [rsSnap, rsSec, postSnap, postSec] = await Promise.all([tx.get(rsRef), tx.get(db.doc('secrets/rs')), tx.get(postRef), tx.get(db.doc('secrets/post'))]);
    if (!rsSnap.exists || !postSnap.exists) return;
    const rsMembers = rsSnap.data().members || [];
    const rsPins = (rsSec.data() || {}).pins || {};
    const pub = postSnap.data();
    const oldPins = (postSec.data() || {}).pins || {};
    const events = (pub.events || []).map((e) => (renames[e.member] ? Object.assign({}, e, { member: renames[e.member] }) : e));
    const inRs = new Map(rsMembers.map((m) => [lc(m.name), m.name]));
    const out = [];
    const pins = {};
    const seen = new Set();
    (pub.members || []).forEach((m) => {
      const name = renames[m.name] || m.name;
      if (seen.has(lc(name))) return;
      if (inRs.has(lc(name))) {
        const real = inRs.get(lc(name));
        seen.add(lc(real));
        out.push({ name: real, inactive: !!m.inactive });
        if (rsPins[real]) pins[real] = rsPins[real];
      } else if (!gone.has(lc(name)) || events.some((e) => lc(e.member) === lc(name))) {
        // Not on the regular season list: kept (inactive) unless just removed there with no postseason picks.
        seen.add(lc(name));
        out.push({ name, inactive: true, notInRs: true });
        if (oldPins[m.name]) pins[name] = oldPins[m.name];
      }
    });
    rsMembers.forEach((m) => {
      if (seen.has(lc(m.name))) return;
      seen.add(lc(m.name));
      out.push({ name: m.name, inactive: false });
      if (rsPins[m.name]) pins[m.name] = rsPins[m.name];
    });
    tx.update(postRef, { members: publicMembers(out.map((m, i) => Object.assign(m, { order: i + 1, cap: 0 })), pins), events, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(db.doc('secrets/post'), { pins, commissionerPin: String((rsSec.data() || {}).commissionerPin || (postSec.data() || {}).commissionerPin || '') });
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
    showTab: s.showTab !== false, // postseason: whether members see its tab
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
    members.push({ name, order: members.length + 1, cap: Math.max(0, Number(m.cap) || 0), inactive: key === 'post' && !!m.inactive });
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
    const tbd = inv.filter((x) => /^tbd$/i.test(x.time)).length;
    // When the schedule was last checked against MLB, shown under the button in Setup.
    const mlbCheck = { at: new Date().toISOString(), season, games: games.length, added, updated, tbd };
    tx.update(ref, { inventory: inv, mlbCheck, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    const data = toEngineData('rs', Object.assign({}, pub, { inventory: inv }), sec);
    return Object.assign(Engine.publicState(data), {
      ok: true,
      mlbCheck,
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
  return writeImport(p);
}

async function writeImport(p) {
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
  if (await commishPinOk(pin)) return true;
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
    if ('phone' in incoming) p.phone = String(incoming.phone || '').trim().slice(0, 30);
    ['emailOn', 'pushOn', 'nextUp', 'swapEmails'].forEach((k) => { if (k in incoming) p[k] = !!incoming[k]; });
  }
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return { error: 'That email address doesn\'t look right.' };
  if (p.email2 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email2)) return { error: 'The second email address doesn\'t look right.' };
  if (p.phone) {
    const d = p.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (d.length !== 10) return { error: 'Enter a 10-digit phone number, or leave it blank.' };
    p.phone = d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
  }
  if (!p.email && p.email2) { p.email = p.email2; p.email2 = ''; }
  if (p.email2 && lc(p.email2) === lc(p.email)) p.email2 = '';
  p.name = name;
  return { prefs: p };
}

async function notifyAction(key, body) {
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'Choose your name.' };
  if (body.action === 'notifyPin') return changePin(name, body);
  if (!(await checkMemberPin(key, name, body.pin))) return { ok: false, error: 'That PIN doesn\'t match.' };
  const ref = PREFS();
  if (body.action === 'notifyGet') {
    const p = (((await ref.get()).data() || {}).prefs || {})[lc(name)] || {};
    // Test mode starts with no addresses. Suggest the member's real address so the field isn't blank;
    // it's only used for test alerts once they save it here.
    let suggest = '';
    if (isTest() && !p.email && !p.email2) {
      const real = (((await rawDb.doc('notify/members').get()).data() || {}).prefs || {})[lc(name)] || {};
      suggest = real.email || '';
    }
    return { ok: true, suggestEmail: suggest, prefs: { email: p.email || '', email2: p.email2 || '', phone: p.phone || '', emailOn: !!p.emailOn, pushOn: !!p.pushOn, nextUp: !!p.nextUp, swapEmails: p.swapEmails !== false, devices: (p.tokens || []).length, hasThisDevice: !!(body.token && (p.tokens || []).includes(body.token)) }, emailReady: !!GMAIL_USER.value() };
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
      return { ok: true, message: 'Notification settings saved.', prefs: { email: p.email, email2: p.email2 || '', phone: p.phone || '', emailOn: p.emailOn, pushOn: p.pushOn, nextUp: p.nextUp, devices: p.tokens.length } };
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
      link: siteLink(''),
      badge: 1,
    });
    return { ok: true, message: sent.length ? 'Sent a test by ' + sent.join(' and ') + '.' : 'Nothing sent. Turn on email or push first.' };
  }
  return { ok: false, error: 'Unknown action.' };
}

/* Members sent from the Season Ticket Manager (commissioner only): preview what's
   there now, then add new members, update games purchased and email addresses. */
async function syncMembers(key, body) {
  if (!(await commishPinOk(body.pin))) return { ok: false, error: 'That commissioner PIN doesn\'t match.' };
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
  // New members go on the regular season list (the source of truth); the postseason follows it.
  const addTo = { rs: true, post: false };
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

  if (out.added.rs.length) await syncPostFromRs({});
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
  if (out.added.rs.length) bits.push('added ' + out.added.rs.join(', ') + ' (both drafts)');
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
const firstName = (n) => String(n || '').trim().split(/\s+/)[0];

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
    const link = siteLink(key === 'rs' ? 'regular-season' : 'postseason');
    const title = after.title || 'Ticket draft';
    const deadline = after.deadline ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(after.deadline)) + ' ET' : '';
    const outNames = new Set((after.members || []).filter((m) => m.out).map((m) => lc(m.name)));
    await Promise.allSettled(todo.map((t) => {
      const p = prefs[lc(t.name)];
      if (!p || outNames.has(lc(t.name))) return null;
      if (t.type === 'next' && !p.nextUp) return null;
      const msg = t.type === 'turn'
        ? { subject: "You're on the clock — " + title, title: "You're on the clock, " + firstName(t.name) + '!',
            body: 'It\'s your pick in the ' + title + ' (round ' + cur.round + ', pick ' + cur.pick + ').' + (deadline ? ' Please pick by ' + deadline + '.' : ''), link, badge: 1, extra: draftOrderBlock(after, t.name) }
        : { subject: "You're up next — " + title, title: "You're up next, " + firstName(t.name),
            body: cur.name + ' is picking now in the ' + title + '. You\'re next.', link, extra: draftOrderBlock(after, t.name) };
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

// Ticket Swap emails invite a reply so the commissioner can step in (replies go to the draft's Gmail).
const SWAP_HELP = 'If you are experiencing any issues with this request, please reply to this email.';
const swapHelpHtml = () => '<p style="font-size:14px;color:#13213a;margin:0 0 12px;padding-top:14px;border-top:1px solid #e3e7ee">' + escHtml(SWAP_HELP) + '</p>';

/** "Up next" list for draft emails: who's on the clock (red) and the next picks, with the
 *  recipient's own picks in blue. Up to 5 rows, like the draft page. */
function draftOrderBlock(st, me) {
  if (!st || !st.current) return { html: '', text: '' };
  const rows = [Object.assign({ now: true }, st.current)].concat((st.upcoming || []).filter((u) => !u.out)).slice(0, 5);
  const isMe = (r) => lc(r.name) === lc(me || '');
  const text = 'UP NEXT\n' + rows.map((r) => (r.now ? '> ' : '  ') + r.name + (isMe(r) ? ' (you)' : '') + ' — Rd ' + r.round + ' · #' + r.pick + (r.now ? ' (on the clock)' : '')).join('\n');
  const html = '<p style="margin:0 0 6px;font-size:12px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;color:#5d6b82">Up next</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;width:100%;max-width:420px">' +
    rows.map((r, i) => {
      const color = r.now ? '#D50032' : isMe(r) ? '#2b5d9b' : '#13213a';
      const weight = r.now || isMe(r) ? 'bold' : 'normal';
      const bg = isMe(r) ? 'background:#eaf1fb;' : '';
      const edge = isMe(r) ? 'border-left:4px solid ' + (r.now ? '#D50032' : '#2b5d9b') + ';' : 'border-left:4px solid transparent;';
      return '<tr><td style="' + bg + edge + 'padding:8px 10px;' + (i ? 'border-top:1px solid #e3e7ee;' : '') + 'color:' + color + ';font-weight:' + weight + '">' + escHtml(r.name) + (isMe(r) ? ' <span style="font-weight:normal;color:#5d6b82">(you)</span>' : '') + '</td>' +
        '<td style="' + bg + 'padding:8px 10px;' + (i ? 'border-top:1px solid #e3e7ee;' : '') + 'text-align:right;white-space:nowrap;font-size:13px;color:#5d6b82;font-weight:' + (r.now ? 'bold' : 'normal') + '">Rd ' + r.round + ' · #' + r.pick + '</td></tr>';
    }).join('') + '</table>';
  return { html, text };
}

/** Labeled sections for emails: [{ label, items: [..] }] → plain text and an HTML table, one item per line. */
function detailRows(rows) {
  const list = (rows || []).filter((r) => r && r.items && r.items.length);
  const text = list.map((r) => r.items.length === 1 ? r.label + ': ' + r.items[0] : r.label + ':\n' + r.items.map((i) => '  • ' + i).join('\n')).join('\n');
  const html = list.length ? '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px;width:100%;max-width:520px">' +
    list.map((r) => '<tr><td style="padding:10px 14px 10px 0;border-top:1px solid #e3e7ee;vertical-align:top;width:120px;font-size:12px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;color:#5d6b82">' + escHtml(r.label) + '</td>' +
      '<td style="padding:10px 0;border-top:1px solid #e3e7ee;vertical-align:top">' + r.items.map((i) => '<div style="margin:0 0 2px">' + escHtml(i) + '</div>').join('') + '</td></tr>').join('') +
    '</table>' : '';
  return { text, html };
}

async function deliver(p, msg) {
  const sent = [];
  const jobs = [];
  if (p.emailOn && p.email && mailer()) {
    const settings = siteLink('notifications');
    // Emails can have a short intro plus labeled sections; push always uses the one-line body.
    const d = detailRows(msg.rows);
    const intro = msg.rows ? (msg.intro || '') : msg.body;
    const button = msg.button || 'Open the draft';
    const swap = /^ticket-swap/.test(msg.tag || '');
    jobs.push(mailer().sendMail({
      from: '"Guardians Ticket Draft" <' + GMAIL_USER.value() + '>',
      to: [p.email, p.email2].filter(Boolean).join(', '),
      subject: (isTest() ? '[TEST] ' : '') + msg.subject,
      text: intro + (d.text ? '\n\n' + d.text : '') + (msg.extra ? '\n\n' + msg.extra.text : '') + '\n\n' + button + ': ' + msg.link + (swap ? '\n\n' + SWAP_HELP : '') + '\n\nChange your notification settings: ' + settings,
      html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#13213a">' +
        '<p style="font-size:18px;font-weight:bold;margin:0 0 8px">' + escHtml(msg.title) + '</p>' +
        (intro ? '<p style="margin:0 0 16px">' + escHtml(intro) + '</p>' : '') + d.html + (msg.extra ? msg.extra.html : '') +
        '<p style="margin:0 0 24px"><a href="' + msg.link + '" style="background:#D50032;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">' + escHtml(button) + '</a></p>' +
        (swap ? swapHelpHtml() : '') +
        '<p style="font-size:12px;color:#5d6b82;margin:0">Private draft page for our season ticket group. <a href="' + settings + '" style="color:#5d6b82">Change your notification settings</a>.</p></div>',
    }).then(() => sent.push('email')).catch((e) => console.error('email', e.message)));
  }
  const tokens = p.pushOn ? (p.tokens || []) : [];
  if (tokens.length) {
    jobs.push(admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: (isTest() ? '[TEST] ' : '') + msg.title, body: msg.body },
      data: { badge: msg.badge ? String(msg.badge) : '0' },
      webpush: { fcmOptions: { link: msg.link }, notification: { icon: SITE_URL.value() + (isTest() ? 'icon-192-test.png' : 'icon-192.png'), badge: SITE_URL.value() + (isTest() ? 'icon-192-test.png' : 'icon-192.png'), tag: msg.tag || 'draft-turn', renotify: true } },
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


/* ------------------------------------------------------------------ */
/* Ticket Swap: members list regular season games to trade away, and   */
/* other members send offers. A board only: agreed trades are marked    */
/* Fulfilled by the lister; draft records aren't changed.               */
/*                                                                      */
/*   swaps/{id}       listing (members can read it through the API)     */
/*   swapOffers/{id}  offer (only the lister and the offerer see it)    */
/* ------------------------------------------------------------------ */
const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** The regular season board: games by id, and who holds each one now. */
async function rsBoard() {
  const pub = (await db.doc('drafts/rs').get()).data() || {};
  const games = {};
  (pub.inventory || []).forEach((g) => { games[g.id] = g; });
  const holder = {};
  (pub.events || []).forEach((e) => { if ((e.type === 'pick' || e.type === 'assign') && e.itemId) holder[e.itemId] = e.member; });
  return { games, holder, members: (pub.members || []).map((m) => m.name) };
}
const gameLabel = (g) => (g ? (g.label || ((g.day ? g.day + ' ' : '') + String(g.date || '').slice(5).replace('-', '/') + ' vs ' + g.opponent)) : 'a game');
const upcoming = (g, today) => !!g && String(g.date || '') >= today;

function publicListing(id, x, today, games) {
  const live = (x.games || []).filter((gid) => upcoming(games[gid], today));
  return {
    id, member: x.member, games: x.games || [], liveGames: live, qty: x.qty, split: !!x.split,
    seekAny: !!x.seekAny, seek: x.seek || [], notify: { email: !!(x.notify && x.notify.email), push: !!(x.notify && x.notify.push) },
    status: x.status || 'open', createdAt: x.createdAt || '', updatedAt: x.updatedAt || '',
    offerCount: Number(x.offerCount) || 0, newOffers: Number(x.newOffers) || 0,
  };
}

async function swapPinOk(name, pin) {
  if (await commishPinOk(pin)) return true;
  return checkMemberPin('rs', name, pin);
}

async function swapAction(body) {
  const today = todayET();
  const name = String(body.name || '').trim();
  const pin = String(body.pin || '').trim();
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
  const ids = (a) => (Array.isArray(a) ? a.map((v) => str(v, 60)).filter(Boolean) : []);

  if (body.action === 'swapList') {
    const { games } = await rsBoard();
    const qs = await db.collection('swaps').get();
    const listings = qs.docs.map((d) => publicListing(d.id, d.data(), today, games))
      .filter((l) => l.status === 'open' && l.liveGames.length)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { ok: true, listings, today };
  }

  if (!name) return { ok: false, error: 'Choose your name.' };
  if (!(await swapPinOk(name, pin))) return { ok: false, error: 'That PIN doesn\'t match.' };
  const isCommish = await commishPinOk(pin);
  const board = await rsBoard();
  const prefsAll = ((await PREFS().get()).data() || {}).prefs || {};
  const prefsOf = (n) => prefsAll[lc(n)] || {};
  const link = siteLink('ticket-swap');
  const mine = (n) => Object.keys(board.holder).filter((gid) => lc(board.holder[gid]) === lc(n) && upcoming(board.games[gid], today));
  const realName = board.members.find((m) => lc(m) === lc(name)) || name;

  if (body.action === 'swapSave') {
    const L = body.listing || {};
    const ref = L.id ? db.collection('swaps').doc(str(L.id, 80)) : db.collection('swaps').doc();
    const old = L.id ? (await ref.get()).data() : null;
    if (L.id && !old) return { ok: false, error: 'That listing wasn\'t found.' };
    const owner = old ? old.member : realName;
    if (old && lc(old.member) !== lc(name) && !isCommish) return { ok: false, error: 'Only ' + old.member + ' (or the commissioner) can change this listing.' };
    const own = mine(owner);
    const away = ids(L.games);
    if (!away.length) return { ok: false, error: 'Choose at least one game to trade away.' };
    const bad = away.filter((gid) => !own.includes(gid) && !(old && (old.games || []).includes(gid)));
    if (bad.length) return { ok: false, error: gameLabel(board.games[bad[0]]) + ' isn\'t one of ' + owner + '\'s upcoming games.' };
    const qty = Number(L.qty) === 2 ? 2 : 4;
    const seekAny = !!L.seekAny;
    const seek = seekAny ? [] : ids(L.seek).filter((gid) => board.games[gid] && !away.includes(gid));
    const p = prefsOf(owner);
    const notify = { email: !!(L.notify && L.notify.email), push: !!(L.notify && L.notify.push) };
    if (notify.email && !(p.email || p.email2)) return { ok: false, error: 'Add your email address in Notification settings first, or untick email.' };
    if (notify.push && !(p.tokens || []).length) return { ok: false, error: 'Turn on push notifications for a device in Notification settings first, or untick push.' };
    const now = new Date().toISOString();
    const doc = Object.assign({}, old || { createdAt: now, offerCount: 0, newOffers: 0, status: 'open' }, {
      member: owner, games: away, qty, split: qty === 4 && !!L.split, seekAny, seek, notify, updatedAt: now,
    });
    await ref.set(doc);
    if (!old) await announceListing(ref.id, doc, board, prefsAll, link);
    return { ok: true, message: old ? 'Listing updated.' : 'Listing posted. Members have been emailed.', listing: publicListing(ref.id, doc, today, board.games) };
  }

  if (body.action === 'swapStatus') {
    const ref = db.collection('swaps').doc(str(body.id, 80));
    const x = (await ref.get()).data();
    if (!x) return { ok: false, error: 'That listing wasn\'t found.' };
    if (lc(x.member) !== lc(name) && !isCommish) return { ok: false, error: 'Only ' + x.member + ' (or the commissioner) can change this listing.' };
    const status = body.status === 'fulfilled' ? 'fulfilled' : body.status === 'removed' ? 'removed' : 'open';
    await ref.set(Object.assign({}, x, { status, updatedAt: new Date().toISOString() }));
    return { ok: true, message: status === 'fulfilled' ? 'Marked as fulfilled. Nice trade!' : status === 'removed' ? 'Listing removed.' : 'Listing reopened.' };
  }

  if (body.action === 'swapOffer') {
    const ref = db.collection('swaps').doc(str(body.id, 80));
    const x = (await ref.get()).data();
    if (!x || x.status !== 'open') return { ok: false, error: 'That listing isn\'t open anymore.' };
    if (lc(x.member) === lc(name)) return { ok: false, error: 'That\'s your own listing.' };
    const wants = ids(body.wants).filter((gid) => (x.games || []).includes(gid) && upcoming(board.games[gid], today));
    if (!wants.length) return { ok: false, error: 'Choose the game(s) you\'re interested in.' };
    const own = mine(realName);
    // Only games the lister asked for (when they named specific ones), or "Other" explained in the note.
    const seekOnly = !x.seekAny && (x.seek || []).length;
    const gives = ids(body.gives).filter((gid) => own.includes(gid) && (!seekOnly || x.seek.includes(gid)));
    const giveOther = !!body.giveOther;
    const qty = Number(body.qty) === 2 && (x.qty === 2 || x.split) ? 2 : x.qty === 2 ? 2 : 4;
    const note = str(body.note, 1000);
    if (!gives.length && !giveOther) return { ok: false, error: 'Choose what you\'d trade, or Other and explain in the note.' };
    if (giveOther && !note) return { ok: false, error: 'Add a note explaining your Other offer.' };
    const me = prefsOf(realName);
    const reply = { email: !!(body.notify && body.notify.email), push: !!(body.notify && body.notify.push) };
    if (reply.email && !(me.email || me.email2)) return { ok: false, error: 'Add your email address in Notification settings first, or untick email.' };
    if (reply.push && !(me.tokens || []).length) return { ok: false, error: 'Turn on push notifications for a device in Notification settings first, or untick push.' };
    const now = new Date().toISOString();
    const offer = { listingId: ref.id, from: realName, wants, gives, giveOther, qty, note, notify: reply, status: 'pending', createdAt: now, seen: false };
    await db.collection('swapOffers').doc().set(offer);
    await ref.set(Object.assign({}, x, { offerCount: (Number(x.offerCount) || 0) + 1, newOffers: (Number(x.newOffers) || 0) + 1 }));
    // Tell the lister the way they chose for this listing.
    const p = prefsOf(x.member);
    const via = { emailOn: !!(x.notify && x.notify.email), pushOn: !!(x.notify && x.notify.push), email: p.email || '', email2: p.email2 || '', tokens: p.tokens || [], name: x.member };
    const L = (list) => list.map((gid) => gameLabel(board.games[gid])).join(', ');
    const body2 = realName + ' is interested in ' + L(wants) + ' (' + qty + ' tickets)' +
      (gives.length || giveOther ? ' and offers ' + [gives.length ? L(gives) : '', giveOther ? 'something else (see note)' : ''].filter(Boolean).join(' or ') + ' in return.' : '.') + (note ? ' Note: "' + note + '"' : '');
    if (via.emailOn || via.pushOn) {
      const G = (list) => list.map((gid) => gameLabel(board.games[gid]));
      const contact = [me.email, me.email2, me.phone].filter(Boolean);
      await deliver(via, {
        subject: 'Guardians Ticket Swap offer from ' + realName, title: 'New Ticket Swap offer', body: body2, link, badge: 0, tag: 'ticket-swap', button: 'Accept or reject',
        intro: realName + ' made an offer on your listing.',
        rows: [
          { label: 'Interested in', items: G(wants) },
          { label: 'Tickets', items: [String(qty)] },
          { label: 'Offering', items: G(gives).concat(giveOther ? ['Other (see note)'] : []) },
          { label: 'Note', items: note ? [note] : [] },
          { label: 'Contact', items: contact },
        ],
      }).catch((e) => console.error('swap notify', e));
    }
    return { ok: true, message: 'Offer sent to ' + x.member + '.' };
  }

  if (body.action === 'swapOffers') {
    const ref = db.collection('swaps').doc(str(body.id, 80));
    const x = (await ref.get()).data();
    if (!x) return { ok: false, error: 'That listing wasn\'t found.' };
    if (lc(x.member) !== lc(name) && !isCommish) return { ok: false, error: 'Only ' + x.member + ' can see the offers on this listing.' };
    const qs = await db.collection('swapOffers').get();
    const offers = qs.docs.map((d) => Object.assign({ id: d.id }, d.data())).filter((o) => o.listingId === ref.id)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((o) => Object.assign({}, o, { email: prefsOf(o.from).email || '', email2: prefsOf(o.from).email2 || '', phone: prefsOf(o.from).phone || '' }));
    if (lc(x.member) === lc(name) && Number(x.newOffers)) {
      await ref.set(Object.assign({}, x, { newOffers: 0 }));
      await Promise.all(qs.docs.filter((d) => d.data().listingId === ref.id && !d.data().seen).map((d) => d.ref.set(Object.assign({}, d.data(), { seen: true }))));
    }
    return { ok: true, offers };
  }

  if (body.action === 'swapRespond') {
    // The lister accepts or rejects an offer; the offerer hears back the way they chose.
    const oref = db.collection('swapOffers').doc(str(body.offerId, 80));
    const o = (await oref.get()).data();
    if (!o) return { ok: false, error: 'That offer wasn\'t found.' };
    const ref = db.collection('swaps').doc(o.listingId);
    const x = (await ref.get()).data();
    if (!x) return { ok: false, error: 'That listing wasn\'t found.' };
    if (lc(x.member) !== lc(name) && !isCommish) return { ok: false, error: 'Only ' + x.member + ' can answer offers on this listing.' };
    if ((o.status || 'pending') !== 'pending') return { ok: false, error: 'You already ' + o.status + ' that offer.' };
    const accept = body.decision === 'accept';
    const now = new Date().toISOString();
    await oref.set(Object.assign({}, o, { status: accept ? 'accepted' : 'rejected', respondedAt: now, seen: true }));
    const L = (list) => list.map((gid) => gameLabel(board.games[gid])).join(', ');
    const n = o.notify || {};
    let message = (accept ? 'Offer accepted. ' : 'Offer rejected. ') + (n.email || n.push ? o.from + ' has been told.' : o.from + ' didn\'t turn on alerts, so let them know yourself.');
    let closed = false;
    if (accept) {
      // Accepted games come off the listing; when none are left, the listing is fulfilled.
      const left = (x.games || []).filter((gid) => !(o.wants || []).includes(gid));
      const liveLeft = left.filter((gid) => upcoming(board.games[gid], today));
      closed = !liveLeft.length;
      await ref.set(Object.assign({}, x, { games: left.length ? left : x.games, status: closed ? 'fulfilled' : x.status, updatedAt: now }));
      message += closed ? ' Your listing is now marked fulfilled.' : ' ' + L(o.wants) + (o.wants.length === 1 ? ' is' : ' are') + ' off your listing; the rest stay listed.';
      // Other open offers for any of those games can't happen now: reject them and let those members know.
      const qs = await db.collection('swapOffers').get();
      const others = qs.docs.filter((d) => {
        const y = d.data();
        return d.id !== oref.id && y.listingId === o.listingId && (y.status || 'pending') === 'pending' &&
          (closed || (y.wants || []).some((gid) => (o.wants || []).includes(gid)));
      });
      for (const d of others) {
        const y = d.data();
        await d.ref.set(Object.assign({}, y, { status: 'rejected', autoRejected: true, respondedAt: now, seen: true }));
        const yn = y.notify || {};
        if (yn.email || yn.push) {
          const yp = prefsOf(y.from);
          await deliver({ emailOn: !!yn.email, pushOn: !!yn.push, email: yp.email || '', email2: yp.email2 || '', tokens: yp.tokens || [], name: y.from },
            { subject: 'Guardians Ticket Swap: ' + x.member + ' traded with someone else', title: 'Offer not accepted', body: x.member + ' accepted another offer, so your offer for ' + L(y.wants || []) + ' is closed.', link, badge: 0, tag: 'ticket-swap-reply', button: 'Open Ticket Swap',
              intro: x.member + ' accepted another offer, so yours is closed.',
              rows: [{ label: 'Your offer', items: (y.wants || []).map((gid) => gameLabel(board.games[gid])) }, { label: 'Tickets', items: [String(y.qty)] }] }).catch((e) => console.error('swap auto-reject', e));
        }
      }
      if (others.length) message += ' ' + others.length + ' other offer' + (others.length === 1 ? ' for the same game' + (o.wants.length === 1 ? '' : 's') + ' was' : 's for the same game' + (o.wants.length === 1 ? '' : 's') + ' were') + ' rejected automatically.';
    }
    const p = prefsOf(o.from);
    const via = { emailOn: !!n.email, pushOn: !!n.push, email: p.email || '', email2: p.email2 || '', tokens: p.tokens || [], name: o.from };
    if (via.emailOn || via.pushOn) {
      const lp = prefsOf(x.member);
      const contact = [[lp.email, lp.email2].filter(Boolean)[0], lp.phone].filter(Boolean).join(' or ');
      const text = accept
        ? x.member + ' accepted your offer for ' + L(o.wants) + ' (' + o.qty + ' tickets).' + (contact ? ' Reach out at ' + contact + ' to swap tickets.' : ' Reach out to swap tickets.')
        : x.member + ' passed on your offer for ' + L(o.wants) + '.';
      const G = (list) => list.map((gid) => gameLabel(board.games[gid]));
      await deliver(via, {
        subject: 'Guardians Ticket Swap: ' + x.member + (accept ? ' accepted your offer' : ' passed on your offer'), title: accept ? 'Offer accepted' : 'Offer not accepted', body: text, link, badge: 0, tag: 'ticket-swap-reply', button: 'Open Ticket Swap',
        intro: accept ? x.member + ' accepted your offer. Reach out to arrange the swap.' : x.member + ' passed on your offer.',
        rows: [
          { label: 'You get', items: accept ? G(o.wants || []) : [] },
          { label: 'Your offer', items: accept ? [] : G(o.wants || []) },
          { label: 'Tickets', items: [String(o.qty)] },
          { label: 'You give', items: G(o.gives || []).concat(o.giveOther ? ['Other (from your note)'] : []) },
          { label: 'Contact', items: accept ? [lp.email, lp.email2, lp.phone].filter(Boolean) : [] },
        ],
      }).catch((e) => console.error('swap reply', e));
    }
    return { ok: true, message, closed };
  }

  if (body.action === 'swapMine') {
    // The games this member holds (upcoming), for the listing and offer forms.
    return { ok: true, games: mine(realName), email: !!(prefsOf(realName).email || prefsOf(realName).email2), push: (prefsOf(realName).tokens || []).length > 0 };
  }
  return { ok: false, error: 'Unknown action.' };
}

/** Email every member with an address (unless they turned Ticket Swap emails off) about a new listing. */
async function announceListing(id, x, board, prefsAll, link) {
  if (!mailer()) return;
  const L = (list) => list.map((gid) => gameLabel(board.games[gid])).join(', ');
  const to = new Set();
  const names = new Set(board.members.map(lc));
  const post = (await db.doc('drafts/post').get()).data() || {};
  (post.members || []).forEach((m) => names.add(lc(m.name)));
  names.forEach((n) => {
    if (n === lc(x.member)) return;
    const p = prefsAll[n];
    if (!p || p.swapEmails === false) return;
    [p.email, p.email2].filter(Boolean).forEach((e) => to.add(e));
  });
  if (!to.size) return;
  const G = (list) => list.map((gid) => gameLabel(board.games[gid]));
  const intro = x.member + ' posted a new Ticket Swap listing.';
  const d = detailRows([
    { label: 'Trading away', items: G(x.games) },
    { label: 'Tickets', items: [x.qty + (x.split ? ' (will split into 2)' : '')] },
    { label: 'Looking for', items: x.seekAny || !(x.seek || []).length ? ['Any game'] : G(x.seek) },
  ]);
  const settings = siteLink('notifications');
  await mailer().sendMail({
    from: '"Guardians Ticket Draft" <' + GMAIL_USER.value() + '>',
    to: '"Guardians Ticket Draft" <' + GMAIL_USER.value() + '>',
    bcc: Array.from(to).join(', '),
    subject: (isTest() ? '[TEST] ' : '') + 'Guardians Ticket Swap: ' + x.member + ' posted ' + (x.games.length === 1 ? gameLabel(board.games[x.games[0]]) : x.games.length + ' games'),
    text: intro + '\n\n' + d.text + '\n\nSee it or make an offer: ' + link + '\n\n' + SWAP_HELP + '\n\nStop these emails: ' + settings,
    html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#13213a">' +
      '<p style="font-size:18px;font-weight:bold;margin:0 0 8px">New Ticket Swap listing</p>' +
      '<p style="margin:0 0 16px">' + escHtml(intro) + '</p>' + d.html +
      '<p style="margin:0 0 24px"><a href="' + link + '" style="background:#D50032;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Make an offer</a></p>' +
      swapHelpHtml() +
      '<p style="font-size:12px;color:#5d6b82;margin:0">Private page for our season ticket group. <a href="' + settings + '" style="color:#5d6b82">Turn off Ticket Swap emails</a>.</p></div>',
  }).catch((e) => console.error('swap announce', e.message));
}


/* ------------------------------------------------------------------ */
/* "Email members their games" (Commissioner tools, after a draft).    */
/* Each member gets their own email listing the games they hold, with  */
/* an optional calendar file (.ics) and PDF. Commissioner PIN only.    */
/*                                                                      */
/*   op 'info'    → members, addresses, game counts, last sent          */
/*   op 'preview' → the email for one member (HTML), and its PDF        */
/*   op 'send'    → sends to the chosen members                         */
/* ------------------------------------------------------------------ */
const MAIL_LOG = (key) => db.doc('notify/gamesmail-' + key);
const BALLPARK = 'Progressive Field, 2401 Ontario St, Cleveland, OH 44115';
const DOWS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isoDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : '';
const dateParts = (d) => { const m = isoDate(d); if (!m) return null; const [y, mo, da] = m.split('-').map(Number); return { y, mo, da, dow: new Date(Date.UTC(y, mo - 1, da)).getUTCDay() }; };
const niceDate = (d) => { const p = dateParts(d); return p ? DOWS[p.dow].slice(0, 3) + ', ' + MONS[p.mo - 1] + ' ' + p.da : (String(d || '').trim() || 'Date TBD'); };
const niceTime = (t) => (t && !/^tbd$/i.test(String(t).trim()) ? String(t).trim() + ' ET' : 'Time TBD');
function parseTime(t) {
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12; if (/p/i.test(m[3])) h += 12;
  return { h, mi: Number(m[2]) };
}

function mailDefaults(key, pub) {
  const s = pub.settings || {};
  if (key === 'rs') {
    const season = s.season || '';
    return { subject: 'Your ' + (season ? season + ' ' : '') + 'Guardians games', message: 'Here are the games you have from our ' + (season ? season + ' ' : '') + 'regular season draft.' };
  }
  return { subject: 'Your Guardians postseason tickets', message: 'Here are the postseason games and seats you have from our draft.' };
}

/** Each member's games, in date order. */
function heldGames(key, pub) {
  const inv = {};
  (pub.inventory || []).forEach((g) => { inv[g.id] = g; });
  const by = {};
  (pub.events || []).forEach((e) => {
    if ((e.type === 'pick' || e.type === 'assign') && e.itemId && inv[e.itemId]) (by[lc(e.member)] = by[lc(e.member)] || []).push(inv[e.itemId]);
  });
  const order = (g) => (isoDate(g.date) || '9999') + ' ' + String(g.series || '') + ' ' + String(g.game || '') + ' ' + String(g.id);
  Object.keys(by).forEach((k) => by[k].sort((a, b) => order(a).localeCompare(order(b))));
  return by;
}

function gameRow(key, g) {
  if (key === 'rs') return { date: niceDate(g.date), what: 'vs ' + (g.opponent || 'TBD'), time: niceTime(g.time), seats: '' };
  return { date: niceDate(g.date), what: [g.series, g.game].filter(Boolean).join(' · ') + (g.opponent ? ' vs ' + g.opponent : ''), time: g.time ? niceTime(g.time) : '', seats: g.seats ? 'Seats ' + g.seats : '' };
}

function gamesEmail(key, pub, name, greet, message, games, attach) {
  const s = pub.settings || {};
  const rs = key === 'rs';
  const title = rs ? 'Your ' + (s.season ? s.season + ' ' : '') + 'Guardians games' : 'Your Guardians postseason tickets';
  const count = games.length + ' ' + (rs ? 'home game' : 'game') + (games.length === 1 ? '' : 's') + (rs ? ' · all four tickets for each' : '');
  const rows = games.map((g) => gameRow(key, g));
  const paras = String(message || '').trim().split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const th = 'padding:8px 10px;text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#5d6b82;border-bottom:2px solid #0C2340';
  const td = (i) => 'padding:9px 10px;border-bottom:1px solid #e3e7ee;vertical-align:top;' + (i % 2 ? 'background:#f6f8fb;' : '');
  const table = rows.length
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:560px;margin:0 0 18px;font-size:14px">' +
      '<tr><th style="' + th + '">Date</th><th style="' + th + '">' + (rs ? 'Opponent' : 'Game') + '</th>' + (rs || rows.some((r) => r.time) ? '<th style="' + th + '">Time</th>' : '') + (rs ? '' : '<th style="' + th + '">Seats</th>') + '</tr>' +
      rows.map((r, i) => '<tr><td style="' + td(i) + 'white-space:nowrap;font-weight:bold">' + escHtml(r.date) + '</td><td style="' + td(i) + '">' + escHtml(r.what) + '</td>' +
        (rs || rows.some((x) => x.time) ? '<td style="' + td(i) + 'white-space:nowrap;color:#5d6b82">' + escHtml(r.time) + '</td>' : '') + (rs ? '' : '<td style="' + td(i) + 'white-space:nowrap">' + escHtml(r.seats) + '</td>') + '</tr>').join('') +
      '</table>'
    : '<p style="margin:0 0 18px;color:#5d6b82">You don\'t have any games in this draft.</p>';
  const files = [attach.ics && games.some((g) => dateParts(g.date)) ? 'a calendar file that adds every game to your phone or computer calendar' : '', attach.pdf && games.length ? 'a PDF you can print' : ''].filter(Boolean);
  const filesLine = files.length ? 'Attached: ' + files.join(', and ') + '.' : '';
  const link = siteLink(rs ? 'regular-season' : 'postseason');
  const swapLink = siteLink('ticket-swap');
  const swapLine = rs && games.length ? 'Can\'t make one of your games? Post it on Ticket Swap to trade with another member.' : '';
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#13213a">' +
    '<p style="font-size:18px;font-weight:bold;margin:0 0 4px">' + escHtml(title) + '</p>' +
    '<p style="margin:0 0 16px;font-size:13px;color:#5d6b82">' + escHtml(count) + '</p>' +
    '<p style="margin:0 0 12px">Hi, ' + escHtml(greet) + '.</p>' +
    paras.map((x) => '<p style="margin:0 0 12px">' + escHtml(x).replace(/\n/g, '<br>') + '</p>').join('') +
    table +
    (filesLine ? '<p style="margin:0 0 12px;font-size:14px;color:#5d6b82">' + escHtml(filesLine) + '</p>' : '') +
    (swapLine ? '<p style="margin:0 0 18px;font-size:14px">' + escHtml(swapLine).replace('Ticket Swap', '<b>Ticket Swap</b>') + '</p>' : '') +
    '<p style="margin:0 0 24px"><a href="' + (rs ? swapLink : link) + '" style="background:#D50032;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">' + (rs ? 'Open the Ticket Swap' : 'Open the draft') + '</a></p>' +
    '<p style="font-size:14px;color:#13213a;margin:0 0 12px;padding-top:14px;border-top:1px solid #e3e7ee">Questions or something look wrong? Just reply to this email.</p>' +
    '<p style="font-size:12px;color:#5d6b82;margin:0">Private draft page for our season ticket group.</p></div>';
  const text = title + '\n' + count + '\n\nHi, ' + greet + '.\n\n' + (paras.length ? paras.join('\n\n') + '\n\n' : '') +
    (rows.length ? rows.map((r) => '• ' + r.date + ' — ' + r.what + (r.time ? ' — ' + r.time : '') + (r.seats ? ' — ' + r.seats : '')).join('\n') : 'You don\'t have any games in this draft.') +
    (filesLine ? '\n\n' + filesLine : '') + (swapLine ? '\n\n' + swapLine : '') + (rs ? '\n\nOpen the Ticket Swap: ' + swapLink : '\n\nOpen the draft: ' + link) + '\n\nQuestions or something look wrong? Just reply to this email.';
  return { title, html, text };
}

/** Calendar file: one event per game with a known date. Times are Cleveland time; TBD times are all-day. */
function gamesIcs(key, pub, name, games) {
  const esc = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const fold = (line) => { const out = []; let l = line; while (l.length > 74) { out.push(l.slice(0, 74)); l = ' ' + l.slice(74); } out.push(l); return out.join('\r\n'); };
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Guardians Ticket Draft//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Guardians games',
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE'];
  let n = 0;
  games.forEach((g) => {
    const p = dateParts(g.date);
    if (!p) return;
    n++;
    const ymd = p.y + pad(p.mo) + pad(p.da);
    const t = parseTime(g.time);
    const what = key === 'rs' ? 'Guardians vs ' + (g.opponent || 'TBD') : 'Guardians ' + [g.series, g.game].filter(Boolean).join(' ') + (g.opponent ? ' vs ' + g.opponent : '');
    const desc = (key === 'rs' ? 'Your game from the ticket draft (all four tickets).' : 'Your seats: ' + (g.seats || '')) + (t ? '' : ' Start time TBD.') + ' Times can change; check mlb.com/guardians.';
    lines.push('BEGIN:VEVENT', 'UID:' + String(g.id).replace(/[^\w.-]/g, '') + '-' + key + '@guardians-ticket-draft', 'DTSTAMP:' + stamp);
    if (t) {
      const end = new Date(Date.UTC(p.y, p.mo - 1, p.da, t.h + 3, t.mi));
      lines.push('DTSTART;TZID=America/New_York:' + ymd + 'T' + pad(t.h) + pad(t.mi) + '00',
        'DTEND;TZID=America/New_York:' + end.getUTCFullYear() + pad(end.getUTCMonth() + 1) + pad(end.getUTCDate()) + 'T' + pad(end.getUTCHours()) + pad(end.getUTCMinutes()) + '00');
    } else {
      const nx = new Date(Date.UTC(p.y, p.mo - 1, p.da + 1));
      lines.push('DTSTART;VALUE=DATE:' + ymd, 'DTEND;VALUE=DATE:' + nx.getUTCFullYear() + pad(nx.getUTCMonth() + 1) + pad(nx.getUTCDate()));
    }
    lines.push('SUMMARY:' + esc(what), 'LOCATION:' + esc(BALLPARK), 'DESCRIPTION:' + esc(desc), 'TRANSP:TRANSPARENT', 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return n ? lines.map(fold).join('\r\n') + '\r\n' : '';
}

/** One-page (or more) PDF of a member's games, styled like the Season Ticket Manager statements. */
function gamesPdf(key, pub, name, games) {
  const PDFDocument = require('pdfkit');
  const s = pub.settings || {};
  const rs = key === 'rs';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0, info: { Title: name + ' - Guardians games', Author: 'Guardians Ticket Draft' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = 612, H = 792, M = 44, NAVY = '#0C2340', RED = '#D50032', INK = '#17202b', MUTED = '#646e7d', LINE = '#dee2e8', TINT = '#f5f7fa';
    const clean = (t) => String(t == null ? '' : t).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E\u00A0-\u00FF–—•·]/g, '');
    const today = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
    let page = 1;
    const header = () => {
      doc.rect(0, 0, W, 54).fill(NAVY); doc.rect(0, 54, W, 3).fill(RED);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(16).text('Guardians Season Tickets', M, 18, { lineBreak: false });
      doc.font('Helvetica').fontSize(8.5).text(clean(rs ? (s.season ? s.season + ' regular season' : 'Regular season') : 'Postseason'), M, 37, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9).text(rs ? 'YOUR GAMES' : 'YOUR TICKETS', W - M - 200, 18, { width: 200, align: 'right' });
      doc.font('Helvetica').fontSize(8.5).text(today, W - M - 200, 37, { width: 200, align: 'right' });
    };
    const footer = () => {
      doc.moveTo(M, H - 34).lineTo(W - M, H - 34).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text('From our ticket draft. Game times can change; check mlb.com/guardians.', M, H - 26, { lineBreak: false });
      doc.text('Page ' + page, W - M - 100, H - 26, { width: 100, align: 'right' });
    };
    header();
    let y = 78;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(clean(name), M, y, { lineBreak: false });
    y += 26;
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5).text(clean(games.length + (rs ? ' home game' : ' game') + (games.length === 1 ? '' : 's') + (rs ? '  ·  all four tickets for each game' : '')), M, y, { lineBreak: false });
    y += 26;
    const cols = rs ? [{ t: 'Date', x: M + 10, w: 150 }, { t: 'Opponent', x: M + 170, w: 250 }, { t: 'Time', x: M + 430, w: 94 }]
      : [{ t: 'Date', x: M + 10, w: 110 }, { t: 'Game', x: M + 130, w: 250 }, { t: 'Time', x: M + 390, w: 70 }, { t: 'Seats', x: M + 465, w: 59 }];
    const head = () => {
      cols.forEach((c) => doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text(c.t.toUpperCase(), c.x, y, { width: c.w, lineBreak: false }));
      y += 13; doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1.5).strokeColor(NAVY).stroke(); y += 1;
    };
    head();
    const RH = 24;
    games.forEach((g, i) => {
      if (y + RH > H - 50) { footer(); doc.addPage(); page++; header(); y = 78; head(); }
      const r = gameRow(key, g);
      if (i % 2) doc.rect(M, y, W - 2 * M, RH).fill(TINT);
      const vals = rs ? [r.date, r.what, r.time] : [r.date, r.what, r.time, (g.seats || '')];
      cols.forEach((c, ci) => doc.fillColor(ci === 0 ? INK : ci === cols.length - 1 && rs ? MUTED : INK).font(ci === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(10)
        .text(clean(vals[ci]), c.x, y + 7, { width: c.w, lineBreak: false, ellipsis: true }));
      y += RH; doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.5).strokeColor(LINE).stroke();
    });
    if (!games.length) doc.fillColor(MUTED).font('Helvetica').fontSize(10).text('No games in this draft.', M + 10, y + 10);
    footer();
    doc.end();
  });
}

async function gamesMail(key, body) {
  if (!(await commishPinOk(body.pin))) return { ok: false, error: 'That commissioner PIN doesn\'t match.' };
  const pub = (await db.doc('drafts/' + key).get()).data();
  if (!pub) return { ok: false, error: 'This draft isn\'t set up yet.' };
  const prefs = ((await PREFS().get()).data() || {}).prefs || {};
  const log = (await MAIL_LOG(key).get()).data() || {};
  const held = heldGames(key, pub);
  const names = (pub.members || []).map((m) => m.name).filter(Boolean);
  const emailsOf = (n) => { const p = prefs[lc(n)] || {}; return [p.email, p.email2].filter(Boolean); };
  const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
  const def = mailDefaults(key, pub);
  const op = body.op || 'info';
  if (op === 'info') {
    return { ok: true, emailReady: !!mailer(), subject: log.subject || def.subject, message: log.message != null ? log.message : def.message,
      members: names.map((n) => ({ name: n, emails: emailsOf(n), games: (held[lc(n)] || []).length, lastSent: (log.sent || {})[lc(n)] || '', greet: (log.greet || {})[lc(n)] || first(n) })) };
  }
  const subject = String(body.subject || def.subject).trim().slice(0, 200);
  const message = String(body.message == null ? def.message : body.message).slice(0, 4000);
  const attach = { ics: body.ics !== false, pdf: body.pdf !== false };
  const greetOf = (n) => String((body.greet || {})[n] || first(n)).trim().slice(0, 60) || first(n);
  if (op === 'preview') {
    const n = names.find((x) => lc(x) === lc(body.name));
    if (!n) return { ok: false, error: 'Choose a member.' };
    const games = held[lc(n)] || [];
    const e = gamesEmail(key, pub, n, greetOf(n), message, games, attach);
    const out = { ok: true, name: n, to: emailsOf(n), subject: (isTest() ? '[TEST] ' : '') + subject, html: e.html, games: games.length,
      files: [attach.ics && games.some((g) => dateParts(g.date)) ? fileBase(n, key) + '.ics' : '', attach.pdf && games.length ? fileBase(n, key) + '.pdf' : ''].filter(Boolean) };
    if (body.withPdf) out.pdf = (await gamesPdf(key, pub, n, games)).toString('base64');
    return out;
  }
  if (op === 'send') {
    if (!mailer()) return { ok: false, error: 'Email isn\'t set up for the draft yet (GMAIL_USER and the app password).' };
    const want = (Array.isArray(body.names) ? body.names : []).map((x) => names.find((n) => lc(n) === lc(x))).filter(Boolean);
    if (!want.length) return { ok: false, error: 'Choose at least one member.' };
    const results = [];
    const sentAt = new Date().toISOString();
    for (const n of want) {
      const to = emailsOf(n);
      if (!to.length) { results.push({ name: n, ok: false, error: 'No email address' }); continue; }
      const games = held[lc(n)] || [];
      const e = gamesEmail(key, pub, n, greetOf(n), message, games, attach);
      const attachments = [];
      try {
        if (attach.ics && games.length) { const ics = gamesIcs(key, pub, n, games); if (ics) attachments.push({ filename: fileBase(n, key) + '.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }); }
        if (attach.pdf && games.length) attachments.push({ filename: fileBase(n, key) + '.pdf', content: await gamesPdf(key, pub, n, games), contentType: 'application/pdf' });
        await mailer().sendMail({
          from: '"Guardians Ticket Draft" <' + GMAIL_USER.value() + '>',
          to: to.join(', '),
          subject: (isTest() ? '[TEST] ' : '') + subject,
          text: e.text, html: e.html, attachments,
        });
        results.push({ name: n, ok: true, to });
      } catch (err) {
        console.error('gamesMail', n, err.message);
        results.push({ name: n, ok: false, error: 'Couldn\'t send' });
      }
    }
    const sentMap = Object.assign({}, log.sent || {});
    const greetMap = Object.assign({}, log.greet || {});
    results.filter((r) => r.ok).forEach((r) => { sentMap[lc(r.name)] = sentAt; });
    want.forEach((n) => { if (greetOf(n) !== first(n)) greetMap[lc(n)] = greetOf(n); else delete greetMap[lc(n)]; });
    await MAIL_LOG(key).set({ subject, message, sent: sentMap, greet: greetMap, lastAt: sentAt });
    const okN = results.filter((r) => r.ok).length;
    return { ok: true, results, message: 'Sent ' + okN + ' email' + (okN === 1 ? '' : 's') + (okN < results.length ? '; ' + (results.length - okN) + ' couldn\'t be sent.' : '.') };
  }
  return { ok: false, error: 'Unknown request.' };
}

const fileBase = (n, key) => (String(n).replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') + (key === 'rs' ? '-Guardians-games' : '-Guardians-postseason'));


/* ------------------------------------------------------------------ */
/* Test mode data                                                       */
/* ------------------------------------------------------------------ */
function siteLink(hash) {
  return SITE_URL.value() + (isTest() ? '?test' : '') + (hash ? '#' + hash : '');
}

/** First visit in test mode: load the test drafts (2026 ticket holders, shifted to 2027 dates). */
let testChecked = false;
async function ensureTestData() {
  if (testChecked) return;
  const snap = await db.doc('drafts/rs').get();
  if (!snap.exists) await writeImport(require('./testdata.json'));
  testChecked = true;
}

/** Setup → Regular Season → Reset test data (test mode only, commissioner PIN). */
async function testReset(body) {
  if (!isTest()) return { ok: false, error: 'This only works in test mode.' };
  if (!(await commishPinOk(body.pin))) return { ok: false, error: 'That commissioner PIN doesn\'t match.' };
  for (const c of ['swaps', 'swapOffers', 'archives']) {
    const qs = await db.collection(c).get();
    await Promise.all(qs.docs.map((d) => d.ref.delete()));
  }
  await Promise.all(['notify/log-rs', 'notify/log-post'].map((p) => db.doc(p).delete().catch(() => {})));
  testChecked = false;
  const r = await writeImport(require('./testdata.json'));
  testChecked = true;
  return r.ok ? { ok: true, message: 'Test data reset: drafts reloaded and Ticket Swap cleared. Notification settings were kept.' } : r;
}
