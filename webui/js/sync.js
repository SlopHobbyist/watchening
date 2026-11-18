/*
 * Settings saved on the server (the accounts service's /api/settings; see
 * auth/settings.mjs), so every TV someone signs in on has their playlists,
 * channel order, On Demand servers and options. What belongs to one TV
 * (Store's DEVICE: the screen's shape, picture settings, the last channel)
 * stays in its browser. With sign-in off, the home network shares one copy.
 *
 *   start    before the guide loads, the server's copy if it's newer. The
 *            first time on a TV that has settings of its own, it asks which
 *            to keep.
 *   change   sent a moment later (Store.onSave). Uploaded playlist files go
 *            up once, named by their content (pl.file).
 *   check    every few minutes, and when the page comes back into view:
 *            newer copies from other TVs, or an admin's update of the
 *            person's group. Two TVs saving at once: the server refuses the
 *            second (409), which takes the first's copy.
 *
 * Editing a group (/?group=<id>, admins, from the Users page): the group's
 * settings are loaded instead of your own, and changes are saved to the group.
 *
 * Per browser, in localStorage "iptv.sync.v1": { off, who, rev }
 *   off  this TV doesn't save on the server (Settings > Account)
 *   who  the account (or "home") its settings last came from or went to
 *   rev  the server copy's version they match
 */
