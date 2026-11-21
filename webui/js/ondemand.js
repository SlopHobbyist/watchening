/*
 * On Demand: movies and shows from media servers, browsed like the original
 * box's ON DEMAND Menu. The guide's header, info panel and picture stay (the
 * info panel's first line names the screen: "ON DEMAND Menu", "Movies");
 * below them, menus are rounded buttons two to a row, and lists of titles one
 * wide button per row with the episode or year and how much is left, with
 * "More ▼ Choices" under them when the list goes on. A library opens a menu
 * of its orders and genres ("A-Z", "Recently Added", "Comedy"), as the
 * original's categories opened into sub-categories.
 *
 * Sources are pluggable: Store.cfg.vod.sources holds { id, type, name, ... }
 * and the provider for its type (OnDemand.register) does the talking.
 *
 *   provider = {
 *     label                               "Plex", "Jellyfin"
 *     setup: [{ text, desc, act }]        ways to add a source (sign in, ...)
 *     describe(src)                       a line about a source, for Settings
 *     reconnect(src)                      find the server again (optional)
 *     root(src)                -> [item]  its libraries and folders
 *     views(src, item)         -> [{ id, label }] | null   a library's orders / genres (its menu)
 *     list(src, item, view)    -> { items, total, next() -> [item] | null }
 *     search(src, library, query) -> { items, total, next }   titles matching (optional)
 *     play(src, item, { fromStart, at, burn, version })
 *                              -> { url, start, dur, subs: [{ id, label, url, selected }], burn, ours }
 *                                 (subs with a url are text files we show ourselves;
 *                                 the others are drawn into the picture: `burn`;
 *                                 ours: the url is this site's own stream proxy)
 *     versions(src, item)  -> [{ id, label, tag, desc, warn }]   the files a title
 *                                 can play from, best first (optional: Choose Version)
 *     report(src, item, play, state, sec)      "playing" | "paused", as it plays
 *     stopped(src, item, play, sec, leaving)   (leaving: the page is closing)
 *     release(src, play)                       let go of a stream (optional)
 *     setSubtitle(src, play, sub | null)       remember the subtitle pick (optional)
 *     setWatched(src, item, on)
 *     episodes(src, show | season) -> [item]   every episode, for Shuffle (optional)
 *     trailer(src, movie)  -> item | null      its trailer, to play (optional)
 *   }
 *   item = { id, type: library | folder | movie | show | season | episode,
 *            title, label (title in mixed lists), year, rating, dur, offset (sec),
 *            watched, desc, hd, stars (0-5), show, season, episode, count,
 *            unwatched, seasons, aired ("2008-01-20"), cat (movie | kids | sports | ""),
 *            lib (the library it's in, in mixed lists), extra ("Trailer") }
 *   (a library: kind movie | show | mixed, and desc to say what it is, optional)
 *
 * Libraries can be hidden (Settings, On Demand): Store.cfg.vod.hiddenLibs.
 * A show's seasons and a season's episodes start with Shuffle and Shuffle
 * Unwatched, which play a random episode. A library's menu starts with
 * Search: an on-screen keyboard (see "search" below).
 *
 * Keys: ▲▼◀▶ select (in a list of titles ◀ goes back) · OK open or play ·
 *       Back up a level, and from the top to the guide · PgUp/PgDn page ·
 *       O closes (back to wherever On Demand was opened from)
 * Search: the on-screen keyboard (keyboard.js) · Back leaves
 */
