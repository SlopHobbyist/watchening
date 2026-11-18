/*
 * Jellyfin, as an On Demand source (see ondemand.js for what a provider does).
 * Jellyfin 10.9 or later.
 *
 * Signing in: Jellyfin has nothing like plex.tv to find servers for you, so
 * you give the server's address first (just "192.168.1.20" will do: we try
 * port 8096, then https). Then Quick Connect, made for TVs: the server hands
 * out a six-digit code, you enter it in Jellyfin on a phone or computer
 * (your profile, Quick Connect), and we ask every couple of seconds until it
 * has been. Servers with Quick Connect turned off take a username and
 * password instead.
 *
 * Requests carry the sign-in in an Authorization header (Jellyfin answers
 * the browser's CORS preflight). Addresses the video player loads itself
 * (files, HLS, subtitles) carry it as ApiKey in the query string.
 *
 * Playing: we tell the server what a browser plays (a device profile) and it
 * picks. Files the browser plays as they are (MP4 with H.264 and AAC or MP3;
 * WebM) come straight from it, which lets you seek anywhere at once; anything
 * else goes through its transcoder as HLS (H.264 and AAC in MPEG-TS), copying
 * what the browser can take. Text subtitles, in a file next to the video or
 * inside it, come as WebVTT for our own subtitle display; picture subtitles
 * (PGS, DVD) are drawn into the picture by the transcoder. Progress goes to
 * Jellyfin as it plays.
 */