(function () {
  "use strict";
  const KEY = "iptv.sync.v1";
  const CHECK_EVERY = 3 * 60e3;
  const st = Object.assign({ off: false, who: "", rev: -1 }, readState());
  let who = "";          // this account's id, or "home"
  let editRev = -1;      // editing a group: the version being edited
  let sent = "";         // what the server has (sharedKey), as far as we know
  let timer = 0, busy = null, booted = false;

  const Sync = (window.Sync = {
    /** Saving on the server, now. */
    active: false,
    /** Server-side saving is possible here (a server with accounts, or sign-in off). */
    possible: false,
    /** The person's group, from the server: { id, name, hasSettings } or null. */
    group: null,
    /** Their settings are their group's latest, unchanged. */
    fromGroup: false,
    /** Editing a group's settings: { id, name }. */
    editing: null,
    /** What went wrong last, for Settings > Account. */
    problem: "",
    ready: null,
  });

  function readState() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null") || {}; } catch { return {}; }
  }
  function saveState() {
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* */ }
  }
  const rev = () => (Sync.editing ? editRev : st.rev);
  function setRev(r) {
    if (Sync.editing) editRev = r;
    else { st.rev = r; st.who = who; saveState(); }
  }
  const base = () => (Sync.editing ? `/api/admin/groups/${encodeURIComponent(Sync.editing.id)}/settings` : "/api/settings");

  async function api(method, path, body, type) {
    let res;
    try {
      res = await fetch(path, {
        method, cache: "no-store",
        headers: Object.assign({ Accept: "application/json" }, body !== undefined ? { "Content-Type": type || "application/json" } : {}),
        body: body === undefined ? undefined : type ? body : JSON.stringify(body),
      });
    } catch {
      return { status: 0, data: { error: "Couldn't reach the server" } };
    }
    let data = {};
    try { data = (await res.json()) || {}; } catch { /* empty */ }
    return { status: res.status, data };
  }
  const why = (r) => (r.data && r.data.error) || `the server answered ${r.status}`;

  // ------------------------------------------------------------- the copy
  /** The settings to save: Store.cfg without this TV's parts or what each TV
   *  works out for itself (channel counts, download times, problems). */
  function shared(cfg) {
    const c = JSON.parse(JSON.stringify(cfg));
    const D = Store.DEVICE;
    for (const k of D.top) delete c[k];
    for (const k of D.prefs) delete c.prefs[k];
    for (const k of D.vod) delete c.vod[k];
    c.playlists = c.playlists.map(({ count, updated, error, ...pl }) => pl);
    return c;
  }
  /** For telling whether there's anything new to send. A server's address
   *  (which of a Plex server's connections answered) differs from TV to TV,
   *  so it goes along but changing it alone isn't worth sending. */
  function sharedKey(c) {
    return JSON.stringify(c, function (k, v) {
      return (k === "uri" || k === "local") && this && Array.isArray(this.conns) ? undefined : v;
    });
  }
  const hasAny = (cfg) => !!(cfg && ((cfg.playlists && cfg.playlists.length) || (cfg.vod && cfg.vod.sources && cfg.vod.sources.length)));

  /** Uploaded playlists the server doesn't have yet. */
  async function uploadFiles() {
    let n = 0;
    for (const pl of Store.cfg.playlists) {
      if (pl.type !== "file" || pl.file) continue;
      const text = await Store.get("pl:" + pl.id);
      if (text == null) continue;
      const r = await api("POST", "/api/settings/files", text, "text/plain; charset=utf-8");
      if (r.status !== 201) throw new Error(`Couldn't save ${pl.name} on the server: ${why(r)}`);
      pl.file = r.data.id;
      n++;
    }
    if (n) Store.saveLocal();
  }
  /** Uploaded playlists this TV doesn't have yet. */
  async function downloadFiles(pls) {
    for (const pl of pls) {
      if (pl.type !== "file" || !pl.file || (await Store.get("pl:" + pl.id)) != null) continue;
      try {
        const res = await fetch("/api/settings/files/" + encodeURIComponent(pl.file));
        if (!res.ok) throw new Error(res.status);
        await Store.put("pl:" + pl.id, await res.text());
      } catch {
        pl.error = "Couldn't download this file from the server";
      }
    }
  }

  /** Use the server's settings (`cfg`, version `r`). `note`: an on-screen line, if any. */
  async function take(cfg, r, note) {
    const oldPl = new Map(Store.cfg.playlists.map((p) => [p.id, p]));
    const oldSrc = new Map(Store.cfg.vod.sources.map((s) => [s.id, s]));
    const srcKey = JSON.stringify(Store.cfg.vod.sources);
    const next = cfg ? JSON.parse(JSON.stringify(cfg)) : null;
    if (next) {
      for (const pl of next.playlists || []) {
        const o = oldPl.get(pl.id);
        const same = o && o.url === pl.url && o.type === pl.type;
        Object.assign(pl, { count: same ? o.count : 0, updated: same ? o.updated : 0, error: same ? o.error : "" });
      }
      // keep the server address this TV found (see sharedKey); one that was
      // typed in (Jellyfin, no list of connections) is the same everywhere
      for (const s of (next.vod && next.vod.sources) || []) {
        const o = oldSrc.get(s.id);
        if (o && o.server && s.server && o.server.uri && Array.isArray(s.server.conns)) Object.assign(s.server, { uri: o.server.uri, local: o.server.local });
      }
      await downloadFiles(next.playlists || []);
    }
    Store.adopt(next);
    setRev(r);
    sent = sharedKey(shared(Store.cfg));
    if (booted) {
      await App.reloadData(JSON.stringify(Store.cfg.vod.sources) !== srcKey);
      if (note) App.osd(note, 4000);
    }
  }

  function noteServer(d) {
    if (Sync.editing) return;
    Sync.group = d.group || null;
    Sync.fromGroup = !!d.fromGroup;
  }

  // ------------------------------------------------------------- send / check
  /** Send this TV's changes, if there are any. */
  function push() {
    clearTimeout(timer);
    timer = 0;
    if (!Sync.active) return Promise.resolve();
    if (busy) return busy.then(push);
    busy = (async () => {
      try {
        await uploadFiles();
        const c = shared(Store.cfg), k = sharedKey(c);
        if (k === sent) return;
        const r = await api("PUT", base(), { cfg: c, baseRev: rev() });
        if (r.status === 200) {
          setRev(r.data.rev);
          sent = k;
          Sync.problem = "";
        } else if (r.status === 409) {
          noteServer(r.data);
          await take(r.data.cfg, r.data.rev, Sync.editing ? "Another admin changed this group's settings: showing theirs" : "Your settings were changed on another TV: showing those");
        } else {
          if (r.status === 401) U.checkSignIn();
          throw new Error(why(r));
        }
      } catch (e) {
        Sync.problem = `Couldn't save on the server: ${e.message}`;
        timer = setTimeout(push, 30e3); // try again
      }
    })().finally(() => { busy = null; });
    return busy;
  }

  /** Newer settings from the server: another TV's, or the group's. */
  async function check() {
    if (!Sync.active || busy) return;
    if (sharedKey(shared(Store.cfg)) !== sent) return push(); // ours first; a newer copy comes back as a 409
    const r = await api("GET", base());
    if (r.status !== 200 || busy || timer) return;
    noteServer(r.data);
    if (r.data.rev !== rev()) {
      await take(r.data.cfg, r.data.rev,
        Sync.editing ? "Another admin changed this group's settings: showing theirs"
          : r.data.fromGroup ? `An admin updated your settings (${r.data.group.name})`
            : "Your settings were changed on another TV");
    }
  }

  /** The first time this TV saves to this account, and both have settings. */
  function ask(d) {
    const some = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;
    const n = (cfg) => {
      const pls = (cfg.playlists || []).filter((p) => p.type !== "zlive").length, srcs = ((cfg.vod && cfg.vod.sources) || []).length;
      return [some(pls, "playlist"), srcs ? some(srcs, "On Demand server") : ""].filter(Boolean).join(", ");
    };
    const acct = U.server.user ? "your account" : "this server";
    return new Promise((done) => {
      Dialog.open({
        title: "Saved Settings",
        text: `This TV has settings of its own (${n(Store.cfg)}), and ${acct} has a saved copy (${n(d.cfg)}). Which should this TV use? The other is replaced.`,
        buttons: [
          { label: U.server.user ? "Use My Account's Settings" : "Use the Saved Settings", act: async () => { await take(d.cfg, d.rev); done(); } },
          { label: "Keep This TV's Settings", act: async () => { setRev(d.rev); sent = ""; await push(); done(); } },
        ],
        onCancel: () => {
          Sync.active = false;
          Sync.problem = "Not saving on the server until you choose (Settings > Account).";
          done();
        },
      });
    });
  }

  async function start() {
    await U.serverReady;
    const s = U.server;
    if (!s.known || (s.auth && !s.user)) return;
    Sync.possible = true;
    who = s.user ? s.user.id : "home";

    if (Store.editing) {
      const r = s.user && s.user.admin ? await api("GET", `/api/admin/groups/${encodeURIComponent(Store.editing)}/settings`) : { status: 403, data: {} };
      if (r.status !== 200) {
        alert(r.status === 403 ? "Only admins can change a group's settings." : `Couldn't open the group's settings: ${why(r)}`);
        location.replace("/auth/users");
        return new Promise(() => {}); // leaving
      }
      Sync.editing = { id: r.data.id, name: r.data.name };
      Sync.active = true;
      await take(r.data.cfg, r.data.rev);
      return;
    }
    if (st.off) return;
    Sync.active = true;
    const r = await api("GET", "/api/settings");
    if (r.status !== 200) {
      Sync.problem = `Couldn't load your saved settings: ${why(r)}`;
      sent = "?"; // send ours once it answers again
      return;
    }
    const d = r.data;
    noteServer(d);
    if (!d.cfg) {                    // nothing saved yet: this TV's settings start the copy
      setRev(d.rev);
      sent = "";
      return push();
    }
    if (st.who === who) {
      if (d.rev !== st.rev) return take(d.cfg, d.rev);
      sent = sharedKey(d.cfg);       // the same version: anything changed here since goes up
      return push();
    }
    // first time on this TV for this account. Settings that came from another
    // account (a shared TV) are that account's to keep: no need to ask.
    if (!st.who && hasAny(Store.cfg) && sharedKey(shared(Store.cfg)) !== sharedKey(d.cfg)) return ask(d);
    return take(d.cfg, d.rev);
  }

  // ------------------------------------------------------------------ api
  Object.assign(Sync, {
    /** Called by Store.save(). */
    changed() {
      if (!Sync.active) return;
      clearTimeout(timer);
      timer = setTimeout(push, 1500);
    },
    /** Send any change now (before leaving the page). */
    flush: push,
    check,
    /** This TV saves on the server, or not (Settings > Account). */
    async setOn(on) {
      st.off = !on;
      if (on) st.who = st.who === who ? who : ""; // ask again if it's been a while
      saveState();
      if (!on) { Sync.active = false; Sync.problem = ""; clearTimeout(timer); return; }
      Sync.problem = "";
      await start();
    },
    /** Take the person's group's settings again, replacing their own. */
    async useGroup() {
      const r = await api("POST", "/api/settings/group", {});
      if (r.status !== 200) throw new Error(why(r));
      noteServer(r.data);
      await take(r.data.cfg, r.data.rev, r.data.group ? `Now using ${r.data.group.name}'s settings` : "");
    },
  });

  Store.onSave = () => Sync.changed();
  Sync.ready = start().catch((e) => { Sync.problem = e.message; }).finally(() => {
    booted = true; // from here on, settings that arrive reload the guide
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) push();
    else check();
  });
  window.addEventListener("pagehide", () => { push(); });
  setInterval(check, CHECK_EVERY);
})();
