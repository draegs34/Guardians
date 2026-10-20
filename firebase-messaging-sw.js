/*
 * Service worker for push notifications (Firebase Cloud Messaging).
 * It shows "you're on the clock" messages when the draft page isn't open,
 * and opens the draft when one is tapped. It reads the Firebase settings from config.js.
 */
self.window = self;
importScripts('config.js');
importScripts(
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js'
);
firebase.initializeApp(self.FIREBASE_CONFIG);
firebase.messaging();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