(function () {
  "use strict";
  const PRODUCT = "Watchening", VERSION = "1.0";
  const PORT = 8096;
  const TICKS = 1e7; // Jellyfin's times are in 100 ns ticks
  const CODE_LIFE = 9 * 60 * 1000; // Quick Connect codes last 10 minutes
  // what list items come with (beyond the basics)
  const FIELDS = "Overview,Genres,DateCreated,DateLastMediaAdded,ChildCount,RecursiveItemCount,Width,Height";

  const UA = navigator.userAgent;
  const BROWSER = /Firefox\//.test(UA) ? "Firefox" : /Edg\//.test(UA) ? "Edge"
    : /Safari\//.test(UA) && !/Chrom(e|ium)\//.test(UA) ? "Safari" : "Chrome";
  /** Who's asking: shown in Jellyfin's Dashboard under Devices and Activity. */
  function authHeader(token) {
    const parts = { Client: PRODUCT, Device: BROWSER, DeviceId: OnDemand.deviceId(), Version: VERSION };
    if (token) parts.Token = token;
    return "MediaBrowser " + Object.entries(parts).map(([k, v]) => `${k}="${encodeURIComponent(v)}"`).join(", ");
  }

  function url(base, path, params) {
    const u = new URL(base.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== "") u.searchParams.set(k, v);
    return u.href;
  }
  /** Set a query parameter, replacing it in any letter case. */
  function setParam(u, k, v) {
    for (const key of [...u.searchParams.keys()]) if (key.toLowerCase() === k.toLowerCase()) u.searchParams.delete(key);
    u.searchParams.set(k, v);
  }

  /**
   * A request; its JSON. opts: { token, params, method, body (sent as JSON),
   * timeout, keepalive }. Errors carry `net` (no answer), `auth` (token
   * refused) and `status`.
   */
  async function call(base, path, opts) {
    const { token, params, method = "GET", body, timeout = 15000, keepalive } = opts || {};
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const headers = { Accept: "application/json", Authorization: authHeader(token) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch(url(base, path, params), {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal, cache: "no-store", keepalive: !!keepalive,
      });
    } catch {
      throw Object.assign(new Error(ctl.signal.aborted ? "The server didn't answer" : "Couldn't reach the server"), { net: true });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) throw Object.assign(new Error("Jellyfin didn't accept the sign-in. Sign in again in Settings"), { auth: true, status: 401 });
    if (!res.ok) throw Object.assign(new Error(`Jellyfin answered ${res.status}${res.statusText ? " " + res.statusText : ""}`), { status: res.status });
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { throw new Error("Jellyfin sent an answer this player doesn't understand"); }
  }
  /** A request to a source's server, signed in. */
  const api = (src, path, params, opts) => call(src.server.uri, path, Object.assign({}, opts, { token: src.server.token, params }));
  /** Query parameters, with the signed-in user. */
  const user = (src, params) => Object.assign({ userId: src.server.userId }, params);
  /** Fire and forget (progress reports): `keepalive` lets it outlive the page. */
  const send = (src, path, body, keepalive) => api(src, path, {}, { method: "POST", body, keepalive }).catch(() => {});

  // --------------------------------------------------------------- servers
  // Pages opened over https can't fetch http:// addresses.
  const reachable = (uri) => location.protocol !== "https:" || /^https:/i.test(uri);

  /** What was typed -> the addresses it could mean, likeliest first. */
  function candidates(text) {
    const t = text.trim();
    const typed = /^https?:\/\//i.test(t);
    let u;
    try { u = new URL(typed ? t : "http://" + t); } catch { return null; }
    const path = u.pathname.replace(/\/+$/, "");
    const at = (scheme, port) => `${scheme}//${u.hostname}${port ? ":" + port : ""}${path}`;
    if (typed) return [u.origin + path];
    if (u.port) return [at("http:", u.port), at("https:", u.port)];
    return [at("http:", PORT), at("https:"), at("http:")];
  }

  /** The Jellyfin server at an address as typed: { uri, info }. All the
   *  addresses it could mean are tried at once; the likeliest that answers wins. */
  async function findServer(text) {
    const all = candidates(text);
    if (!all) throw new Error("That doesn't look like a server address.");
    const list = all.filter(reachable);
    if (!list.length) throw new Error("This page was opened over https://, so it can't reach an http:// server. Use the server's https:// address, or open this page over http:// instead.");
    const tries = list.map((uri) => call(uri, "/System/Info/Public", { timeout: 8000 }).then((info) => ({ uri, info })));
    tries.forEach((p) => p.catch(() => {}));
    let answered = null, err = null;
    for (const p of tries) {
      try {
        const r = await p;
        if (r.info && r.info.Id && /jellyfin/i.test(r.info.ProductName || "")) return check(r);
        answered = answered || r;
      } catch (e) { err = err || e; }
    }
    if (answered) throw new Error("That address answered, but it isn't a Jellyfin server.");
    throw new Error(`${(err && err.message) || "No answer"}. Check the address, and that the server is turned on.`);
  }
  function check(found) {
    const [major, minor] = String(found.info.Version || "").split(".").map(Number);
    if (major < 10 || (major === 10 && minor < 9)) {
      throw new Error(`${found.info.ServerName || "This server"} runs Jellyfin ${found.info.Version}. Update it to 10.9 or later to use it here.`);
    }
    return found;
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
  const TYPES = { Movie: "movie", Video: "movie", MusicVideo: "movie", Trailer: "movie", Series: "show", Season: "season", Episode: "episode" };

  /** Jellyfin item -> On Demand item. ctx: { mixed (titles from several
   *  shows: say which), cat (a show's color, for its seasons and episodes),
   *  lib (the library it came from) } */
  function item(m, ctx) {
    const type = TYPES[m.Type] || String(m.Type || "").toLowerCase();
    const ud = m.UserData || {};
    const count = type === "season" ? m.ChildCount || m.RecursiveItemCount || 0 : type === "show" ? m.RecursiveItemCount || 0 : 0;
    const it = {
      id: m.Id, type, title: m.Name || "",
      year: m.ProductionYear || 0, rating: m.OfficialRating || "",
      dur: (m.RunTimeTicks || 0) / TICKS, offset: (ud.PlaybackPositionTicks || 0) / TICKS,
      watched: !!ud.Played,
      desc: m.Overview || "", hd: (m.Width || 0) >= 1260 || (m.Height || 0) >= 700,
      stars: (m.CommunityRating || 0) / 2,
      show: type === "episode" || type === "season" ? m.SeriesName || "" : "",
      season: type === "episode" ? m.ParentIndexNumber : type === "season" ? m.IndexNumber : undefined,
      episode: type === "episode" ? m.IndexNumber : undefined,
      count, unwatched: Math.max(0, ud.UnplayedItemCount || 0), seasons: type === "show" ? m.ChildCount || 0 : 0,
      aired: String(m.PremiereDate || "").slice(0, 10),
      cat: catOf(type, m.Genres || [], ctx && ctx.cat),
      lib: (ctx && ctx.lib) || "",
      series: m.SeriesId || "", // a season's show, to list its episodes
    };
    if (ctx && ctx.mixed && it.show) it.label = `${it.show}: ${it.title}`;
    return it;
  }
  const none = () => ({ items: [], total: 0, next: null });

  const PAGE = 300;
  /** A list, a page at a time: { items, total, next } */
  async function paged(src, path, q, ctx, max) {
    const page = async (start, size) => {
      const r = await api(src, path, Object.assign({ fields: FIELDS, enableImages: false, enableTotalRecordCount: true }, q, { startIndex: start, limit: size }));
      return { items: (r.Items || []).map((m) => item(m, ctx)), total: r.TotalRecordCount };
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

  /** The user's movie and TV show libraries. */
  async function libraries(src) {
    const r = await api(src, "/UserViews", user(src));
    return (r.Items || [])
      .filter((d) => d.CollectionType === "movies" || d.CollectionType === "tvshows")
      .map((d) => ({ id: d.Id, type: "library", kind: d.CollectionType === "tvshows" ? "show" : "movie", title: d.Name || "Library" }));
  }

  async function root(src) {
    const libs = await libraries(src);
    if (!libs.length) return [];
    const out = [];
    try {
      const one = { limit: 1, enableImages: false, enableTotalRecordCount: false };
      const [started, next] = await Promise.all([
        api(src, "/UserItems/Resume", user(src, Object.assign({ mediaTypes: "Video" }, one))),
        api(src, "/Shows/NextUp", user(src, one)),
      ]);
      if ((started.Items || []).length || (next.Items || []).length) out.push({ id: "ondeck", type: "folder", title: "Continue Watching" });
    } catch { /* leave it out */ }
    out.push({ id: "recent", type: "folder", title: "Recently Added" });
    return out.concat(libs);
  }

  /** Raw items from each library, tagged with it (so hidden ones can be left out). */
  async function fromEach(src, ask) {
    const libs = await libraries(src);
    const per = await Promise.all(libs.map(async (lib) => (await ask(lib)).map((m) => ({ m, lib: lib.id }))));
    return per.flat();
  }
  const time = (s) => Date.parse(s || "") || 0;
  const items = (r) => (Array.isArray(r) ? r : (r && r.Items) || []);

  /** Continue Watching: what you've started (last watched first), then the
   *  next episode of shows you're watching. One entry per show. */
  async function onDeck(src) {
    const q = (lib) => user(src, { parentId: lib.id, limit: 50, fields: FIELDS, enableImages: false });
    const [started, next] = await Promise.all([
      fromEach(src, async (lib) => items(await api(src, "/UserItems/Resume", Object.assign(q(lib), { mediaTypes: "Video" })))),
      fromEach(src, async (lib) => (lib.kind === "show" ? items(await api(src, "/Shows/NextUp", q(lib)).catch(() => null)) : [])),
    ]);
    started.sort((a, b) => time((b.m.UserData || {}).LastPlayedDate) - time((a.m.UserData || {}).LastPlayedDate));
    const seen = new Set(), out = [];
    for (const { m, lib } of started.concat(next)) {
      const k = m.SeriesId || m.Id;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item(m, { mixed: true, lib }));
    }
    return { items: out, total: out.length, next: null };
  }

  /** Recently Added: newest first; several new episodes of a show come as the show. */
  async function recent(src) {
    const all = await fromEach(src, async (lib) =>
      items(await api(src, "/Items/Latest", user(src, { parentId: lib.id, limit: 50, groupItems: true, fields: FIELDS, enableImages: false }))));
    const added = (m) => time(m.DateLastMediaAdded) || time(m.DateCreated);
    const out = all.sort((a, b) => added(b.m) - added(a.m)).slice(0, 100).map(({ m, lib }) => item(m, { mixed: true, lib }));
    return { items: out, total: out.length, next: null };
  }

  const ORDERS = [
    { id: "az", label: "A-Z", q: { sortBy: "SortName", sortOrder: "Ascending" } },
    { id: "recent", label: "Recently Added", q: { sortBy: "DateCreated,SortName", sortOrder: "Descending,Ascending" } },
    { id: "unwatched", label: "Unwatched", q: { sortBy: "SortName", sortOrder: "Ascending", filters: "IsUnplayed" } },
    { id: "newest", label: "Newest", q: { sortBy: "PremiereDate,ProductionYear,SortName", sortOrder: "Descending,Descending,Ascending" } },
  ];
  async function views(src, it) {
    if (it.type !== "library") return null;
    let genres = [];
    try {
      const r = await api(src, "/Genres", user(src, { parentId: it.id, sortBy: "SortName", enableImages: false }));
      genres = items(r).map((g) => ({ id: "genre:" + g.Id, label: g.Name, q: { sortBy: "SortName", sortOrder: "Ascending", genreIds: g.Id } }));
    } catch { /* orders only */ }
    return ORDERS.concat(genres);
  }

  /** A library's movies or shows. */
  const libQuery = (src, lib, q) =>
    user(src, Object.assign({ parentId: lib.id, includeItemTypes: lib.kind === "show" ? "Series" : "Movie", recursive: true }, q));

  async function list(src, it, view) {
    switch (it.type) {
      case "library": return paged(src, "/Items", libQuery(src, it, (view || ORDERS[0]).q), { lib: it.id });
      case "folder": return it.id === "ondeck" ? onDeck(src) : recent(src);
      case "show": {
        // one season: straight to its episodes
        const seasons = await paged(src, `/Shows/${it.id}/Seasons`, user(src), { cat: it.cat });
        if (seasons.items.length === 1 && seasons.items[0].type === "season") return list(src, seasons.items[0], null);
        return seasons;
      }
      case "season": return paged(src, `/Shows/${it.series}/Episodes`, user(src, { seasonId: it.id }), { cat: it.cat });
    }
    return none();
  }

  /** A library's titles matching what's typed (Jellyfin's own search). */
  async function search(src, it, query) {
    if (it.type !== "library") return none();
    return paged(src, "/Items", libQuery(src, it, { searchTerm: query }), { lib: it.id }, 100);
  }

  /** Every episode of a show (all its seasons) or of a season. */
  async function episodes(src, it) {
    const res = it.type === "show"
      ? await paged(src, `/Shows/${it.id}/Episodes`, user(src), { cat: it.cat })
      : await paged(src, `/Shows/${it.series}/Episodes`, user(src, { seasonId: it.id }), { cat: it.cat });
    const out = res.items.slice();
    for (let more; res.next && (more = await res.next());) out.push(...more);
    return out.filter((x) => x.type === "episode");
  }

  /** A movie's trailer, ready to play, or null. Only trailer files on the
   *  server (Jellyfin's links to online trailers can't play here). */
  async function trailer(src, it) {
    const t = items(await api(src, `/Items/${it.id}/LocalTrailers`, user(src)))[0];
    if (!t) return null;
    return Object.assign(item(t), {
      type: "movie", title: it.title, year: it.year, rating: "", desc: it.desc, extra: "Trailer", watched: false, offset: 0,
    });
  }

  // ---------------------------------------------------------------- playing
  /** What this player can take, for the server to decide how to send a title. */
  function profile(q) {
    const max = q.kbps * 1000;
    return {
      Name: PRODUCT, MaxStreamingBitrate: max, MaxStaticBitrate: max,
      DirectPlayProfiles: [
        { Type: "Video", Container: "mp4,m4v,mov", VideoCodec: "h264", AudioCodec: "aac,mp3" },
        { Type: "Video", Container: "webm", VideoCodec: "vp8,vp9,av1", AudioCodec: "opus,vorbis" },
      ],
      TranscodingProfiles: [
        { Type: "Video", Context: "Streaming", Protocol: "hls", Container: "ts", VideoCodec: "h264", AudioCodec: "aac,mp3", MaxAudioChannels: "6" },
      ],
      // browsers don't play 10-bit H.264
      CodecProfiles: [
        { Type: "Video", Codec: "h264", Conditions: [{ Condition: "LessThanEqual", Property: "VideoBitDepth", Value: "8", IsRequired: false }] },
      ],
      // text subtitles come to us as files (we fetch them as WebVTT); the
      // rest the server draws into the picture
      SubtitleProfiles: [{ Format: "vtt", Method: "External" }, { Format: "srt", Method: "External" }],
      ContainerProfiles: [], ResponseProfiles: [],
    };
  }
  const TEXT_SUBS = /^(srt|subrip|vtt|webvtt|ass|ssa|mov_text|text|smi|sami|ttml)$/i;
  const isText = (x) => (x.IsTextSubtitleStream != null ? !!x.IsTextSubtitleStream : TEXT_SUBS.test(x.Codec || ""));
  const ERRORS = {
    NotAllowed: "Your Jellyfin account isn't allowed to play this",
    NoCompatibleStream: "Jellyfin can't convert this title for this browser",
    RateLimitExceeded: "Your Jellyfin account is already streaming as much as it's allowed to",
  };

  /**
   * opts: { fromStart, at (seconds: start there), burn (a picture subtitle
   * stream to draw in; undefined: whatever Jellyfin picks for this title and
   * user, null: none) }
   */
  async function play(src, it, opts) {
    const s = src.server, q = OnDemand.quality();
    const body = {
      UserId: s.userId, DeviceProfile: profile(q), MaxStreamingBitrate: q.kbps * 1000,
      EnableDirectPlay: true, EnableDirectStream: true, EnableTranscoding: true,
      AllowVideoStreamCopy: true, AllowAudioStreamCopy: true, AutoOpenLiveStream: true,
    };
    if (opts.burn !== undefined) body.SubtitleStreamIndex = opts.burn == null ? -1 : opts.burn;
    const [m, info] = await Promise.all([
      api(src, `/Items/${it.id}`, user(src)),
      api(src, `/Items/${it.id}/PlaybackInfo`, {}, { method: "POST", body, timeout: 30000 }),
    ]);
    if (info.ErrorCode) throw new Error(ERRORS[info.ErrorCode] || `Jellyfin can't play this title (${info.ErrorCode})`);
    const ms = (info.MediaSources || [])[0];
    if (!ms) throw new Error("Jellyfin has no video file for this title");
    const dur = (ms.RunTimeTicks || m.RunTimeTicks || 0) / TICKS;
    const start = opts.at != null ? opts.at : opts.fromStart ? 0 : ((m.UserData || {}).PlaybackPositionTicks || 0) / TICKS;

    const subs = (ms.MediaStreams || []).filter((x) => x.Type === "Subtitle").map((x) => ({
      id: x.Index, label: x.DisplayTitle || x.Language || "Subtitles", selected: x.Index === ms.DefaultSubtitleStreamIndex,
      url: isText(x) ? url(s.uri, `/Videos/${it.id}/${ms.Id}/Subtitles/${x.Index}/0/Stream.vtt`, { ApiKey: s.token }) : "",
    }));
    // Jellyfin's own pick (the user's subtitle settings) is drawn in if it's a picture one
    let burn = opts.burn;
    if (burn === undefined) { const sel = subs.find((x) => x.selected && !x.url); burn = sel ? sel.id : null; }
    const base = { start, dur, subs, burn, session: info.PlaySessionId || "", source: ms.Id };

    if (ms.SupportsDirectPlay) {
      const boxes = String(ms.Container || "").toLowerCase().split(",");
      const ext = boxes.includes("mp4") ? ".mp4" : boxes[0] ? "." + boxes[0] : "";
      return Object.assign(base, {
        method: "DirectPlay",
        url: url(s.uri, `/Videos/${it.id}/stream${ext}`, { static: true, mediaSourceId: ms.Id, deviceId: OnDemand.deviceId(), playSessionId: base.session, ApiKey: s.token }),
      });
    }
    if (!ms.TranscodingUrl) throw new Error("Jellyfin can't play this title in this browser");
    const t = new URL(s.uri.replace(/\/+$/, "") + ms.TranscodingUrl);
    if (q.id !== "original") {
      const [w, h] = q.res.split("x");
      setParam(t, "maxWidth", w);
      setParam(t, "maxHeight", h);
    }
    setParam(t, "ApiKey", s.token);
    return Object.assign(base, { method: "Transcode", url: t.href });
  }

  const progress = (it, pl, sec) => ({
    ItemId: it.id, MediaSourceId: pl.source, PlaySessionId: pl.session,
    PositionTicks: Math.max(0, Math.round(sec * TICKS)),
  });
  function report(src, it, pl, state, sec) {
    const body = Object.assign(progress(it, pl, sec), { IsPaused: state === "paused", PlayMethod: pl.method, CanSeek: true });
    if (!pl.started) {
      pl.started = true;
      send(src, "/Sessions/Playing", body);
    } else send(src, "/Sessions/Playing/Progress", Object.assign(body, { EventName: state === "paused" ? "Pause" : "TimeUpdate" }));
  }
  /** Stop the transcoder working on a stream. */
  function release(src, pl, keepalive) {
    if (pl.method !== "Transcode" || !pl.session) return;
    api(src, "/Videos/ActiveEncodings", { deviceId: OnDemand.deviceId(), playSessionId: pl.session }, { method: "DELETE", keepalive }).catch(() => {});
  }

  // ---------------------------------------------------------------- sign in
  /** Signed in (`auth`: Jellyfin's answer): add the server, unless the
   *  dialog was cancelled meanwhile. */
  function signedIn(found, auth, opts) {
    if (!Dialog.is(opts)) return;
    const u = auth.User || {};
    if (!auth.AccessToken || !u.Id) return Dialog.message("Jellyfin didn't sign in. Try again.", true);
    const name = found.info.ServerName || "Jellyfin";
    OnDemand.addSource({
      id: `jellyfin:${found.info.Id}:${u.Id}`, type: "jellyfin", name, user: u.Name || "",
      server: { id: found.info.Id, uri: found.uri, token: auth.AccessToken, userId: u.Id },
    });
    Dialog.close();
    App.osd(`Added ${name}`, 3500);
  }

  function signIn() {
    const was = Store.cfg.vod.sources.find((s) => s.type === "jellyfin");
    Dialog.open({
      title: "Sign In to Jellyfin",
      text: "Your Jellyfin server's address: the one you open Jellyfin at in a browser.",
      fields: [{ id: "addr", label: "Server address", value: was ? was.server.uri : "", placeholder: `http://192.168.1.20:${PORT}` }],
      buttons: [
        {
          label: "Next",
          act: async (v) => {
            if (!v.addr) { Dialog.message("Enter the server's address first.", true); return false; }
            Dialog.message("Connecting...");
            let found;
            try { found = await findServer(v.addr); } catch (e) { Dialog.message(e.message, true); return false; }
            try { found.qc = (await call(found.uri, "/QuickConnect/Enabled", { timeout: 8000 })) === true; } catch { found.qc = false; }
            return found.qc ? quickConnect(found) : password(found);
          },
        },
        { label: "Cancel" },
      ],
    });
  }

  function quickConnect(found) {
    let alive = true, timer = 0;
    const stop = () => { alive = false; clearTimeout(timer); };
    const opts = {
      title: `Sign In to ${found.info.ServerName || "Jellyfin"}`,
      text: "Getting a code...",
      buttons: [
        { label: "Sign In with Password Instead", act: () => { stop(); password(found); } },
        { label: "Cancel", act: stop },
      ],
      onCancel: stop,
    };
    Dialog.open(opts);
    const still = () => alive && Dialog.is(opts);
    let secret = "", born = 0;
    const newCode = async () => {
      const r = await call(found.uri, "/QuickConnect/Initiate", { method: "POST" });
      if (!r.Secret || !r.Code) throw new Error("Jellyfin didn't give a code");
      secret = r.Secret;
      born = Date.now();
      if (!still()) return;
      Dialog.message("In Jellyfin on your phone or computer, open your profile, choose Quick Connect, and enter this code:");
      Dialog.big(r.Code);
    };
    const poll = async () => {
      if (!still()) return;
      try {
        if (Date.now() - born > CODE_LIFE) await newCode();
        const r = await call(found.uri, "/QuickConnect/Connect", { params: { secret } });
        if (!still()) return;
        if (r.Authenticated) {
          stop();
          Dialog.big("");
          Dialog.message("Signing in...");
          try {
            signedIn(found, await call(found.uri, "/Users/AuthenticateWithQuickConnect", { method: "POST", body: { Secret: secret } }), opts);
          } catch (e) {
            if (Dialog.is(opts)) Dialog.message(e.message, true);
          }
          return;
        }
      } catch (e) {
        if (e.status === 404) born = 0; // the code ran out: a new one
      }
      if (still()) timer = setTimeout(poll, 2000);
    };
    newCode().then(() => { if (still()) timer = setTimeout(poll, 2000); }, (e) => {
      if (still()) Dialog.message(`Couldn't get a code from Jellyfin: ${e.auth ? "Quick Connect is turned off on this server" : e.message}`, true);
    });
  }

  function password(found) {
    const opts = {
      title: `Sign In to ${found.info.ServerName || "Jellyfin"}`,
      text: "Your Jellyfin username and password.",
      fields: [{ id: "user", label: "Username" }, { id: "pw", label: "Password", type: "password" }],
      buttons: [
        {
          label: "Sign In",
          act: async (v) => {
            if (!v.user) { Dialog.message("Enter your username first.", true); return false; }
            Dialog.message("Signing in...");
            let auth;
            try {
              auth = await call(found.uri, "/Users/AuthenticateByName", { method: "POST", body: { Username: v.user, Pw: v.pw } });
            } catch (e) {
              Dialog.message(e.auth ? "Jellyfin didn't accept that username and password." : e.message, true);
              return false;
            }
            signedIn(found, auth, opts);
            return false; // (signedIn closes it)
          },
        },
        found.qc && { label: "Use Quick Connect Instead", act: () => quickConnect(found) },
        { label: "Cancel" },
      ].filter(Boolean),
    };
    Dialog.open(opts);
  }

  // ------------------------------------------------------------- provider
  OnDemand.register("jellyfin", {
    label: "Jellyfin",
    setup: [
      {
        text: "Sign In to Jellyfin",
        desc: "Watch the movies and shows on your Jellyfin server. You'll give its address, then enter a code in Jellyfin on your phone or computer (Quick Connect), or your username and password.",
        act: signIn,
      },
    ],
    describe(src) {
      return `Jellyfin server${src.user ? `, signed in as ${src.user}` : ""}. Address: ${src.server.uri}`;
    },
    root, views, list, search, play, release, episodes, trailer,
    report,
    stopped(src, it, pl, sec, leaving) {
      release(src, pl, leaving);
      return send(src, "/Sessions/Playing/Stopped", progress(it, pl, sec), leaving);
    },
    async setWatched(src, it, on) {
      await api(src, `/UserPlayedItems/${it.id}`, user(src), { method: on ? "POST" : "DELETE" });
    },
  });
})();
