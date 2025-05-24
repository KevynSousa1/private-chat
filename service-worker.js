self.addEventListener('install', (event) => {
    console.log('Service Worker installed');
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker activated');
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    console.log('Push event received:', event);
    if (event.data) {
        const data = event.data.json();
        console.log('Push notification data:', data);
        const options = {
            body: data.body,
            icon: '/icon.png', // Ensure an icon exists or update path
            badge: '/badge.png' // Optional, ensure it exists
        };
        event.waitUntil(
            self.registration.showNotification(data.title, options)
                .then(() => console.log('Notification shown:', data.title))
                .catch((error) => console.error('Error showing notification:', error))
        );
    } else {
        console.log('Push event with no data');
    }
});
