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

let appPromise = null;
function firebaseApp() {
  if (!appPromise) appPromise = import(SDK + 'firebase-app.js').then((m) => (m.getApps().length ? m.getApp() : m.initializeApp(cfg)));
  return appPromise;
}

if (cfg && cfg.projectId && window.DraftApp && window.DraftEngine) {
  start().catch((e) => console.warn('Live updates unavailable; using refresh instead.', e));
}

async function start() {
  const { getFirestore, doc, onSnapshot } = await import(SDK + 'firebase-firestore.js');
  const db = getFirestore(await firebaseApp());
  let unsub = null;
  let watching = null;

  function watch(draft) {
    if (draft === watching) return;
    if (unsub) { unsub(); unsub = null; }
    watching = draft;
    if (draft !== 'post' && draft !== 'rs') return;
    unsub = onSnapshot(doc(db, 'drafts', draft + (window.DRAFT_TEST ? '-test' : '')), (snap) => {
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
      open: s.open !== false, showTab: s.showTab !== false, timeLimitOn: !!s.timeLimitOn, timeLimitHours: Number(s.timeLimitHours) || 0, commissionerPin: '',
      juniorOn: !!s.juniorOn, juniorRounds: s.juniorRounds || {},
    },
    // The page never sees PINs, only whether a member has one.
    members: (pub.members || []).map((m) => ({ name: m.name, order: m.order, cap: Number(m.cap) || 0, pin: m.needsPin ? '•' : '', inactive: !!m.inactive, juniorOf: m.juniorOf || '' })),
    inventory: pub.inventory || [],
    events: (pub.events || []).map((e, i) => Object.assign({}, e, { row: i + 2 })),
  };
  if (key === 'rs') data.order = pub.order || [];
  const st = window.DraftEngine.publicState(data);
  if (pub.mlbCheck) st.mlbCheck = pub.mlbCheck;
  return st;
}

/* ------------------------------------------------------------------ */
/* Push notifications (Firebase Cloud Messaging)                        */
/* ------------------------------------------------------------------ */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

let msgPromise = null;
function messaging() {
  if (!msgPromise) {
    msgPromise = (async () => {
      const m = await import(SDK + 'firebase-messaging.js');
      if (!(await m.isSupported())) return null;
      const inst = m.getMessaging(await firebaseApp());
      m.onMessage(inst, (payload) => {
        // The page is open: show it in the page (and as a notification if the tab isn't in front).
        const n = payload.notification || {};
        if (window.DraftApp && window.DraftApp.toast) window.DraftApp.toast((n.title ? n.title + ' ' : '') + (n.body || ''));
        if (document.hidden && 'serviceWorker' in navigator) {
          navigator.serviceWorker.ready.then((reg) => reg.showNotification(n.title || 'Ticket draft', { body: n.body || '', icon: 'icon-192.png', tag: 'draft-turn' })).catch(() => {});
        }
      });
      return { m, inst };
    })().catch((e) => { console.warn('Push unavailable', e); return null; });
  }
  return msgPromise;
}

async function swReg() {
  await navigator.serviceWorker.register('firebase-messaging-sw.js', { scope: './' });
  return navigator.serviceWorker.ready;
}

window.DraftPush = {
  /** 'off' (no Firebase / VAPID key) | 'unsupported' | 'ios-install' | 'denied' | 'default' | 'granted' */
  async status() {
    if (!cfg || !cfg.projectId || !window.FIREBASE_VAPID_KEY) return 'off';
    if (isIOS && !isStandalone()) return 'ios-install';
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'unsupported';
    if (!(await messaging())) return 'unsupported';
    return Notification.permission;
  },
  /** Ask permission (call from a tap) and return this device's push token. */
  async enable() {
    // Ask first, while we still have the tap (iPhone requires that).
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'denied' : 'dismissed');
    const ms = await messaging();
    if (!ms) throw new Error('unsupported');
    return ms.m.getToken(ms.inst, { vapidKey: window.FIREBASE_VAPID_KEY, serviceWorkerRegistration: await swReg() });
  },
  /** Current token without prompting (null if permission isn't granted). */
  async current() {
    if ((await this.status()) !== 'granted') return null;
    const ms = await messaging();
    return ms.m.getToken(ms.inst, { vapidKey: window.FIREBASE_VAPID_KEY, serviceWorkerRegistration: await swReg() });
  },
  async disable() {
    const ms = await messaging();
    if (ms) { try { await ms.m.deleteToken(ms.inst); } catch (e) { /* already gone */ } }
  },
};
