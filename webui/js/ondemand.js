/*
 * On Demand: movies and shows from media servers, browsed in the guide's
 * style. The guide's header, info panel and picture stay; below them a title
 * bar (like the guide's time bar) names the list, with ◀ ▶ picking its order
 * or a genre as the original's list screens did ("HDTV by Time ◀ 7:00pm ▶"),
 * and the list runs in rows like theirs: a light column on the left (the
 * year, the episode) beside each title, colored as in the guide.
 *
 * Sources are pluggable: Store.cfg.vod.sources holds { id, type, name, ... }
 * and the provider for its type (OnDemand.register) does the talking.
 *
 *   provider = {
 *     label                               "Plex"
 *     setup: [{ text, desc, act }]        ways to add a source (sign in, ...)
 *     describe(src)                       a line about a source, for Settings
 *     reconnect(src)                      find the server again (optional)
 *     root(src)                -> [item]  its libraries and folders
 *     views(src, item)         -> [{ id, label }] | null   orders / genres of a list
 *     list(src, item, view)    -> { items, total, next() -> [item] | null }
 *     play(src, item, { fromStart, at, burn })
 *                              -> { url, start, dur, subs: [{ id, label, url, selected }], burn }
 *                                 (subs with a url are text files we show ourselves;
 *                                 the others are drawn into the picture: `burn`)
 *     report(src, item, play, state, sec)      "playing" | "paused", as it plays
 *     stopped(src, item, play, sec, leaving)   (leaving: the page is closing)
 *     release(src, play)                       let go of a stream (optional)
 *     setSubtitle(src, play, sub | null)       remember the subtitle pick (optional)
 *     setWatched(src, item, on)
 *   }
 *   item = { id, type: library | folder | movie | show | season | episode,
 *            title, label (title in mixed lists), year, rating, dur, offset (sec),
 *            watched, desc, hd, stars (0-5), show, season, episode, count,
 *            unwatched, seasons, aired ("2008-01-20"), cat (movie | kids | sports | "") }
 *
 * Keys: ▲▼ select · ◀▶ order / genre (where there's a choice; else ◀ goes
 *       back) · OK open or play · Back up a level, and from the top back to
 *       wherever On Demand was opened from · PgUp/PgDn page · O closes
 */
