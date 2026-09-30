// sw.js — a tiny "service worker" so phones and Chrome treat the site as an installable app,
// and so it can show message notifications.
// It doesn't cache anything: chat needs a live connection, so we always go to the network.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Do nothing special; the browser loads everything normally.
});

// Tapping a notification opens the chat (or brings it to the front if it's already open)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      if (windows.length > 0) return windows[0].focus();
      return self.clients.openWindow("/");
    })
  );
});
