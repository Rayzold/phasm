// Phasmo Journal service worker — network-first με cache fallback για offline χρήση στο βαν.
// Σταθερό όνομα cache: το fetch handler είναι network-first και ξαναγράφει το cache σε κάθε
// επιτυχημένο online request ανεξαρτήτως ονόματος, άρα δεν χρειάζεται να ταιριάζει με το
// APP_VERSION του index.html πια. Άλλαξέ το ΜΟΝΟ αν θες να σβήσεις σκόπιμα όλα τα cached αρχεία
// (π.χ. αφαίρεσες ένα core αρχείο) — ο browser έτσι κι αλλιώς εντοπίζει νέο SW σε κάθε αλλαγή
// αυτού του ίδιου του αρχείου (sw.js) και τρέχει activate/cleanup μόνος του.
const CACHE = "phasmo-journal-static";
const CORE = ["./", "./index.html", "./questionnaire.html", "./voice.html", "./ghosts-data.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Hosts for the optional in-browser AI voice model (~hundreds of MB) — left alone entirely,
// since transformers.js manages its own cache and mirroring that into CACHE would double the
// storage and bloat a cache our activate handler never prunes. Everything else cross-origin
// (e.g. Google Fonts) is small and still worth caching for real offline use in the van — an
// earlier version of this file excluded ALL cross-origin requests, which silently broke the
// "Special Elite" font offline as a side effect; don't widen this list without noticing that.
const SKIP_CACHE_HOSTS = ["cdn.jsdelivr.net", "huggingface.co"];
function isSkippedHost(url) {
  const h = new URL(url).hostname;
  return SKIP_CACHE_HOSTS.some(skip => h === skip || h.endsWith("." + skip));
}

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || !e.request.url.startsWith("http")) return;
  if (isSkippedHost(e.request.url)) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then(m => m || caches.match("./index.html")))
  );
});