(function () {
  "use strict";
  const { $ } = U;
  const ROWS = 5;                      // button rows on screen
  const ROW_TOP = (k) => 18 + k * 52;  // a button row's offset inside #v-menu

  const providers = {};
  /** Saved sources whose provider is loaded. */
  const sources = () => Store.cfg.vod.sources.filter((s) => providers[s.type]);

  // Picture quality for streams a server converts (the most it may send).
  // Automatic: what this TV's connection to the server carries (see
  // streamQuality). "max" was "original" when Original was the default,
  // which sent remote viewers more than a home connection uploads; those
  // settings get Automatic now (which is Original on a fast connection).
  const QUALITY = [
    { id: "auto", label: "Automatic", kbps: 0, res: "" },
    { id: "max", label: "Original", kbps: 200000, res: "3840x2160" },
    { id: "20", label: "20 Mbps 1080p", kbps: 20000, res: "1920x1080" },
    { id: "12", label: "12 Mbps 1080p", kbps: 12000, res: "1920x1080" },
    { id: "8", label: "8 Mbps 1080p", kbps: 8000, res: "1920x1080" },
    { id: "4", label: "4 Mbps 720p", kbps: 4000, res: "1280x720" },
    { id: "2", label: "2 Mbps 720p", kbps: 2000, res: "1280x720" },
    { id: "1", label: "1.5 Mbps 480p", kbps: 1500, res: "854x480" },
  ];
  const quality = () => QUALITY.find((q) => q.id === Store.cfg.vod.quality) || QUALITY[0];

  // ------------------------------------------------------------- bandwidth
  /*
   * Automatic quality needs to know how fast each server reaches this TV
   * (kbps). It's measured as titles play (Player's "bw": each piece of an HLS
   * stream as it arrives) and, when there's no recent measurement, by reading
   * the start of the title's file for a couple of seconds before playing. Kept
   * per TV, not in the synced settings: the same server is fast at home and
   * slow from a friend's house.
   */
  const BW_KEY = "iptv.vod.bw.v1", BW_FRESH = 20 * 60e3;
  const HEADROOM = 0.7;  // of the measured speed a stream may use (speeds vary; there's audio too)
  const GUESS = 6000;    // when nothing could be measured
  const FLOOR = 600;     // the least Automatic asks for
  const bw = (() => { try { return JSON.parse(localStorage.getItem(BW_KEY) || "null") || {}; } catch { return {}; } })();
  const freshBw = (src) => { const o = bw[src.id]; return o && Date.now() - o.at < BW_FRESH ? o.kbps : 0; };
  /** A measurement: slower ones count for more, so a slowdown is noticed quickly. */
  function noteBw(src, kbps, weight) {
    const old = freshBw(src);
    const w = weight != null ? weight : kbps < old ? 0.5 : 0.25;
    bw[src.id] = { kbps: Math.round(old ? old * (1 - w) + kbps * w : kbps), at: Date.now() };
    try { localStorage.setItem(BW_KEY, JSON.stringify(bw)); } catch { /* */ }
  }
  /** Read the start of `href` for about two seconds: kbps, or 0. */
  async function probe(href) {
    const ctl = new AbortController();
    const give = setTimeout(() => ctl.abort(), 6000);
    try {
      const res = await fetch(href, { signal: ctl.signal, cache: "no-store" });
      if (!res.ok || !res.body) return 0;
      const rd = res.body.getReader();
      let t0 = 0, bytes = 0, ms = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        const now = performance.now();
        if (!t0) { t0 = now; continue; } // timed from the first bytes, not the wait for them
        bytes += value.length;
        ms = now - t0;
        if (ms > 2000 || bytes > 16e6) break;
      }
      return ms > 100 && bytes > 256e3 ? (bytes * 8) / ms : 0;
    } catch {
      return 0;
    } finally {
      clearTimeout(give);
      ctl.abort();
    }
  }
  /** Most a stream may use for `kbps` of connection: { kbps, res, auto } */
  function fitTo(kbps) {
    kbps = Math.round(Math.max(FLOOR, Math.min(200000, kbps)));
    const rung = QUALITY.find((x) => x.kbps && x.kbps <= kbps) || QUALITY[QUALITY.length - 1];
    // a fast connection: the server keeps the picture's size
    return { kbps, res: kbps >= 20000 ? "3840x2160" : rung.res, auto: true };
  }
  /**
   * The most a title may be sent at, from `src`, for a provider's play():
   * { kbps, res, auto }. The quality setting, or with Automatic, what this
   * TV's connection carries: measured just now if it hasn't been lately
   * (`probeUrl`: the title's file, read for a moment). opts.kbps: stepping
   * down while it plays (see below).
   */
  async function streamQuality(src, opts, probeUrl) {
    const q = quality();
    if (q.id !== "auto") return { kbps: q.kbps, res: q.res, auto: false };
    if (opts && opts.kbps) return fitTo(opts.kbps);
    let kbps = freshBw(src);
    if (!kbps) {
      kbps = probeUrl ? await probe(probeUrl) : 0;
      if (kbps) noteBw(src, kbps, 1);
      else kbps = (bw[src.id] && bw[src.id].kbps) || GUESS;
    }
    return fitTo(kbps * HEADROOM);
  }
  Player.on((type, kbps) => {
    const v = type === "bw" && App.vod();
    if (v && Player.ch === v) noteBw(v.src, kbps);
  });

  // ---------------------------------------------------------------- levels
  /*
   * The screens you've gone through, top one showing:
   *   { root, title, src, item, view, pick, rows, total, sel, top,
   *     loading, error, stale, run }
   * pick: a library's menu of its orders and genres (its rows carry a view);
   * view: the order or genre a list was opened with. top is the first button
   * row on screen.
   */
  const OD = { stack: [] };
  const cur = () => OD.stack[OD.stack.length - 1];
  function level(o) {
    return Object.assign({ rows: [], total: 0, sel: 0, top: 0, view: null, pick: false, loading: true, error: "", stale: false, run: 0 }, o);
  }
  const viewKey = (src, it) => `${src.id}:${it.id}`;
  /** Whether a library (by id) is hidden from On Demand. */
  const libHidden = (src, id) => id != null && id !== "" && Store.cfg.vod.hiddenLibs.includes(`${src.id}:${id}`);
  /** Titles (and a title's versions) get one wide button per row; menus two narrow ones. */
  const isWide = (lv) => !!lv.versions || lv.rows.some((r) => r.item && playable(r.item));
  const cols = (lv) => (isWide(lv) ? 1 : 2);

  // ------------------------------------------------------------ formatting
  /** 6720 -> "1h 52m" */
  function fmtLen(sec) {
    const m = Math.round((sec || 0) / 60);
    if (!m) return "";
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
  }
  /** "2008-01-20" -> "1/20/2008" */
  function fmtAired(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    return m ? `${+m[2]}/${+m[3]}/${m[1]}` : "";
  }
  const epCode = (it) =>
    it.season != null && it.episode != null ? `S${it.season} E${it.episode}`
      : it.episode != null ? `Ep ${it.episode}` : fmtAired(it.aired);
  /** A source's name in the left column: the provider, unless there are two of a kind. */
  const srcLabel = (src) =>
    sources().filter((s) => s.type === src.type).length > 1 ? src.name : providers[src.type].label;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const join = (parts) => parts.filter(Boolean).join(", ");
  /** 0-5 stars, to the half star. */
  const stars = (n) => U.stars(Math.round((n || 0) * 2) / 2);
  const playable = (it) => it.type === "movie" || it.type === "episode";
  const hasResume = (it) => it.offset > 5 && !(it.dur && it.offset > it.dur - 30);

  /** The note before a title on its button: the episode, or the year. */
  function leftText(src, it) {
    switch (it.type) {
      case "movie": return it.year ? String(it.year) : "";
      case "episode": return epCode(it);
    }
    return "";
  }
  /** The note at the end of a row: how much is left, or that it's been seen. */
  function tagText(it) {
    if (playable(it)) {
      if (hasResume(it) && it.dur) return `${Math.max(1, Math.round((it.dur - it.offset) / 60))}m left`;
      return it.watched ? "Watched" : "";
    }
    if (it.type === "show" || it.type === "season") {
      if (it.count && it.watched) return "Watched";
      if (it.unwatched && it.unwatched < it.count) return `${it.unwatched} Unwatched`;
    }
    return "";
  }
  function lenLine(it) {
    const note = hasResume(it) ? `Resume at ${U.fmtDur(it.offset)}` : it.watched ? "Watched" : "";
    return [fmtLen(it.dur), note].filter(Boolean).join(" · ");
  }
  function countLine(it) {
    if (!it.count) return "";
    const n = plural(it.count, "Episode");
    return it.watched ? n + " · Watched" : it.unwatched < it.count ? `${n} · ${it.unwatched} Unwatched` : n;
  }

  /** What the info panel says about an item (also the banner's description). */
  function itemInfo(src, it) {
    const badges = App.badgeHtml(it.hd, it.rating);
    switch (it.type) {
      case "library": {
        const what = it.kind === "show" ? "TV shows" : it.kind === "mixed" ? "Movies and TV shows" : "Movies";
        return {
          title: it.title, chan: srcLabel(src), time: it.kind === "show" ? "TV Shows" : it.kind === "mixed" ? "Movies & TV" : "Movies",
          desc: it.desc || `${what} on ${src.name}, from A to Z, newest first, or by genre.`,
        };
      }
      case "folder":
        return {
          title: it.title, chan: srcLabel(src),
          desc: it.id === "ondeck"
            ? `Movies you've started, and the next episode of shows you're watching, on ${src.name}.`
            : `The newest movies and episodes on ${src.name}.`,
        };
      case "movie":
        return {
          title: it.title, chan: srcLabel(src), time: lenLine(it), icons: badges,
          desc: join([it.year && `(${it.year})`, stars(it.stars), it.desc]),
        };
      case "show":
        return {
          title: it.title, chan: it.seasons ? plural(it.seasons, "Season") : srcLabel(src), time: countLine(it), icons: badges,
          desc: join([it.year && `(${it.year})`, it.desc]),
        };
      case "season":
        return { title: it.show || it.title, chan: it.show ? it.title : "", time: countLine(it), desc: it.desc };
      case "episode":
        return {
          title: it.show || it.title, chan: epCode(it), time: lenLine(it), icons: badges,
          desc: join([it.show && `"${it.title}"`, fmtAired(it.aired), it.desc]),
        };
    }
    return { title: it.title, desc: it.desc };
  }

  // ------------------------------------------------------------------ rows
  /** A button: { src, item, left, text, tag } or, for things that aren't
   *  titles, { text, info, act } (or { text, view } in a library's menu). */
  const row = (src, it) => ({ src, item: it, left: leftText(src, it), text: it.label || it.title, tag: tagText(it) });
  /** A list's titles, leaving out those from hidden libraries. */
  const titleRows = (lv, items) => items.filter((it) => !libHidden(lv.src, it.lib)).map((it) => row(lv.src, it));

  /** Shuffle and Shuffle Unwatched, at the top of a show's seasons or a season's episodes. */
  function shuffleRows(lv, items) {
    const it = lv.item, src = lv.src;
    if (!providers[src.type].episodes || !items.length) return [];
    if (it.type !== "show" && it.type !== "season") return [];
    const from = it.type === "season" ? `${it.show ? it.show + ", " : ""}${it.title}`
      : items.some((x) => x.type === "season") ? `any season of ${it.title}` : it.title;
    const title = it.show || it.title;
    return [
      {
        text: "Shuffle",
        info: { title, chan: "Shuffle", desc: `Play a random episode from ${from}.` },
        act: () => shuffle(src, it, false),
      },
      {
        text: "Shuffle Unwatched",
        info: { title, chan: "Shuffle Unwatched", desc: `Play a random episode you haven't watched from ${from}.` },
        act: () => shuffle(src, it, true),
      },
    ];
  }

  /** With no sources: the ways to add one. */
  function setupRows() {
    const out = [];
    for (const [type, p] of Object.entries(providers)) {
      for (const s of p.setup || []) {
        out.push({ text: s.text, info: { title: s.text, chan: p.label, desc: s.desc }, act: s.act, type });
      }
    }
    return out;
  }

  async function rootRows() {
    const srcs = sources();
    if (!srcs.length) return setupRows();
    const several = srcs.length > 1;
    const per = await Promise.all(srcs.map(async (src) => {
      try {
        const all = await providers[src.type].root(src);
        const items = all.filter((it) => it.type !== "library" || !libHidden(src, it.id));
        // with more than one server, say whose "Movies" each one is
        if (items.some((it) => it.type === "library")) return items.map((it) => Object.assign(row(src, it), several ? { text: `${src.name}: ${it.title}` } : {}));
        if (all.some((it) => it.type === "library")) {
          return [{ text: `${src.name}: Libraries Hidden`, info: { title: src.name, desc: "Every library on this server is hidden. Show them again in Settings, On Demand." } }];
        }
        return [{ text: `${src.name}: No Movies or Shows`, info: { title: src.name, desc: "This server has no movie or TV show libraries." } }];
      } catch (e) {
        return [{
          text: `${src.name}: Not Available`, warn: true,
          info: { title: src.name, chan: "Not Available", desc: `${e.message}. OK tries again.` },
          act: () => load(cur()),
        }];
      }
    }));
    return per.flat();
  }

  // ---------------------------------------------------------------- loading
  /** (Re)load a level's rows. `quiet` keeps the old rows up meanwhile and
   *  the selection on the same title. */
  async function load(lv, quiet) {
    if (lv.kb) {
      // the keyboard: nothing to load, but searches from before are old now
      lv.stale = false;
      lv.asks.clear();
      lv.got.clear();
      return render();
    }
    const run = ++lv.run;
    lv.loading = true;
    lv.error = "";
    lv.stale = false;
    if (!quiet) { lv.rows = []; lv.sel = lv.top = 0; }
    render();
    let res = null, extra = [];
    try {
      let rows;
      if (OD.reported) await OD.reported;
      let pickSel = -1;
      if (lv.root) rows = await rootRows();
      else {
        const p = providers[lv.src.type];
        if (lv.pick) {
          // a library: its orders and genres, on the one picked last time
          const views = (await p.views(lv.src, lv.item)) || [];
          if (run !== lv.run) return;
          if (views.length > 1 || p.search) {
            const it = lv.item;
            rows = views.map((v) => ({
              text: v.label, view: v,
              info: { title: v.label, chan: srcLabel(lv.src), desc: `${it.title} on ${lv.src.name}: ${v.label}.` },
            }));
            if (p.search) {
              rows.unshift({
                text: "Search",
                info: { title: "Search", chan: srcLabel(lv.src), desc: `Find something in ${it.title} by typing part of its title.` },
                act: () => openSearch(lv),
              });
            }
            const saved = Store.cfg.vod.views[viewKey(lv.src, it)];
            pickSel = rows.findIndex((r) => r.view && r.view.id === saved);
          } else {
            lv.pick = false; // nothing to pick: straight to the list
            lv.view = views[0] || null;
          }
        }
        if (lv.versions) {
          // a title's versions: the files it can play from
          const it = lv.item;
          rows = (await p.versions(lv.src, it)).map((v) => ({
            text: v.label, tag: v.tag || "", warn: !!v.warn,
            info: { title: it.type === "episode" && it.show ? it.show : it.title, chan: v.tag || "Version", desc: v.desc || v.label },
            act: () => versionDialog(lv.src, it, v),
          }));
        }
        if (!rows && lv.query != null) {
          // search results: what the keyboard already found, unless it pages
          // (its pages were for the preview) or this is a reload
          const f = lv.found;
          lv.found = null;
          let got = null;
          if (f) { try { got = await f; } catch { /* ask again */ } }
          if (run !== lv.run) return;
          res = got && !got.next ? got : await p.search(lv.src, lv.item, lv.query);
          rows = titleRows(lv, res.items);
        }
        if (!rows) {
          res = await p.list(lv.src, lv.item, lv.view);
          extra = shuffleRows(lv, res.items);
          rows = extra.concat(titleRows(lv, res.items));
        }
      }
      if (run !== lv.run) return;
      const keep = quiet && lv.rows[lv.sel]; // where it is now
      lv.rows = rows;
      // what's here, and the titles still to come
      lv.total = res && res.total != null ? rows.length + Math.max(0, res.total - res.items.length) : rows.length;
      lv.loading = false;
      if (keep) {
        const i = rows.findIndex((r) => keep.item
          ? r.item && r.item.id === keep.item.id && r.item.type === keep.item.type
          : r.text === keep.text);
        if (i >= 0) lv.sel = i;
      } else if (pickSel >= 0) lv.sel = pickSel;
      render();
    } catch (e) {
      if (run !== lv.run) return;
      lv.loading = false;
      lv.error = e.message || String(e);
      return render();
    }
    // long lists come in pages: the first shows right away, the rest follow
    try {
      while (res && res.next) {
        const more = await res.next();
        if (run !== lv.run || !more || !more.length) break;
        lv.rows.push(...titleRows(lv, more));
        if (lv === cur()) render();
      }
    } catch { /* keep what came */ }
  }

  function push(o) {
    const lv = level(o);
    OD.stack.push(lv);
    load(lv);
  }

  function back() {
    if (OD.stack.length <= 1) return App.openGuide();
    OD.stack.pop().run++;
    const lv = cur();
    if (lv.stale) load(lv, true);
    else render();
  }

  /** Something changed on a server (watched, progress): lists showing it
   *  reload when next shown. */
  function markStale() {
    for (const lv of OD.stack) lv.stale = true;
  }

  // ----------------------------------------------------------------- render
  const els = {
    vod: $("vod"), btns: $("v-btns"), empty: $("v-empty"), more: $("v-more"), hint: $("v-hint"), pos: $("v-pos"),
    menu: $("v-menu"),
  };

  function div(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  /** The info panel's first line: which screen this is. */
  const headOf = (lv) => (lv.root ? "ON DEMAND Menu" : lv.title);

  function render() {
    if (App.mode !== "vod" || !cur()) return;
    const lv = cur();
    els.vod.classList.toggle("kb", !!lv.kb);
    if (lv.kb) return kbRender(lv);
    Keyboard.hide();
    const n = lv.rows.length, c = cols(lv), wide = c === 1;
    const nRows = Math.ceil(n / c);
    lv.sel = U.clamp(lv.sel, 0, Math.max(0, n - 1));
    const selRow = Math.floor(lv.sel / c);
    if (selRow < lv.top) lv.top = selRow;
    if (selRow >= lv.top + ROWS) lv.top = selRow - ROWS + 1;
    lv.top = U.clamp(lv.top, 0, Math.max(0, nRows - ROWS));

    // the buttons on screen; titles' episode / year column only when some have one
    const first = lv.top * c, end = Math.min(n, (lv.top + ROWS) * c);
    const lefts = wide && lv.rows.slice(first, end).some((r) => r.left);
    const frag = document.createDocumentFragment(), toFit = [];
    for (let i = first; i < end; i++) {
      const r = lv.rows[i];
      const b = div("v-btn " + (wide ? "wide" : "c" + (i % c)) + (i === lv.sel ? " sel" : "") + (r.warn ? " warn" : ""));
      b.style.top = ROW_TOP(Math.floor(i / c) - lv.top) + "px";
      if (lefts) b.appendChild(div("v-left", r.left || ""));
      const t = div("v-t");
      b.appendChild(t);
      if (wide && r.tag) b.appendChild(div("v-tag", r.tag));
      b.addEventListener("click", () => {
        if (lv.sel === i) choose();
        else { lv.sel = i; render(); }
      });
      frag.appendChild(b);
      toFit.push([t, r.text]);
    }
    els.btns.replaceChildren(frag);
    for (const [el, t] of toFit) U.fitText(el, t, true);

    const msg = n ? "" : lv.loading ? "Loading..." : lv.error ? lv.error : lv.root ? "Nothing to show."
      : lv.query != null ? `Nothing in ${lv.item.title} matches "${lv.query}".`
      : lv.versions ? "No versions of this title were found." : "Nothing here.";
    els.empty.textContent = msg;
    els.empty.classList.toggle("show", !!msg);
    els.more.classList.toggle("up", lv.top > 0);
    els.more.classList.toggle("down", lv.top + ROWS < nRows || (!!n && lv.total > n));

    // info panel: the selection, or what's going on
    const head = headOf(lv);
    const r = lv.rows[lv.sel];
    let info;
    if (r) info = r.info || itemInfo(r.src, r.item);
    else if (lv.error) info = { title: lv.title, chan: "Not Available", desc: `${lv.error}. OK tries again.` };
    else if (lv.loading) info = { title: lv.root ? "On Demand" : lv.title, desc: "Loading..." };
    else if (lv.item) info = itemInfo(lv.src, lv.item);
    else info = { title: "On Demand" };
    App.showInfo(Object.assign({ head }, info));

    // footer
    els.hint.textContent = [
      wide ? "▲▼ Select" : "▲▼◀▶ Select",
      "OK Choose",
      OD.stack.length > 1 ? "Back Previous Menu" : "Back Guide",
    ].join(" · ");
    els.pos.textContent = nRows > ROWS ? `${lv.sel + 1} of ${Math.max(n, lv.total || 0)}` : "";
  }

  // ------------------------------------------------------------- navigation
  /** Up or down `d` rows of buttons (a button per row in lists, two in menus). */
  function vert(d) {
    const lv = cur();
    if (!lv) return;
    if (lv.kb) return Keyboard.move(d);
    const n = lv.rows.length;
    if (!n) return;
    const c = cols(lv);
    const i = U.clamp(lv.sel + d * c, 0, n - 1);
    if (Math.floor(i / c) === Math.floor(lv.sel / c)) return; // already at the top / bottom row
    lv.sel = i;
    render();
  }

  /** ◀ ▶: across a menu's two columns. In a list of titles ◀ goes back. */
  function horiz(d) {
    const lv = cur(), n = lv.rows.length;
    if (cols(lv) === 1 || !n) {
      if (d < 0 && OD.stack.length > 1) back();
      return;
    }
    const i = lv.sel + d;
    if (i < 0 || i >= n || Math.floor(i / 2) !== Math.floor(lv.sel / 2)) return;
    lv.sel = i;
    render();
  }

  function levelTitle(it) {
    return it.type === "season" && it.show ? `${it.show}: ${it.title}` : it.title;
  }

  function choose() {
    const lv = cur();
    if (!lv.rows.length) {
      if (lv.error) load(lv);
      return;
    }
    const r = lv.rows[lv.sel];
    if (r.act) return r.act();
    if (r.view) {
      // an order or genre from a library's menu (remembered for next time)
      Store.cfg.vod.views[viewKey(lv.src, lv.item)] = r.view.id;
      Store.save();
      return push({ title: `${lv.item.title}: ${r.view.label}`, src: lv.src, item: lv.item, view: r.view });
    }
    if (!r.item) return;
    if (playable(r.item)) return itemDialog(r);
    push({ title: levelTitle(r.item), src: r.src, item: r.item, pick: r.item.type === "library" });
  }

  // ----------------------------------------------------------------- search
  /*
   * A library's Search: the on-screen keyboard (keyboard.js) in place of the
   * buttons. What matches shows in the info panel as you type, a moment
   * after the last key (each search is kept, so Delete brings an earlier one
   * back at once, and each is asked of the server only once); Search lists
   * it all as an ordinary list of titles, and Back from there returns to the
   * keyboard with the text still in it.
   */
  const WAIT = 200;
  const norm = (q) => q.trim().replace(/\s+/g, " ").toLowerCase();
  const matches = (n) => (n === 1 ? "1 Match" : `${n || "No"} Matches`);

  function openSearch(lib) {
    const lv = level({
      kb: true, title: `${lib.item.title}: Search`, src: lib.src, item: lib.item, loading: false,
      asks: new Map(), got: new Map(), // searches so far: query -> promise, and -> result
      res: null, for: "", err: "", pending: false, timer: 0,   // the search showing, and for what
    });
    lv.s = Keyboard.session({
      placeholder: "Type a title",
      onInput: () => kbSearch(lv),
      onGo: () => kbGo(lv),
      onBack: () => { clearTimeout(lv.timer); back(); },
      hint: () => kbHint(lv),
    });
    OD.stack.push(lv);
    render();
  }

  /** For Voice: titles seen on the way here and found by earlier searches. */
  function kbHint(lv) {
    const titles = [];
    for (const l of OD.stack) for (const r of l.rows) if (r.item && r.item.title) titles.push(r.item.title);
    for (const res of lv.got.values()) for (const it of res.items) titles.push(it.title);
    return Voice.hint(titles.reverse()); // the latest first, if they don't all fit
  }

  /** Search for what's typed, once typing pauses; one already made shows at once. */
  function kbSearch(lv) {
    clearTimeout(lv.timer);
    const q = norm(lv.s.q);
    if (q === lv.for && lv.res) { lv.pending = false; return kbCount(lv); } // only a space more
    if (!q) {
      Object.assign(lv, { res: null, for: "", err: "", pending: false });
      return kbShow(lv);
    }
    if (lv.got.has(q)) return kbFound(lv, q, lv.got.get(q), "");
    lv.pending = true;
    kbCount(lv);
    lv.timer = setTimeout(() => kbAsk(lv, q), WAIT);
  }

  /** The search for q, asked of the server only once (a failed one is asked again). */
  function ask(lv, q) {
    if (!lv.asks.has(q)) {
      const pr = providers[lv.src.type].search(lv.src, lv.item, q);
      lv.asks.set(q, pr);
      pr.then((res) => lv.got.set(q, res), () => lv.asks.delete(q));
    }
    return lv.asks.get(q);
  }
  async function kbAsk(lv, q) {
    let res = null, err = "";
    try { res = await ask(lv, q); } catch (e) { err = e.message || String(e); }
    if (norm(lv.s.q) === q) kbFound(lv, q, res, err); // still what's typed
  }

  function kbFound(lv, q, res, err) {
    Object.assign(lv, { res, for: q, err, pending: false });
    kbShow(lv);
  }

  /** Searching opens the matches as a list of titles. */
  function kbGo(lv) {
    const q = norm(lv.s.q);
    if (!q) return;
    if (lv.for === q && lv.res && !lv.res.items.length) return; // nothing to list
    if (lv.pending) { clearTimeout(lv.timer); kbAsk(lv, q); } // no need to wait
    push({ title: `${lv.item.title}: "${lv.s.q.trim()}"`, src: lv.src, item: lv.item, query: q, found: ask(lv, q) });
  }

  function kbCount(lv) {
    const q = norm(lv.s.q);
    const n = lv.res ? lv.res.total != null ? lv.res.total : lv.res.items.length : 0;
    Keyboard.status(!q ? "" : lv.err && !lv.pending ? "Not Available" : lv.res ? matches(n) : "Searching...", {
      pending: !!q && lv.pending,
      canGo: !(!lv.pending && lv.for === q && !!lv.res && !n),
    });
  }
  function kbInfo(lv) {
    const lib = lv.item, q = lv.s.q.trim();
    const title = `"${q}"`, chan = srcLabel(lv.src);
    let info;
    if (!q) {
      info = {
        title: `Search ${lib.title}`, chan,
        desc: `Type part of a title, here or on a keyboard${Keyboard.voice ? ", or say it with Voice" : ""}. What matches shows here as you type; Search lists it.`,
      };
    } else if (lv.err) info = { title, chan: "Not Available", desc: `${lv.err}. Type again to try again.` };
    else if (!lv.res) info = { title, chan, desc: "Searching..." };
    else if (!lv.res.items.length) info = { title, chan, desc: `Nothing in ${lib.title} matches.` };
    else {
      info = {
        title, chan,
        desc: lv.res.items.slice(0, 16).map((it) => (it.year ? `${it.title} (${it.year})` : it.title)).join(", "),
      };
    }
    App.showInfo(Object.assign({ head: headOf(lv) }, info));
  }
  /** A search came back (or the text was cleared). */
  function kbShow(lv) {
    if (App.mode !== "vod" || lv !== cur()) return;
    kbCount(lv);
    kbInfo(lv);
  }
  function kbRender(lv) {
    Keyboard.show(els.menu, lv.s);
    kbCount(lv);
    kbInfo(lv);
    els.hint.textContent = Keyboard.hint;
    els.pos.textContent = "";
  }

  // ----------------------------------------------------------------- titles
  function itemDialog(r) {
    const { src, item: it } = r;
    const p = providers[src.type];
    const resume = hasResume(it);
    const start = (fromStart) => async () => {
      Dialog.message("Starting...");
      try {
        await play(src, it, { fromStart });
      } catch (e) {
        Dialog.message(e.message || String(e), true);
        return false;
      }
    };
    const info = itemInfo(src, it);
    // the title playing in the picture now: back to it, rather than starting it again
    const v = App.vod();
    const now = !!v && v.src.id === src.id && v.item.id === it.id && !v.item.extra;
    Dialog.open({
      title: it.type === "episode" && it.show ? `${it.show}: ${it.title}` : it.title,
      text: now ? "Playing now." : [info.time, it.rating].filter(Boolean).join(" · "),
      buttons: [
        now ? { label: "Keep Watching", act: () => App.watch() }
          : resume ? { label: `Resume from ${U.fmtDur(it.offset)}`, act: start(false) } : { label: "Play", act: start(true) },
        (resume || now) && { label: "Play from Beginning", act: start(true) },
        p.versions && {
          label: "Choose Version",
          act: () => push({ title: `${levelTitle(it)}: Versions`, src, item: it, versions: true }),
        },
        it.type === "movie" && p.trailer && {
          label: "Play Trailer",
          act: async () => {
            Dialog.message("Looking for the trailer...");
            try {
              const t = await p.trailer(src, it);
              if (!t) { Dialog.message("There's no trailer for this movie.", true); return false; }
              Dialog.message("Starting...");
              await play(src, t, { fromStart: true });
            } catch (e) {
              Dialog.message(e.message || String(e), true);
              return false;
            }
          },
        },
        {
          label: it.watched && !resume ? "Mark as Unwatched" : "Mark as Watched",
          act: async () => {
            const on = !(it.watched && !resume);
            try { await p.setWatched(src, it, on); } catch (e) { Dialog.message(e.message, true); return false; }
            it.watched = on;
            it.offset = 0;
            Object.assign(r, { tag: tagText(it) });
            markStale();
            const lv = cur();
            lv.stale = false;
            if (!lv.root) load(lv, true); // a show's unwatched count changes too
            render();
          },
        },
        { label: "Cancel" },
      ].filter(Boolean),
    });
  }

  /** A version picked from a title's versions: play it, from where it was left. */
  function versionDialog(src, it, v) {
    const resume = hasResume(it);
    const start = (fromStart) => async () => {
      Dialog.message("Starting...");
      try {
        await play(src, it, { fromStart, version: v.id });
      } catch (e) {
        Dialog.message(e.message || String(e), true);
        return false;
      }
    };
    Dialog.open({
      title: it.type === "episode" && it.show ? `${it.show}: ${it.title}` : it.title,
      text: v.label,
      buttons: [
        resume ? { label: `Resume from ${U.fmtDur(it.offset)}`, act: start(false) } : { label: "Play", act: start(true) },
        resume && { label: "Play from Beginning", act: start(true) },
        { label: "Cancel" },
      ].filter(Boolean),
    });
  }

  /** Play a random episode of a show or season (`unwatched`: of those not watched yet). */
  let shuffling = 0;
  async function shuffle(src, it, unwatched) {
    const run = ++shuffling;
    App.osd("Shuffling...", 15000);
    try {
      let eps = await providers[src.type].episodes(src, it);
      if (unwatched) eps = eps.filter((x) => !x.watched);
      if (run !== shuffling || App.mode !== "vod") return;
      if (!eps.length) return App.osd(unwatched ? "You've watched every episode." : "There are no episodes to play.", 3500);
      const ep = eps[Math.floor(Math.random() * eps.length)];
      // an episode you're partway through picks up where you left it
      await play(src, ep, { fromStart: ep.watched || !hasResume(ep) });
      App.osd(`Shuffle: ${epCode(ep)}`, 2500);
    } catch (e) {
      if (run === shuffling) App.osd(e.message || String(e), 5000);
    }
  }

  /** The channel-like object main.js and the player play. */
  function vodChannel(src, it, pl) {
    const ep = it.type === "episode" && !!it.show;
    return {
      vod: true, key: `vod|${src.id}|${it.id}`, url: pl.url, start: pl.start || 0, dur: pl.dur || it.dur,
      yt: pl.yt || null, // (a YouTube video: YouTube's own player, see channels.js)
      name: ep ? it.show : it.title,
      call: it.extra || (ep ? epCode(it) || srcLabel(src) : it.year ? String(it.year) : srcLabel(src)),
      desc: itemInfo(src, it).desc,
      // (with the ones downloaded for it: Search for Subtitles, subsearch.js)
      subs: (pl.subs || []).concat(SubSearch.cached(src, it)), burn: pl.burn || null, ours: !!pl.ours,
      src, item: it, play: pl,
    };
  }

  /** Whether `it` goes on from what's playing: the same show (its next
   *  episode, another of its episodes, Continue in On Demand from a custom
   *  channel) or the same title again. */
  function goesOn(it) {
    const v = App.vod();
    const was = v && Player.ch === v ? v.item : (Channels.current() || {}).item;
    if (!was) return false;
    if (was.id === it.id) return true;
    if (it.type !== "episode" || was.type !== "episode") return false;
    return it.showId && was.showId ? it.showId === was.showId : !!it.show && it.show === was.show;
  }

  async function play(src, it, opts) {
    // subtitles on for the show so far stay on for this
    const keep = Player.wantsCC() && goesOn(it);
    const pl = await providers[src.type].play(src, it, opts || {});
    const ch = vodChannel(src, it, pl);
    App.playVod(ch, false, keep);
    const ctx = SubSearch.current();
    if (ctx && App.vod() === ch) SubSearch.attach(ctx);
    if (ch.burn) return; // (the server's pick, drawn into the picture)
    // wanted (kept on, or Subtitles When Available): the best there is,
    // found on OpenSubtitles if need be; else the server's own pick, if any
    if (Player.ccWanted && ctx) { SubSearch.ensure(ctx); return; }
    const pick = ch.subs.find((s) => s.selected && s.url) || (Player.ccWanted && ch.subs.find((s) => s.url && !s.dl));
    if (pick) showSub(ch, pick).catch(() => {});
  }

  // ------------------------------------------------------- skipping, as Plex
  /*
   * Skip Intro and Skip Credits: while a title is in its intro or its end
   * credits (markers from Plex, or Jellyfin's media segments), main.js shows
   * a button over the picture; OK presses it. Skip Credits goes on to the
   * show's next episode, or for the last one (and movies) to the end.
   */
  function skipPop() {
    const v = App.vod();
    const m = v && v.play && v.play.markers;
    if (!m || Player.ch !== v || Player.loading || Player.error) return null;
    const t = Player.time(), end = v.dur || Infinity;
    if (m.intro && t >= m.intro[0] && t < m.intro[1] - 1) {
      return { key: `intro|${v.key}|${m.intro[0]}`, label: "Skip Intro", go: () => Player.seekTo(m.intro[1]) };
    }
    if (m.credits && t >= m.credits && t < end - 2) {
      const ep = v.item.type === "episode" && v.item.showId;
      return { key: `credits|${v.key}|${m.credits}`, label: ep ? "Skip Credits" : "Skip to the End", go: () => skipCredits(v) };
    }
    return null;
  }
  /** On to the next episode (or the end, when there isn't one). */
  async function skipCredits(v) {
    const toEnd = () => { if (App.vod() === v) Player.seekTo(v.dur || Player.time() + 1e6); };
    const it = v.item;
    if (it.type !== "episode" || !it.showId || !providers[v.src.type].episodes) return toEnd();
    App.osd("Getting the next episode...", 8000);
    try {
      const key = (e) => [e.season == null ? 1e6 : e.season, e.episode == null ? 1e6 : e.episode];
      const eps = (await providers[v.src.type].episodes(v.src, { id: it.showId, type: "show", title: it.show }))
        .sort((a, b) => { const [x, y] = [key(a), key(b)]; return x[0] - y[0] || x[1] - y[1]; });
      const i = eps.findIndex((e) => e.id === it.id);
      const next = i >= 0 ? eps[i + 1] : null;
      if (App.vod() !== v) return;
      if (!next) { App.osd("That was the last episode", 3000); return toEnd(); }
      await play(v.src, next, { fromStart: true });
      App.osd(`Next: ${epCode(next)}${next.title ? ` "${next.title}"` : ""}`, 3000);
    } catch (e) {
      App.osd(e.message || String(e), 4000);
    }
  }

  // ------------------------------------------------------------- subtitles
  /** A text subtitle file from the server, shown by our own subtitle display. */
  async function showSub(ch, sub) {
    const text = await U.fetchText(sub.url);
    if (App.vod() !== ch) return;
    Player.loadSubs(sub.label, text);
  }
  /** Whether a server subtitle is the one showing. */
  function subOn(sub) {
    const v = App.vod();
    if (!v) return false;
    return sub.url ? Player.cc === Player.EXT && Player.extName === sub.label : v.burn === sub.id;
  }
  /** Pick a server subtitle, or null for none. Text files show at once;
   *  ones inside the video are drawn in by the server, so the picture
   *  starts again where it was. */
  async function chooseSub(sub) {
    const v = App.vod();
    if (!v) return;
    const p = providers[v.src.type];
    const want = sub && !sub.url ? sub.id : null; // burned in
    // (a downloaded one isn't the server's: it's told none)
    if (p.setSubtitle) p.setSubtitle(v.src, v.play, sub && sub.dl ? null : sub).catch(() => {});
    if (sub && sub.url) {
      try { await showSub(v, sub); } catch (e) { App.osd(`Couldn't load the subtitles: ${e.message}`, 4000); return; }
      App.osd(`Subtitles: ${sub.label}`);
    } else Player.setTrack(null);
    if (want === v.burn) return;
    App.osd(want ? `Subtitles: ${sub.label}` : "Subtitles Off", 4000);
    const at = Player.time();
    try {
      const pl = await p.play(v.src, v.item, { at, burn: want });
      if (App.vod() !== v) { if (p.release) p.release(v.src, pl); return; }
      if (p.release) p.release(v.src, v.play);
      const ch = vodChannel(v.src, v.item, pl);
      App.playVod(ch, true);
      if (sub && sub.url) showSub(ch, sub).catch(() => {});
    } catch (e) {
      App.osd(e.message, 5000);
    }
  }

  // ------------------------------------------------------ stepping down
  /*
   * Automatic quality, while a title plays: when the picture has waited a few
   * seconds for a stream arriving slower than it plays, the server sends it
   * again a step down, from the same place, as Plex's own apps do. (Waiting
   * with the stream arriving fast enough is something else: the player's
   * own recovery deals with it.)
   */
  let lastStep = 0;
  setInterval(async () => {
    const v = App.vod();
    if (!v || !v.play.auto || !v.play.rate || Player.ch !== v || Player.loading || Player.error) return;
    if (Player.stalledFor() < 4000 || Date.now() - lastStep < 20000) return;
    const have = Player.netRate() || freshBw(v.src);
    if (!have || v.play.rate <= have * 0.85) return;
    if (v.play.rate <= FLOOR) return; // as low as it goes
    let cap = have * HEADROOM;
    if (cap > v.play.rate * 0.8) cap = v.play.rate * 0.6; // a real step
    lastStep = Date.now();
    noteBw(v.src, have, 0.5);
    const p = providers[v.src.type];
    // subtitles shown from a file come back with it; drawn-in ones stay drawn in
    const ext = Player.cc === Player.EXT ? v.subs.find((s) => s.url && s.label === Player.extName) : null;
    try {
      const pl = await p.play(v.src, v.item, { at: Player.time(), burn: v.burn, kbps: cap });
      if (App.vod() !== v) { if (p.release) p.release(v.src, pl); return; }
      if (p.release) p.release(v.src, v.play);
      const ch = vodChannel(v.src, v.item, pl);
      App.playVod(ch, true);
      if (ext) showSub(ch, ext).catch(() => {});
      App.osd(`Slow connection: picture lowered to ${(pl.rate / 1000).toFixed(1)} Mbps`, 4000);
    } catch { /* keeps playing as it was */ }
  }, 1000);

  // --------------------------------------------------------------- progress
  /*
   * While a title plays, its position goes to the server every 10 seconds
   * and whenever it pauses or plays, so it can be resumed (here or on any
   * other player) and is marked watched near the end.
   */
  let lastReport = 0, lastState = "";
  function tick() {
    const v = App.vod();
    if (!v || Player.ch !== v || Player.loading || Player.error) return;
    const state = Player.paused() ? "paused" : "playing";
    const now = Date.now();
    if (state === lastState && now - lastReport < 10000) return;
    lastReport = now;
    lastState = state;
    const t = Player.time();
    if (t > 0) v.item.offset = t;
    providers[v.src.type].report(v.src, v.item, v.play, state, t);
  }
  setInterval(tick, 2000);
  Player.on((type) => { if (type === "state") tick(); });

  /** A title stopped playing (main.js calls this before tuning anything else). */
  function stopped(v, leaving) {
    const it = v.item;
    const ok = Player.ch === v && !Player.loading && !Player.error;
    const t = ok ? Player.time() : it.offset;
    if (ok && t > 0) it.offset = t;
    if (v.dur && t >= v.dur * 0.9) { it.watched = true; it.offset = 0; }
    lastState = "";
    // lists reload once the server has heard (it may mark the title watched)
    OD.reported = Promise.resolve(providers[v.src.type].stopped(v.src, it, v.play, t, leaving)).catch(() => {});
    markStale();
  }
  window.addEventListener("pagehide", () => { const v = App.vod(); if (v) stopped(v, true); });

  // ------------------------------------------------------------------ input
  function key(e) {
    const k = e.key, nav = U.nav(e);
    const lv = cur();
    if (!lv) return false;
    if (lv.kb) return Keyboard.key(e);
    switch (nav || k) {
      case "up": vert(-1); break;
      case "down": vert(1); break;
      case "PageUp": case "ChannelUp": vert(-ROWS); break;
      case "PageDown": case "ChannelDown": vert(ROWS); break;
      case "Home": vert(-1e9); break;
      case "End": vert(1e9); break;
      case "left": horiz(-1); break;
      case "right": horiz(1); break;
      case "ok": case " ": choose(); break;
      case "back": back(); break;
      case "o": case "O": App.closeOnDemand(); break;
      case "g": case "G": case "Guide": App.openGuide(); break;
      case "f": case "F": App.act.fullscreen(); break;
      default: return false;
    }
    return true;
  }

  $("v-up").addEventListener("click", () => vert(-ROWS));
  $("v-down").addEventListener("click", () => vert(ROWS));

  // ------------------------------------------------------------------- api
  window.OnDemand = {
    QUALITY, quality, streamQuality, fmtLen,
    providers,
    register(type, p) { providers[type] = p; },
    sources,
    hasSources: () => sources().length > 0,
    /** This TV's id for media servers (Plex's client id, Jellyfin's device id). */
    deviceId() {
      const v = Store.cfg.vod;
      if (!v.clientId) {
        v.clientId = crypto.randomUUID ? crypto.randomUUID() : U.uid() + U.uid();
        Store.save();
      }
      return v.clientId;
    },
    /** A source's libraries (for Settings: hiding and showing them). */
    async libraries(src) {
      return (await providers[src.type].root(src)).filter((it) => it.type === "library");
    },
    libHidden,
    setLibHidden(src, id, hide) {
      const k = `${src.id}:${id}`;
      const h = new Set(Store.cfg.vod.hiddenLibs);
      if (hide) h.add(k); else h.delete(k);
      Store.cfg.vod.hiddenLibs = [...h];
      Store.save();
      OnDemand.changed();
    },
    /** Ways to add a source, from every provider (for Settings). */
    setups() {
      return Object.values(providers).flatMap((p) => (p.setup || []).map((s) => Object.assign({ label: p.label }, s)));
    },
    /** Show the On Demand screen: where it was left, reloading what changed. */
    open() {
      if (!OD.stack.length) {
        OD.stack.push(level({ root: true, title: "On Demand" }));
        load(cur());
      } else if (cur().stale) load(cur(), true);
      else render();
    },
    render,
    key,
    wheel: vert,
    /** Add (or replace) a source; On Demand starts again from the top. */
    addSource(src) {
      const list = Store.cfg.vod.sources;
      const i = list.findIndex((s) => s.id === src.id);
      if (i >= 0) list[i] = src; else list.push(src);
      Store.save();
      OnDemand.changed();
    },
    removeSource(src) {
      const v = App.vod();
      if (v && v.src.id === src.id) App.stopVod();
      Store.cfg.vod.sources = Store.cfg.vod.sources.filter((s) => s.id !== src.id);
      Store.cfg.vod.hiddenLibs = Store.cfg.vod.hiddenLibs.filter((k) => !k.startsWith(src.id + ":"));
      Store.save();
      OnDemand.changed();
    },
    /** Sources changed: start again from the top. */
    changed() {
      OD.stack.forEach((lv) => lv.run++);
      OD.stack = [];
      if (App.mode === "vod") OnDemand.open();
      else App.refreshViews();
    },
    stopped,
    subOn,
    chooseSub,
    skipPop,
    /** Play a title from a source (custom channels' Continue in On Demand). */
    play,
  };
})();
