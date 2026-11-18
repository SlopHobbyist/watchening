/*
 * Persistence.
 *   Store.cfg      small settings object, kept in localStorage
 *   Store.get/put  large blobs (playlist and XMLTV text) in IndexedDB, since
 *                  IPTV playlists easily outgrow localStorage's ~5MB.
 * On a server with accounts, sync.js also saves cfg there (Store.onSave), all
 * but the parts that belong to one TV (DEVICE below).
 *
 * cfg = {
 *   playlists: [{ id, name, type: "url"|"file"|"zlive", url, enabled, count, updated, error, file }],
 *              (at most one "zlive": zlive's channels, see zlive.js;
 *               file: an uploaded playlist's copy on the server, see sync.js)
 *   order:  [channel keys]   custom channel order (keys: "<playlist id>|<stream url>")
 *   hidden: [channel keys]
 *   prefs:  { epgUrl, ccDefault, ccSize, proxy, chanIcons, squish, wide }
 *           (chanIcons: built-in icons for channels without one, see logos.js;
 *            squish: 16:9 output squeezed onto a 4:3 TV, see fit() in main.js;
 *            wide: 16:9 layout for a widescreen display, see fit() in main.js;
 *            on by default, so a new TV starts in 16:9 mode)
 *   last:   channel key last watched
 *   ccOffsets, screen, screenCh: subtitle offsets and screen options (see below)
 *   vod:    On Demand (see ondemand.js): { clientId, sources: [{ id, type, name, ... }],
 *           quality, views: { "<source id>:<library id>": view id },
 *           hiddenLibs: ["<source id>:<library id>"] (left out of On Demand) }
 * }
 *
 * Some options are the person's own (PERSONAL): saved to their account, but
 * never part of a group's settings (auth/settings.mjs keeps them out).
 *
 * Editing a group's settings (/?group=<id>, admins; see sync.js): cfg holds the
 * group's settings, and only this TV's own parts (DEVICE) and the admin's own
 * options (PERSONAL) are kept in localStorage, so the admin's own settings
 * stay as they were.
 */
(function () {
  "use strict";
  const KEY = "iptv.config.v1";
  const DEFAULTS = () => ({
    playlists: [],
    order: [],
    hidden: [],
    prefs: { epgUrl: "", ccDefault: false, ccSize: 1, proxy: "", chanIcons: true, squish: false, wide: true },
    last: "",
    ccOffsets: {},   // channel key -> subtitle offset (seconds)
    screen: {},      // screen options for every channel: { aspect, scale, crop, overscan, splitScan, overscanY }
    screenCh: {},    // channel key -> screen options of its own
    vod: { clientId: "", sources: [], quality: "original", views: {}, hiddenLibs: [] },
  });
  /** What belongs to this TV, not to the person: the screen's shape and
   *  picture settings, the last channel, the id media servers know it by. */
  const DEVICE = { top: ["last", "screen", "screenCh"], prefs: ["squish", "wide"], vod: ["clientId"] };
  /** Options that are the person's, not their group's (prefs keys; the same
   *  list as PERSONAL in auth/settings.mjs). */
  const PERSONAL = ["ccDefault"];
  const editing = new URLSearchParams(location.search).get("group") || "";
  /** What stays in this browser rather than in the settings being saved:
   *  this TV's parts, and while editing a group, the admin's own options too. */
  const LOCAL = editing ? Object.assign({}, DEVICE, { prefs: DEVICE.prefs.concat(PERSONAL) }) : DEVICE;

  /** A saved cfg (from storage or the server) made whole. */
  function normalize(saved) {
    const cfg = DEFAULTS();
    if (saved && typeof saved === "object") {
      Object.assign(cfg, saved);
      cfg.prefs = Object.assign(DEFAULTS().prefs, saved.prefs || {});
      if (cfg.prefs.squish) cfg.prefs.wide = false; // squish mode turns 16:9 mode off
      cfg.vod = Object.assign(DEFAULTS().vod, saved.vod || {});
    }
    return cfg;
  }
  /** The parts of `cfg` that stay in this browser (LOCAL). */
  function deviceParts(cfg) {
    const out = { prefs: {}, vod: {} };
    for (const k of LOCAL.top) if (cfg[k] !== undefined) out[k] = cfg[k];
    for (const k of LOCAL.prefs) if (cfg.prefs && cfg.prefs[k] !== undefined) out.prefs[k] = cfg.prefs[k];
    for (const k of LOCAL.vod) if (cfg.vod && cfg.vod[k] !== undefined) out.vod[k] = cfg.vod[k];
    return out;
  }
  /** `cfg` with the parts from `dev` (deviceParts) laid over it. */
  function withDevice(cfg, dev) {
    for (const k of LOCAL.top) if (dev[k] !== undefined) cfg[k] = dev[k];
    Object.assign(cfg.prefs, dev.prefs || {});
    Object.assign(cfg.vod, dev.vod || {});
    if (cfg.prefs.squish) cfg.prefs.wide = false;
    return cfg;
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } // blocked or corrupt
  }
  function load() {
    const saved = readLocal();
    return editing ? withDevice(normalize(null), deviceParts(normalize(saved))) : normalize(saved);
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
    /** The group whose settings are being edited (an id), or "". */
    editing,
    /** Called after every save (sync.js sends the change to the server). */
    onSave: null,
    save() {
      this.saveLocal();
      if (this.onSave) this.onSave();
    },
    /** Save in this browser only. */
    saveLocal() {
      let out = this.cfg;
      if (editing) out = withDevice(normalize(readLocal()), deviceParts(this.cfg));
      try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* ignore */ }
    },
    /** Take settings from the server, keeping this TV's own parts. */
    adopt(saved) {
      const dev = deviceParts(this.cfg);
      const next = withDevice(normalize(saved), dev);
      for (const k of Object.keys(this.cfg)) delete this.cfg[k];
      Object.assign(this.cfg, next); // the same object: other files hold on to Store.cfg
      this.saveLocal();
    },
    reset() {
      if (editing) {
        // a group's settings: back to empty, leaving this TV alone
        this.adopt(null);
        this.save();
        return Promise.resolve();
      }
      this.cfg = DEFAULTS();
      this.save();
      return tx("readwrite", (s) => s.clear(), () => mem.clear());
    },
    DEVICE,
    PERSONAL,
    /** What sync.js leaves out of the copy it saves (see LOCAL). */
    LOCAL,
    get(k) { return tx("readonly", (s) => s.get(k), () => mem.get(k)); },
    put(k, v) { return tx("readwrite", (s) => s.put(v, k), () => mem.set(k, v)); },
    del(k) { return tx("readwrite", (s) => s.delete(k), () => mem.delete(k)); },
  };

  window.Store = Store;
})();