(function () {
  "use strict";
  const { $ } = U;
  const ROWS = 5;
  const ROW_TOP = [2, 46, 89, 133, 176]; // row offsets inside #v-grid (41px rows)
  const LEFT_W = 142;                    // text room in the left column

  const providers = {};
  /** Saved sources whose provider is loaded. */
  const sources = () => Store.cfg.vod.sources.filter((s) => providers[s.type]);

  // Picture quality for streams a server converts (the most it may send).
  const QUALITY = [
    { id: "original", label: "Original", kbps: 200000, res: "3840x2160" },
    { id: "20", label: "20 Mbps 1080p", kbps: 20000, res: "1920x1080" },
    { id: "12", label: "12 Mbps 1080p", kbps: 12000, res: "1920x1080" },
    { id: "8", label: "8 Mbps 1080p", kbps: 8000, res: "1920x1080" },
    { id: "4", label: "4 Mbps 720p", kbps: 4000, res: "1280x720" },
    { id: "2", label: "2 Mbps 720p", kbps: 2000, res: "1280x720" },
    { id: "1", label: "1.5 Mbps 480p", kbps: 1500, res: "854x480" },
  ];
  const quality = () => QUALITY.find((q) => q.id === Store.cfg.vod.quality) || QUALITY[0];

  // ---------------------------------------------------------------- levels
  /*
   * The screens you've gone through, top one showing:
   *   { root, title, src, item, rows, total, sel, top, views, view,
   *     loading, error, stale, run }
   * views is undefined until asked for, then null (none) or a list.
   */
  const OD = { stack: [] };
  const cur = () => OD.stack[OD.stack.length - 1];
  function level(o) {
    return Object.assign({ rows: [], total: 0, sel: 0, top: 0, views: undefined, view: 0, loading: true, error: "", stale: false, run: 0 }, o);
  }
  const hasViews = (lv) => !!(lv.views && lv.views.length > 1);
  const viewKey = (lv) => `${lv.src.id}:${lv.item.id}`;

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

  function leftText(src, it) {
    switch (it.type) {
      case "library": case "folder": return srcLabel(src);
      case "movie": case "show": return it.year ? String(it.year) : "";
      case "season": return it.count ? `${it.count} Ep${it.count === 1 ? "" : "s"}` : "";
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
        const what = it.kind === "show" ? "TV shows" : "Movies";
        return {
          title: it.title, chan: srcLabel(src), time: it.kind === "show" ? "TV Shows" : "Movies",
          desc: `${what} on ${src.name}. In the list, ◀ ▶ changes the order or picks a genre.`,
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
  /** A list row: { src, item, left, text, tag, cat } or, for things that
   *  aren't titles, { left, text, info, act }. */
  const row = (src, it) => ({ src, item: it, left: leftText(src, it), text: it.label || it.title, tag: tagText(it), cat: it.cat || "" });

  /** With no sources: the ways to add one. */
  function setupRows() {
    const out = [];
    for (const [type, p] of Object.entries(providers)) {
      for (const s of p.setup || []) {
        out.push({ left: p.label, text: s.text, info: { title: s.text, chan: p.label, desc: s.desc }, act: s.act, type });
      }
    }
    return out;
  }

  async function rootRows() {
    const srcs = sources();
    if (!srcs.length) return setupRows();
    const per = await Promise.all(srcs.map(async (src) => {
      try {
        const items = await providers[src.type].root(src);
        if (items.length) return items.map((it) => row(src, it));
        return [{ left: srcLabel(src), text: `${src.name}: No Movies or Shows`, info: { title: src.name, desc: "This server has no movie or TV show libraries." } }];
      } catch (e) {
        return [{
          left: srcLabel(src), text: `${src.name}: Not Available`, warn: true,
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
    const run = ++lv.run;
    lv.loading = true;
    lv.error = "";
    lv.stale = false;
    if (!quiet) { lv.rows = []; lv.sel = lv.top = 0; }
    render();
    let res = null;
    try {
      let rows;
      if (OD.reported) await OD.reported;
      if (lv.root) rows = await rootRows();
      else {
        const p = providers[lv.src.type];
        if (lv.views === undefined) {
          const views = (await p.views(lv.src, lv.item)) || null;
          if (run !== lv.run) return;
          lv.views = views;
          const saved = views && Store.cfg.vod.views[viewKey(lv)];
          lv.view = Math.max(0, views ? views.findIndex((v) => v.id === saved) : 0);
        }
        res = await p.list(lv.src, lv.item, lv.views ? lv.views[lv.view] : null);
        rows = res.items.map((it) => row(lv.src, it));
      }
      if (run !== lv.run) return;
      const keep = quiet && lv.rows[lv.sel] && lv.rows[lv.sel].item; // where it is now
      lv.rows = rows;
      lv.total = res && res.total != null ? res.total : rows.length;
      lv.loading = false;
      if (keep) {
        const i = rows.findIndex((r) => r.item && r.item.id === keep.id && r.item.type === keep.type);
        if (i >= 0) lv.sel = i;
      }
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
        lv.rows.push(...more.map((it) => row(lv.src, it)));
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
    if (OD.stack.length <= 1) return App.closeOnDemand();
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
    bar: $("v-bar"), title: $("v-title"), view: $("v-view"),
    chans: $("v-chans"), list: $("v-list"), empty: $("v-empty"), hint: $("v-hint"), pos: $("v-pos"),
  };

  function div(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  /** The left column's text, squeezed (or stretched a little) to fit, as the
   *  guide's channel column does. */
  function leftCell(text, k, onClick) {
    const c = div("v-num");
    c.style.top = ROW_TOP[k] + "px";
    if (text) {
      const s = document.createElement("span");
      let t = text, w = U.textW(t, 22);
      let sx = Math.min(1.12, LEFT_W / Math.max(1, w));
      if (sx < 0.7) {
        while (t.length > 2 && U.textW(t + "...", 22) * 0.7 > LEFT_W) t = t.slice(0, -1);
        t = t.trimEnd() + "...";
        sx = 0.7;
      }
      s.textContent = t;
      s.style.transform = `scaleX(${sx.toFixed(3)})`;
      c.appendChild(s);
    }
    if (onClick) c.addEventListener("click", onClick);
    return c;
  }

  function render() {
    if (App.mode !== "vod" || !cur()) return;
    const lv = cur();
    const n = lv.rows.length;
    lv.sel = U.clamp(lv.sel, 0, Math.max(0, n - 1));
    if (lv.sel < lv.top) lv.top = lv.sel;
    if (lv.sel >= lv.top + ROWS) lv.top = lv.sel - ROWS + 1;
    lv.top = U.clamp(lv.top, 0, Math.max(0, n - ROWS));

    // title bar
    const views = hasViews(lv);
    els.bar.classList.toggle("views", views);
    U.fitText(els.title, lv.title, true);
    if (views) U.fitText(els.view, lv.views[lv.view].label, true);

    // rows, then blank ones to fill the list
    const chans = document.createDocumentFragment(), cells = document.createDocumentFragment();
    const toFit = [];
    for (let k = 0; k < ROWS; k++) {
      const i = lv.top + k, r = lv.rows[i];
      const click = r && (() => {
        if (lv.sel === i) choose();
        else { lv.sel = i; render(); }
      });
      chans.appendChild(leftCell(r ? r.left : "", k, click));
      const cell = div("cell" + (r ? (r.cat ? " " + r.cat : "") + (i === lv.sel ? " sel" : "") : " blank"));
      cell.style.top = ROW_TOP[k] + "px";
      if (r) {
        const t = div("v-t");
        cell.appendChild(t);
        if (r.tag) cell.appendChild(div("v-tag", r.tag));
        cell.addEventListener("click", click);
        toFit.push([t, r.text]);
      }
      cells.appendChild(cell);
    }
    els.chans.replaceChildren(chans);
    els.list.replaceChildren(cells);
    for (const [el, t] of toFit) U.fitText(el, t, true);

    const msg = n ? "" : lv.loading ? "Loading..." : lv.error ? lv.error : lv.root ? "Nothing to show." : "Nothing here.";
    els.empty.textContent = msg;
    els.empty.classList.toggle("show", !!msg);

    // info panel: the selection, or what's going on
    const r = lv.rows[lv.sel];
    if (r) App.showInfo(r.info || itemInfo(r.src, r.item));
    else if (lv.error) App.showInfo({ title: lv.title, chan: "Not Available", desc: `${lv.error}. OK tries again.` });
    else if (lv.loading) App.showInfo({ title: lv.title, desc: "Loading..." });
    else if (lv.item) App.showInfo(itemInfo(lv.src, lv.item));
    else App.showInfo({ title: "On Demand", desc: "" });

    // footer
    els.hint.textContent = [
      "▲▼ Select",
      views ? "◀▶ Order & Genre" : "",
      "OK Choose",
      OD.stack.length > 1 ? "Back" : "Back Close",
    ].filter(Boolean).join(" · ");
    els.pos.textContent = n > ROWS ? `${lv.sel + 1} of ${Math.max(n, lv.total || 0)}` : "";
  }

  // ------------------------------------------------------------- navigation
  function move(d) {
    const lv = cur();
    if (!lv.rows.length) return;
    lv.sel = U.clamp(lv.sel + d, 0, lv.rows.length - 1);
    render();
  }

  /** ◀ ▶ in the title bar: the next order or genre. Loads once the arrows
   *  are let go of for a moment, so running through them stays quick. */
  let viewTimer = 0;
  function changeView(d) {
    const lv = cur();
    if (!hasViews(lv)) return;
    lv.view = (lv.view + d + lv.views.length) % lv.views.length;
    Store.cfg.vod.views[viewKey(lv)] = lv.views[lv.view].id;
    Store.save();
    lv.run++;
    lv.rows = [];
    lv.sel = lv.top = 0;
    lv.loading = true;
    render();
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => { if (cur() === lv) load(lv); }, 300);
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
    if (!r.item) return;
    if (playable(r.item)) return itemDialog(r);
    push({ title: levelTitle(r.item), src: r.src, item: r.item });
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
    Dialog.open({
      title: it.type === "episode" && it.show ? `${it.show}: ${it.title}` : it.title,
      text: [info.time, it.rating].filter(Boolean).join(" · "),
      buttons: [
        resume ? { label: `Resume from ${U.fmtDur(it.offset)}`, act: start(false) } : { label: "Play", act: start(true) },
        resume && { label: "Play from Beginning", act: start(true) },
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

  /** The channel-like object main.js and the player play. */
  function vodChannel(src, it, pl) {
    const ep = it.type === "episode" && !!it.show;
    return {
      vod: true, key: `vod|${src.id}|${it.id}`, url: pl.url, start: pl.start || 0, dur: pl.dur || it.dur,
      name: ep ? it.show : it.title,
      call: ep ? epCode(it) : it.year ? String(it.year) : srcLabel(src),
      desc: itemInfo(src, it).desc,
      subs: pl.subs || [], burn: pl.burn || null,
      src, item: it, play: pl,
    };
  }

  async function play(src, it, opts) {
    const pl = await providers[src.type].play(src, it, opts || {});
    const ch = vodChannel(src, it, pl);
    App.playVod(ch);
    // subtitles: the server's pick, else (with Subtitles When Available on) the first
    const pick = ch.subs.find((s) => s.selected && s.url) ||
      (Store.cfg.prefs.ccDefault && !ch.burn && ch.subs.find((s) => s.url));
    if (pick) showSub(ch, pick).catch(() => {});
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
    if (p.setSubtitle) p.setSubtitle(v.src, v.play, sub).catch(() => {});
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
    switch (nav || k) {
      case "up": move(-1); break;
      case "down": move(1); break;
      case "PageUp": case "ChannelUp": move(-ROWS); break;
      case "PageDown": case "ChannelDown": move(ROWS); break;
      case "Home": move(-1e9); break;
      case "End": move(1e9); break;
      case "left": if (hasViews(lv)) changeView(-1); else if (OD.stack.length > 1) back(); break;
      case "right": if (hasViews(lv)) changeView(1); break;
      case "ok": case " ": choose(); break;
      case "back": back(); break;
      case "o": case "O": App.closeOnDemand(); break;
      case "g": case "G": case "Guide": App.openGuide(); break;
      case "f": case "F": App.act.fullscreen(); break;
      default: return false;
    }
    return true;
  }

  $("v-prev").addEventListener("click", () => changeView(-1));
  $("v-next").addEventListener("click", () => changeView(1));

  // ------------------------------------------------------------------- api
  window.OnDemand = {
    QUALITY, quality, fmtLen,
    providers,
    register(type, p) { providers[type] = p; },
    sources,
    hasSources: () => sources().length > 0,
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
    wheel: move,
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
  };
})();
