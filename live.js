/*
 * Live board updates from Firebase (Firestore).
 *
 * When config.js has window.FIREBASE_CONFIG, this listens to drafts/{post|rs}
 * and hands every change to the page immediately: no polling and no waiting for
 * a server to wake up. Picks and other changes still go through the Cloud
 * Function in DRAFT_API_URL, which enforces PINs and turn order.
 *
 * Without FIREBASE_CONFIG this file does nothing (the Google Sheet setup keeps
 * working as before).
 */
const cfg = window.FIREBASE_CONFIG;
const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';

if (cfg && cfg.projectId && window.DraftApp && window.DraftEngine) {
  start().catch((e) => console.warn('Live updates unavailable; using refresh instead.', e));
}

async function start() {
  const { initializeApp } = await import(SDK + 'firebase-app.js');
  const { getFirestore, doc, onSnapshot } = await import(SDK + 'firebase-firestore.js');
  const db = getFirestore(initializeApp(cfg));
  let unsub = null;
  let watching = null;

  function watch(draft) {
    if (draft === watching) return;
    if (unsub) { unsub(); unsub = null; }
    watching = draft;
    if (draft !== 'post' && draft !== 'rs') return;
    unsub = onSnapshot(doc(db, 'drafts', draft), (snap) => {
      if (!snap.exists()) { window.DraftApp.onLive(draft, { ok: false, notSetUp: true, kind: draft }); return; }
      window.DraftApp.onLive(draft, toState(draft, snap.data()));
    }, (err) => {
      console.warn('Live updates stopped; using refresh instead.', err);
      window.DraftApp.liveOff(draft);
    });
  }

  window.DraftLive = { watch };
  watch(window.DraftApp.currentView());
}

/* Same shape the Cloud Function / Apps Script returns, built with the shared engine. */
function toState(key, pub) {
  const s = pub.settings || {};
  const data = {
    settings: {
      kind: key, title: s.title, season: s.season, snake: s.snake !== false, maxPicks: Number(s.maxPicks) || 0,
      open: s.open !== false, timeLimitOn: !!s.timeLimitOn, timeLimitHours: Number(s.timeLimitHours) || 0, commissionerPin: '',
    },
    // The page never sees PINs, only whether a member has one.
    members: (pub.members || []).map((m) => ({ name: m.name, order: m.order, cap: Number(m.cap) || 0, pin: m.needsPin ? '•' : '' })),
    inventory: pub.inventory || [],
    events: (pub.events || []).map((e, i) => Object.assign({}, e, { row: i + 2 })),
  };
  if (key === 'rs') data.order = pub.order || [];
  return window.DraftEngine.publicState(data);
}
