/*
 * Plex, as an On Demand source (see ondemand.js for what a provider does).
 *
 * Signing in uses Plex's link codes, made for TVs: plex.tv hands out a
 * four-letter code, you enter it at plex.tv/link on a phone or computer, and
 * we ask plex.tv every couple of seconds until it gives us the account's
 * token. plex.tv then lists the account's servers, each with several
 * addresses (on this network, over the internet, through Plex's relay); we
 * use the best one that answers, and look again if it stops answering.
 * A server can also be added by its address and a token.
 *
 * Every request is a plain GET (or POST) with the X-Plex-* values in the
 * query string instead of headers, so the browser needs no CORS preflight.
 *
 * Playing: files the browser plays as they are (MP4 with H.264 and AAC or
 * MP3; WebM) come straight from the server, which lets you seek anywhere at
 * once. Anything else goes through Plex's transcoder as HLS (H.264 and AAC
 * in MPEG-TS): it copies what the browser can take (an MKV's H.264 picture,
 * say) and converts only the rest. Subtitle files next to the video are
 * shown by our own subtitle display; subtitles inside the video are drawn
 * into the picture by the transcoder. Progress goes to Plex as it plays.
 * How much the server may send is the Picture Quality setting; Automatic
 * measures the connection (see streamQuality in ondemand.js), as Plex's own
 * apps do, so a viewer away from home isn't sent more than the server's
 * upload carries.
 */
