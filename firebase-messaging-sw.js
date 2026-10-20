/*
 * Service worker for push notifications (Firebase Cloud Messaging).
 * It shows "you're on the clock" messages when the draft page isn't open,
 * and opens the draft when one is tapped. It reads the Firebase settings from config.js.
 */
self.window = self;

// Put a "1" on the Home Screen icon when a message says it's this member's turn.
// The page clears it once they've picked (or it's no longer their turn).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {}; }
  const badge = Number((d.data && d.data.badge) || 0);
  if (badge && self.navigator.setAppBadge) e.waitUntil(self.navigator.setAppBadge(badge).catch(() => {}));
});

importScripts('config.js');
importScripts(
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js'
);
firebase.initializeApp(self.FIREBASE_CONFIG);
firebase.messaging();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
