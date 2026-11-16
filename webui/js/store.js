/*
 * Persistence.
 *   Store.cfg      small settings object, kept in localStorage
 *   Store.get/put  large blobs (playlist and XMLTV text) in IndexedDB, since
 *                  IPTV playlists easily outgrow localStorage's ~5MB.
 *
 * cfg = {
 *   playlists: [{ id, name, type: "url"|"file"|"zlive", url, enabled, count, updated, error }],
 *              (at most one "zlive": zlive.st's channels, see zlive.js)
 *   order:  [channel keys]   custom channel order (keys: "<playlist id>|<stream url>")
 *   hidden: [channel keys]
 *   prefs:  { epgUrl, ccDefault, ccSize, proxy, chanIcons, squish, wide }
 *           (chanIcons: built-in icons for channels without one, see logos.js;
 *            squish: 16:9 output squeezed onto a 4:3 TV, see fit() in main.js;
 *            wide: 16:9 layout for a widescreen display, see fit() in main.js)
 *   last:   channel key last watched
 *   ccOffsets, screen, screenCh: subtitle offsets and screen options (see below)
 * }
 */
(function () {
  "use strict";
  const KEY = "iptv.config.v1";
  const DEFAULTS = () => ({
    playlists: [],
    order: [],
    hidden: [],
    prefs: { epgUrl: "", ccDefault: false, ccSize: 1, proxy: "", chanIcons: true, squish: false, wide: false },
    last: "",
    ccOffsets: {},   // channel key -> subtitle offset (seconds)
    screen: {},      // screen options for every channel: { aspect, scale, crop, overscan, splitScan, overscanY }
    screenCh: {},    // channel key -> screen options of its own
  });

  function load() {
    const cfg = DEFAULTS();
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (saved && typeof saved === "object") {
        Object.assign(cfg, saved);
        cfg.prefs = Object.assign(DEFAULTS().prefs, saved.prefs || {});
      }
    } catch { /* storage blocked or corrupt: start fresh */ }
    return cfg;
  }

  // ------------------------------------------------------------- IndexedDB
  const mem = new Map(); // fallback when IndexedDB is unavailable
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((ok, fail) => {
        try {
          const r = indexedDB.open("iptv-viewer", 1);
          r.onupgradeneeded = () => r.result.createObjectStore("kv");
          r.onsuccess = () => ok(r.result);
          r.onerror = () => fail(r.error);
        } catch (e) { fail(e); }
      }).catch(() => null);
    }
    return dbp;
  }
  /** Run one request in IndexedDB, or `fallback` against the in-memory map. */
  async function tx(mode, fn, fallback) {
    const d = await db();
    if (!d) return fallback();
    try {
      return await new Promise((ok, fail) => {
        const t = d.transaction("kv", mode);
        const req = fn(t.objectStore("kv"));
        t.oncomplete = () => ok(req.result);
        t.onerror = t.onabort = () => fail(t.error);
      });
    } catch {
      return fallback();
    }
  }

  const Store = {
    cfg: load(),
    save() {
      try { localStorage.setItem(KEY, JSON.stringify(this.cfg)); } catch { /* ignore */ }
    },
    reset() {
      this.cfg = DEFAULTS();
      this.save();
      return tx("readwrite", (s) => s.clear(), () => mem.clear());
    },
    get(k) { return tx("readonly", (s) => s.get(k), () => mem.get(k)); },
    put(k, v) { return tx("readwrite", (s) => s.put(v, k), () => mem.set(k, v)); },
    del(k) { return tx("readwrite", (s) => s.delete(k), () => mem.delete(k)); },
  };

  window.Store = Store;
})();