(function () {
  "use strict";
  const PRODUCT = "Watchening", VERSION = "1.0";
  const PLEXTV = "https://plex.tv/api/v2";

  const clientId = () => OnDemand.deviceId();
  // Plex picks what a browser can play by its name
  const UA = navigator.userAgent;
  const PLATFORM = /Firefox\//.test(UA) ? "Firefox" : /Safari\//.test(UA) && !/Chrom(e|ium)\//.test(UA) ? "Safari" : "Chrome";
  const client = () => ({
    "X-Plex-Product": PRODUCT, "X-Plex-Version": VERSION, "X-Plex-Client-Identifier": clientId(),
    "X-Plex-Platform": PLATFORM, "X-Plex-Device": PLATFORM, "X-Plex-Device-Name": `${PRODUCT} (${PLATFORM})`,
    "X-Plex-Model": "hosted",
  });
  // what the transcoder should make for us: HLS of H.264 and AAC/MP3
  const PROFILE = "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac,mp3&replace=true)";

  function url(base, path, params) {
    const u = new URL(base.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== "") u.searchParams.set(k, v);
    return u.href;
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : U.uid() + U.uid());

  /** Fetch JSON. Errors carry `net` (no answer) or `auth` (token refused). */
  async function get(href, { method = "GET", timeout = 15000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let res;
    try {
      res = await fetch(href, { method, headers: { Accept: "application/json" }, signal: ctl.signal, cache: "no-store" });
    } catch {
      throw Object.assign(new Error(ctl.signal.aborted ? "The server didn't answer" : "Couldn't reach the server"), { net: true });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) throw Object.assign(new Error("Plex didn't accept the sign-in. Sign in again in Settings"), { auth: true });
    if (!res.ok) throw new Error(`Plex answered ${res.status}${res.statusText ? " " + res.statusText : ""}`);
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { throw new Error("Plex sent an answer this player doesn't understand"); }
  }

  // ---------------------------------------------------------------- plex.tv
  const tv = (path, params, opts) => get(url(PLEXTV, path, Object.assign(client(), params)), opts);

  async function linkCode() {
    const p = await tv("/pins", {}, { method: "POST" });
    if (!p.id || !p.code) throw new Error("plex.tv didn't give a code");
    const exp = Date.parse(p.expiresAt || "");
    return { id: p.id, code: p.code, expires: Number.isFinite(exp) ? exp : Date.now() + (p.expiresIn || 900) * 1000 };
  }
  /** The account's token once the code has been entered, else "". */
  async function linkToken(pin) {
    return (await tv("/pins/" + pin.id, {})).authToken || "";
  }
  async function accountName(token) {
    const u = await tv("/user", { "X-Plex-Token": token });
    return u.username || u.title || u.email || "";
  }

  // Pages opened over https can't fetch http:// addresses.
  const reachable = (uri) => location.protocol !== "https:" || /^https:/i.test(uri);

  /** The account's servers: [{ id, name, owned, token, conns: [{ uri, local, relay }] }] */
  async function servers(token) {
    const list = await tv("/resources", { includeHttps: 1, includeRelay: 1, "X-Plex-Token": token });
    return (Array.isArray(list) ? list : []).filter((r) => /server/.test(r.provides || "")).map((r) => {
      const conns = [];
      for (const c of r.connections || []) {
        conns.push({ uri: c.uri, local: !!c.local, relay: !!c.relay });
        // Some routers won't look up plex.direct names; on this network the
        // plain address works too (for pages opened over http)
        if (c.local && !c.relay && c.protocol === "https" && c.address && !/:/.test(c.address)) {
          conns.push({ uri: `http://${c.address}:${c.port || 32400}`, local: true, relay: false });
        }
      }
      return { id: r.clientIdentifier, name: r.name || "Plex", owned: !!r.owned, token: r.accessToken || token, conns };
    });
  }

  /** The best address of a server that answers: this network first, then
   *  the internet, then Plex's relay. All are tried at once. */
  async function connect(server) {
    const rank = (c) => (c.relay ? 2 : c.local ? 0 : 1);
    const conns = server.conns.filter((c) => reachable(c.uri)).sort((a, b) => rank(a) - rank(b));
    if (!conns.length) {
      throw new Error(location.protocol === "https:"
        ? `${server.name} has no https:// address. Open this page over http:// instead`
        : `Plex doesn't know an address for ${server.name}`);
    }
    // Once one answers, better ones get a moment longer (an address that
    // can't be reached would otherwise hold things up until it times out)
    return new Promise((resolve, reject) => {
      const res = conns.map(() => null); // null: waiting · { c, mc } · { err }
      let grace = 0, done = false;
      const finish = () => {
        if (done) return;
        const ok = res.filter((r) => r && r.c);
        const first = res.findIndex((r) => !r || r.c);   // best not yet failed
        if (first >= 0 && res[first] && res[first].c) return win(res[first]);
        if (res.every(Boolean)) {
          if (ok.length) return win(ok[0]);
          done = true;
          const auth = res.find((r) => r.err && r.err.auth);
          if (auth) return reject(auth.err);
          const err = res.map((r) => r.err).find(Boolean);
          return reject(new Error(`Couldn't reach ${server.name} (${(err && err.message) || "no answer"}). Is it turned on?`));
        }
        if (ok.length && !grace) grace = setTimeout(() => { const o = res.find((r) => r && r.c); if (o) win(o); }, 1500);
      };
      const win = ({ c, mc }) => {
        done = true;
        clearTimeout(grace);
        resolve({ uri: c.uri, local: c.local, name: mc.friendlyName || server.name });
      };
      conns.forEach((c, i) => {
        get(url(c.uri, "/", { "X-Plex-Token": server.token }), { timeout: 8000 })
          .then((r) => { res[i] = { c, mc: r.MediaContainer || {} }; }, (err) => { res[i] = { err }; })
          .then(finish);
      });
    });
  }

  function makeSource(server, conn, user, account) {
    return {
      id: "plex:" + server.id, type: "plex", name: conn.name || server.name, user: user || "", account: account || "",
      server: { id: server.id, token: server.token, uri: conn.uri, local: conn.local, conns: server.conns },
    };
  }

  /** Look for a source's server again: a new address, a new network. */
  const finding = new Map();
  function reconnect(src) {
    if (!finding.has(src.id)) {
      finding.set(src.id, (async () => {
        const s = src.server;
        let server = { name: src.name, token: s.token, conns: s.conns || [{ uri: s.uri, local: true }] };
        if (src.account) {
          try {
            const fresh = (await servers(src.account)).find((x) => x.id === s.id);
            if (fresh) { server = fresh; s.conns = fresh.conns; s.token = fresh.token; }
          } catch (e) { if (e.auth) throw e; /* plex.tv is down: try what we know */ }
        }
        const c = await connect(server);
        s.uri = c.uri;
        s.local = c.local;
        Store.save();
      })().finally(() => finding.delete(src.id)));
    }
    return finding.get(src.id);
  }

  /** A request to the server; its MediaContainer. */
  async function pms(src, path, params, opts) {
    const go = async () => (await get(url(src.server.uri, path, Object.assign({}, params, { "X-Plex-Token": src.server.token })), opts)).MediaContainer || {};
    try {
      return await go();
    } catch (e) {
      if (!e.net) throw e;
      await reconnect(src);
      return go();
    }
  }
  /** Fire and forget (progress reports): `keepalive` lets it outlive the page. */
  function send(src, path, params, keepalive) {
    const href = url(src.server.uri, path, Object.assign(client(), params, { "X-Plex-Token": src.server.token }));
    return fetch(href, { headers: { Accept: "application/json" }, keepalive: !!keepalive }).catch(() => {});
  }

  // ------------------------------------------------------------------ items
  const KIDS = /child|kid|famil|animat|cartoon|anime/i, SPORTS = /sport/i;
  /** The guide's colors: movies purple, kids' shows blue, sports green. */
  function catOf(type, genres, inherited) {
    if (type === "movie") return "movie";
    if (inherited) return inherited;
    if (genres.some((g) => KIDS.test(g))) return "kids";
    if (genres.some((g) => SPORTS.test(g))) return "sports";
    return "";
  }
  const HD = /^(720|1080|2k|4k)$/i;

  /** Plex metadata -> On Demand item. ctx: { mixed (titles from several
   *  shows: say which), cat (a show's color, for its seasons and episodes) } */
  function item(m, ctx) {
    const media = (m.Media || [])[0] || {};
    const genres = (m.Genre || []).map((g) => g.tag || "");
    const type = m.type === "clip" || m.type === "video" ? "movie" : m.type;
    const leaf = m.leafCount || 0, seen = m.viewedLeafCount || 0;
    const it = {
      id: String(m.ratingKey), type, title: m.title || "",
      year: m.year || 0, rating: m.contentRating || "",
      dur: (m.duration || media.duration || 0) / 1000, offset: (m.viewOffset || 0) / 1000,
      watched: type === "show" || type === "season" ? leaf > 0 && seen >= leaf : (m.viewCount || 0) > 0,
      desc: m.summary || "", hd: HD.test(String(media.videoResolution || "")),
      stars: (m.audienceRating || m.rating || 0) / 2,
      show: type === "episode" ? m.grandparentTitle || "" : type === "season" ? m.parentTitle || "" : "",
      season: type === "episode" ? m.parentIndex : type === "season" ? m.index : undefined,
      episode: type === "episode" ? m.index : undefined,
      count: leaf, unwatched: Math.max(0, leaf - seen), seasons: m.childCount || 0,
      aired: m.originallyAvailableAt || "",
      cat: catOf(type, genres, ctx && ctx.cat),
      lib: m.librarySectionID != null ? String(m.librarySectionID) : "",
    };
    if (ctx && ctx.mixed && it.show) it.label = `${it.show}: ${it.title}`;
    return it;
  }

  const PAGE = 300;
  /** A list, a page at a time: { items, total, next } */
  async function paged(src, path, q, ctx, max) {
    const page = async (start, size) => {
      const mc = await pms(src, path, Object.assign({}, q, { "X-Plex-Container-Start": start, "X-Plex-Container-Size": size }));
      return { items: (mc.Metadata || []).map((m) => item(m, ctx)), total: mc.totalSize };
    };
    const first = await page(0, Math.min(PAGE, max || PAGE));
    let pos = first.items.length;
    const total = Math.min(first.total != null ? first.total : pos, max || Infinity);
    const res = { items: first.items, total, next: null };
    if (pos < total) {
      res.next = async () => {
        if (pos >= total) return null;
        const p = await page(pos, Math.min(PAGE, total - pos));
        pos += p.items.length;
        return p.items.length ? p.items : null;
      };
    }
    return res;
  }

  async function root(src) {
    const mc = await pms(src, "/library/sections");
    const libs = (mc.Directory || [])
      .filter((d) => d.type === "movie" || d.type === "show")
      .map((d) => ({ id: String(d.key), type: "library", kind: d.type, title: d.title || "Library" }));
    if (!libs.length) return [];
    const out = [];
    try {
      const od = await pms(src, "/library/onDeck", { "X-Plex-Container-Start": 0, "X-Plex-Container-Size": 1 });
      if ((od.totalSize || od.size || 0) > 0) out.push({ id: "ondeck", type: "folder", title: "Continue Watching" });
    } catch { /* servers without it */ }
    out.push({ id: "recent", type: "folder", title: "Recently Added" });
    return out.concat(libs);
  }

  const ORDERS = [
    { id: "az", label: "A-Z", q: { sort: "titleSort" } },
    { id: "recent", label: "Recently Added", q: { sort: "addedAt:desc" } },
    { id: "unwatched", label: "Unwatched", q: { sort: "titleSort", unwatched: 1 } },
    { id: "newest", label: "Newest", q: { sort: "originallyAvailableAt:desc" } },
  ];
  async function views(src, it) {
    if (it.type !== "library") return null;
    let genres = [];
    try {
      const mc = await pms(src, `/library/sections/${it.id}/genre`);
      genres = (mc.Directory || []).map((g) => {
        const id = (/[?&]genre=([^&]+)/.exec(g.fastKey || "") || [])[1] || g.key;
        return { id: "genre:" + id, label: g.title, q: { sort: "titleSort", genre: decodeURIComponent(id) } };
      });
    } catch { /* orders only */ }
    return ORDERS.concat(genres);
  }

  async function list(src, it, view) {
    switch (it.type) {
      case "library": return paged(src, `/library/sections/${it.id}/all`, (view || ORDERS[0]).q);
      case "folder":
        return it.id === "ondeck"
          ? paged(src, "/library/onDeck", {}, { mixed: true }, 100)
          : paged(src, "/library/recentlyAdded", {}, { mixed: true }, 100);
      case "show": {
        // one season (or a show set to list its episodes): straight to the episodes
        const seasons = await paged(src, `/library/metadata/${it.id}/children`, {}, { cat: it.cat });
        if (seasons.items.length === 1 && seasons.items[0].type === "season") return list(src, seasons.items[0], null);
        return seasons;
      }
      case "season": return paged(src, `/library/metadata/${it.id}/children`, {}, { cat: it.cat });
    }
    return { items: [], total: 0, next: null };
  }

  /** A library's titles matching what's typed: Plex's own search (the one
   *  its apps use as you type: word starts, best match first, "oceans" finds
   *  "Ocean's"), else, on servers without it, titles containing the text. */
  async function search(src, it, query) {
    if (it.type !== "library") return { items: [], total: 0, next: null };
    const want = it.kind === "show" ? "show" : "movie";
    try {
      const mc = await pms(src, "/hubs/search", { query, sectionId: it.id, limit: 100, includeCollections: 0 });
      const hub = (mc.Hub || []).find((h) => h.type === want);
      const items = ((hub && hub.Metadata) || []).filter((m) => m.type === want).map((m) => item(m));
      return { items, total: items.length, next: null };
    } catch (e) {
      if (e.auth || e.net) throw e;
      return paged(src, `/library/sections/${it.id}/all`, { sort: "titleSort", title: query });
    }
  }

  /** Every episode of a show (all its seasons) or of a season. */
  async function episodes(src, it) {
    const path = `/library/metadata/${it.id}/${it.type === "show" ? "allLeaves" : "children"}`;
    const res = await paged(src, path, {}, { cat: it.cat });
    const out = res.items.slice();
    for (let more; res.next && (more = await res.next());) out.push(...more);
    return out.filter((x) => x.type === "episode");
  }

  /** A movie's trailer, ready to play, or null. Plex lists it with the
   *  movie's extras (its main one is the movie's primaryExtraKey). */
  async function trailer(src, it) {
    const isTrailer = (x) => x.subtype === "trailer" || +x.extraType === 1;
    const m = ((await pms(src, `/library/metadata/${it.id}`, { includeExtras: 1 })).Metadata || [])[0];
    if (!m) return null;
    let extras = (m.Extras && m.Extras.Metadata) || [];
    if (!extras.some(isTrailer)) {
      try { extras = (await pms(src, `/library/metadata/${it.id}/extras`)).Metadata || []; } catch { /* none */ }
    }
    const trailers = extras.filter((x) => isTrailer(x) && x.ratingKey != null);
    const t = trailers.find((x) => m.primaryExtraKey && x.key === m.primaryExtraKey) || trailers[0];
    if (!t) return null;
    return Object.assign(item(t), {
      title: it.title, year: it.year, rating: "", desc: it.desc, extra: "Trailer", watched: false, offset: 0,
    });
  }

  // ---------------------------------------------------------------- playing
  const TEXT_SUBS = /^(srt|subrip|vtt|webvtt)$/i;
  /** Files a browser plays as they are. */
  function browserPlays(media, part) {
    const box = String(media.container || part.container || "").toLowerCase();
    const v = String(media.videoCodec || "").toLowerCase(), a = String(media.audioCodec || "").toLowerCase();
    if (/^(mp4|m4v|mov)$/.test(box)) return /^(h264|avc1?)$/.test(v) && (!a || /^(aac|mp3)$/.test(a));
    if (box === "webm") return /^(vp8|vp9|av1)$/.test(v) && (!a || /^(opus|vorbis)$/.test(a));
    return false;
  }

  /**
   * opts: { fromStart, at (seconds: start there), burn (a subtitle stream
   * inside the video to draw into the picture; undefined: whatever Plex has
   * picked for this title, null: none) }
   */
  async function play(src, it, opts) {
    const s = src.server;
    const m = ((await pms(src, `/library/metadata/${it.id}`)).Metadata || [])[0];
    if (!m) throw new Error("Plex couldn't find that title");
    const media = (m.Media || [])[0];
    const part = media && (media.Part || [])[0];
    if (!part) throw new Error("Plex has no video file for this title");
    const streams = part.Stream || [];
    const dur = (m.duration || media.duration || part.duration || 0) / 1000;
    const start = opts.at != null ? opts.at : opts.fromStart ? 0 : (m.viewOffset || 0) / 1000;

    const subs = streams.filter((x) => x.streamType === 3 && (x.key ? TEXT_SUBS.test(x.codec || "") : true)).map((x) => ({
      id: x.id, label: x.extendedDisplayTitle || x.displayTitle || x.language || "Subtitles", selected: !!x.selected,
      url: x.key ? url(s.uri, x.key, { encoding: "utf-8", "X-Plex-Token": s.token }) : "",
    }));
    let burn = opts.burn;
    if (burn === undefined) { const sel = subs.find((x) => x.selected && !x.url); burn = sel ? sel.id : null; }
    // (with Automatic quality, the file is also what the connection is measured with)
    const q = await OnDemand.streamQuality(src, opts, url(s.uri, part.key, { "X-Plex-Token": s.token }));
    // rate: about what the stream will use (kbps), for stepping down if it's too much
    const rate = media.bitrate ? Math.min(media.bitrate, q.kbps) : q.kbps;
    const base = { start, dur, subs, burn, part: part.id, auto: q.auto, rate };

    const fits = !media.bitrate || media.bitrate <= q.kbps;
    if (!burn && fits && browserPlays(media, part)) {
      return Object.assign(base, { url: url(s.uri, part.key, { "X-Plex-Token": s.token }), session: "" });
    }

    const session = uuid();
    const params = Object.assign(client(), {
      path: "/library/metadata/" + it.id, mediaIndex: 0, partIndex: 0, protocol: "hls",
      fastSeek: 1, directPlay: 0, directStream: 1, directStreamAudio: 1,
      videoQuality: 100, videoResolution: q.res, maxVideoBitrate: q.kbps,
      audioBoost: 100, subtitleSize: 100, subtitles: burn ? "burn" : "none",
      location: s.local ? "lan" : "wan", session,
      "X-Plex-Session-Identifier": session, "X-Plex-Client-Profile-Extra": PROFILE, "X-Plex-Token": s.token,
    });
    // Ask first: Plex says here when it can't play something, rather than
    // the stream just failing
    try {
      const d = (await get(url(s.uri, "/video/:/transcode/universal/decision", params), { timeout: 20000 })).MediaContainer || {};
      if (+d.generalDecisionCode >= 2000) throw Object.assign(new Error(d.generalDecisionText || "Plex can't play this title"), { decided: true });
    } catch (e) {
      if (e.decided || e.auth) throw e;
    }
    return Object.assign(base, { url: url(s.uri, "/video/:/transcode/universal/start.m3u8", params), session });
  }

  function timeline(src, it, pl, state, sec, keepalive) {
    return send(src, "/:/timeline", {
      ratingKey: it.id, key: "/library/metadata/" + it.id, state,
      time: Math.max(0, Math.round(sec * 1000)), duration: Math.round((pl.dur || it.dur || 0) * 1000),
      "X-Plex-Session-Identifier": pl.session || "",
    }, keepalive);
  }
  function release(src, pl, keepalive) {
    if (pl.session) send(src, "/video/:/transcode/universal/stop", { session: pl.session }, keepalive);
  }

  async function setSubtitle(src, pl, sub) {
    if (!pl.part) return;
    const href = url(src.server.uri, `/library/parts/${pl.part}`, { subtitleStreamID: sub ? sub.id : 0, allParts: 1, "X-Plex-Token": src.server.token });
    await fetch(href, { method: "PUT", headers: { Accept: "application/json" } });
  }

  // ---------------------------------------------------------------- sign in
  /** Add a server, already signed in to; closes the dialog when done. */
  async function addServer(server, user, account) {
    Dialog.message(`Connecting to ${server.name}...`);
    Dialog.big("");
    try {
      const conn = await connect(server);
      OnDemand.addSource(makeSource(server, conn, user, account));
      Dialog.close();
      App.osd(`Added ${conn.name || server.name}`, 3500);
      return true;
    } catch (e) {
      Dialog.message(e.message, true);
      return false;
    }
  }

  async function signedIn(token, opts) {
    Dialog.big("");
    Dialog.message("Signed in. Looking for your servers...");
    let user = "", list;
    try {
      [user, list] = await Promise.all([accountName(token).catch(() => ""), servers(token)]);
    } catch (e) {
      if (Dialog.is(opts)) Dialog.message(e.message, true);
      return;
    }
    if (!Dialog.is(opts)) return;
    const have = new Set(Store.cfg.vod.sources.map((s) => s.id));
    const fresh = list.filter((s) => !have.has("plex:" + s.id));
    if (!list.length) return Dialog.message("There are no Plex Media Servers on this account.", true);
    if (!fresh.length) return Dialog.message("Every server on this account is already in On Demand.", true);
    if (fresh.length === 1) return addServer(fresh[0], user, token);
    Dialog.open({
      title: "Choose a Server",
      text: user ? `Signed in as ${user}. Which server?` : "Which server?",
      buttons: fresh.map((s) => ({
        label: s.name + (s.owned ? "" : " (shared)"),
        act: async () => (await addServer(s, user, token)) ? undefined : false,
      })).concat([{ label: "Cancel" }]),
    });
  }

  function signIn() {
    let alive = true, timer = 0;
    const stop = () => { alive = false; clearTimeout(timer); };
    const opts = {
      title: "Sign In to Plex",
      text: "Getting a code from plex.tv...",
      buttons: [
        { label: "Open plex.tv/link", act: () => { window.open("https://plex.tv/link", "_blank", "noopener"); return false; } },
        { label: "Add Server by Address Instead", act: () => { stop(); setTimeout(manual); } },
        { label: "Cancel", act: stop },
      ],
      onCancel: stop,
    };
    Dialog.open(opts);
    const still = () => alive && Dialog.is(opts);
    let pin = null;
    const newCode = async () => {
      pin = await linkCode();
      if (!still()) return;
      Dialog.message("On your phone or computer, go to plex.tv/link and enter this code:");
      Dialog.big(pin.code);
    };
    const poll = async () => {
      if (!still()) return;
      try {
        if (Date.now() > pin.expires - 5000) await newCode();
        const token = await linkToken(pin);
        if (!still()) return;
        if (token) { stop(); return signedIn(token, opts); }
      } catch { /* try again in a moment */ }
      if (still()) timer = setTimeout(poll, 2000);
    };
    newCode().then(() => { if (still()) timer = setTimeout(poll, 2000); }, (e) => {
      if (still()) Dialog.message(`Couldn't get a code from plex.tv: ${e.message}`, true);
    });
  }

  function manual() {
    Dialog.open({
      title: "Add Plex Server by Address",
      text: "The server's address, and a Plex token (Plex's help explains how to find one: search \"finding an authentication token\"). Leave the token empty if the server lets this network in without signing in.",
      fields: [
        { id: "addr", label: "Server address", placeholder: "http://192.168.1.20:32400" },
        { id: "token", label: "Plex token", placeholder: "Optional" },
      ],
      buttons: [
        {
          label: "Add Server",
          act: async (v) => {
            if (!v.addr) { Dialog.message("Enter the server's address first.", true); return false; }
            let u;
            try {
              u = new URL(/^https?:\/\//i.test(v.addr) ? v.addr : "http://" + v.addr);
              if (!/^https?:\/\//i.test(v.addr) && !u.port) u.port = "32400";
            } catch {
              Dialog.message("That doesn't look like a server address.", true);
              return false;
            }
            const uri = u.origin + u.pathname.replace(/\/+$/, "");
            if (!reachable(uri)) { Dialog.message("This page was opened over https://, so it can't reach an http:// server. Open the page over http:// instead.", true); return false; }
            Dialog.message("Connecting...");
            let mc;
            try {
              mc = (await get(url(uri, "/", { "X-Plex-Token": v.token }), { timeout: 10000 })).MediaContainer || {};
            } catch (e) {
              Dialog.message(e.auth ? "The server didn't accept that token." : `${e.message}. Check the address.`, true);
              return false;
            }
            if (!mc.machineIdentifier) { Dialog.message("That address answered, but it isn't a Plex Media Server.", true); return false; }
            const server = { id: mc.machineIdentifier, name: mc.friendlyName || u.hostname, token: v.token, conns: [{ uri, local: true, relay: false }] };
            OnDemand.addSource(makeSource(server, { uri, local: true, name: server.name }, "", ""));
            App.osd(`Added ${server.name}`, 3500);
          },
        },
        { label: "Cancel" },
      ],
    });
  }

  // ------------------------------------------------------------- provider
  OnDemand.register("plex", {
    label: "Plex",
    setup: [
      {
        text: "Sign In to Plex",
        desc: "Watch the movies and shows on your Plex Media Server. You'll get a code to enter at plex.tv/link on your phone or computer.",
        act: signIn,
      },
      {
        text: "Add Plex Server by Address",
        desc: "Add a Plex Media Server by its address (such as http://192.168.1.20:32400) and a Plex token, without signing in here.",
        act: manual,
      },
    ],
    describe(src) {
      return `Plex Media Server${src.user ? `, signed in as ${src.user}` : ""}. Address: ${src.server.uri}`;
    },
    reconnect,
    root, views, list, search, play, release, setSubtitle, episodes, trailer,
    /** A show's logo (its clearLogo, small, through Plex's image resizer), for the guide. */
    logo(src, showId) {
      return url(src.server.uri, "/photo/:/transcode", {
        width: 240, height: 96, minSize: 1, upscale: 1, format: "png",
        url: `/library/metadata/${showId}/clearLogo`, "X-Plex-Token": src.server.token,
      });
    },
    report(src, it, pl, state, sec) { timeline(src, it, pl, state, sec); },
    stopped(src, it, pl, sec, leaving) {
      release(src, pl, leaving);
      return timeline(src, it, pl, "stopped", sec, leaving);
    },
    async setWatched(src, it, on) {
      await pms(src, on ? "/:/scrobble" : "/:/unscrobble", { identifier: "com.plexapp.plugins.library", key: it.id });
    },
  });
})();
