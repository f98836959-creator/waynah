// Waynah service worker: makes the site installable and shows push notifications.
// No caching, so every visit gets the latest version.
var ICON = 'https://sjlqtlmpgypcmylcycpz.supabase.co/storage/v1/object/public/photos/app/icon-192.png';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () {});

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  var title = d.title || 'وينه';
  var opts = {
    body: d.body || '',
    icon: ICON,
    badge: ICON,
    tag: d.tag || undefined,
    renotify: !!d.tag,
    lang: 'ar',
    dir: 'rtl',
    data: { url: d.url || '/' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
        c.postMessage({ type: 'nav', url: url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
