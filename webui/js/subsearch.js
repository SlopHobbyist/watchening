/*
 * Search for Subtitles, as in Plex: for an On Demand title or a custom
 * channel's episode (from Plex, Jellyfin or Stremio), Subtitle Options has
 * "Search for Subtitles...", which asks this site's server to look the title
 * up on OpenSubtitles (auth/subtitles.mjs). Results come in every language,
 * those made for the same release as the video playing first; picking one
 * downloads it to the server, where it's kept with the title, and shows it.
 * Everyone who plays that title from then on (everyone on a custom channel
 * when it comes round) has it in Subtitle Options, as "English
 * (OpenSubtitles)".
 *
 * Wanting subtitles finds them too: when they were on for the show before
 * (a custom channel's next episode, the next episode in On Demand) or
 * Subtitles When Available is on, a title with none in your language gets
 * the best match downloaded and turned on by itself (ensure, below).
 *
 * The title is identified by what its media server knows of it (the
 * provider's lookup(src, item, play): its IMDb id, name, year, season and
 * episode, and the file's name to match releases with).
 *
 *   SubSearch.cached(src, item)   the title's downloads, as subs entries
 *                                 ({ id, label, url, lang, dl }), if known
 *   SubSearch.attach(ctx)         after a title starts: get its downloads
 *   SubSearch.ensure(ctx, opts)   subtitles wanted: turn on the best there is,
 *                                 finding and downloading some if need be
 *   SubSearch.current()           what's playing that can be searched for (a ctx)
 *   SubSearch.open(ctx, onBack)   the search, in the pop-out panel
 *   SubSearch.mine(subs)          a download in this person's language
 *
 *   ctx = { src, item, pl, list (the subs the player lists, kept up to date),
 *           alive() (still playing), show(sub) (show one, a promise),
 *           burn (picture subtitles are drawn in now), burnable (they can be) }
 */
(function () {
  "use strict";

  const items = new Map(); // `${src.id}|${item.id}` -> { meta (a promise), key, saved }
  function entry(src, it) {
    const k = `${src.id}|${it.id}`;
    let e = items.get(k);
    if (!e) {
      e = { meta: null, key: "", saved: [] };
      items.set(k, e);
      if (items.size > 300) items.delete(items.keys().next().value);
    }
    return e;
  }

  const searchable = (src) => {
    const p = src && OnDemand.providers[src.type];
    return !!(p && p.lookup);
  };

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method, cache: "no-store",
        headers: Object.assign({ Accept: "application/json" }, body !== undefined ? { "Content-Type": "application/json" } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("Couldn't reach this site's server");
    }
    let data = {};
    try { data = (await res.json()) || {}; } catch { /* empty */ }
    if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`);
    return data;
  }
  const query = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)])).toString();

  /** What the media server knows of the title: { type, imdb, title, year, season, episode, eptitle, aired, file }. */
  function meta(ctx) {
    const e = entry(ctx.src, ctx.item);
    if (!e.meta) {
      e.meta = OnDemand.providers[ctx.src.type].lookup(ctx.src, ctx.item, ctx.pl)
        .catch((err) => { e.meta = null; throw err; });
    }
    // (the file can change with the version played)
    return e.meta.then((m) => (ctx.pl && ctx.pl.file ? Object.assign({}, m, { file: ctx.pl.file }) : m));
  }

  const toSub = (x) => ({ id: "dl:" + x.id, label: x.label, url: "/api/subtitles/file/" + x.id, lang: x.lang, dl: x });
  function cached(src, it) {
    const e = items.get(`${src.id}|${it.id}`);
    return e ? e.saved.map(toSub) : [];
  }

  /** The title's downloads are `saved`: into the player's list, in place of the old ones. */
  function setSaved(ctx, key, saved) {
    const e = entry(ctx.src, ctx.item);
    e.key = key;
    e.saved = saved || [];
    const list = ctx.list;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].dl) list.splice(i, 1);
    list.push(...e.saved.map(toSub));
  }

  const want = () => Store.cfg.prefs.subLang || navigator.language || "en";
  const base = (l) => String(l || "").toLowerCase().split("-")[0];
  /** A download in this person's language. */
  const mine = (subs) => subs.find((s) => s.dl && base(s.lang) === base(want())) || null;
  /** Whether a sub is the one on the picture now. */
  const showing = (s) => Player.cc === Player.EXT && Player.extName === s.label;

  async function refresh(ctx) {
    const m = await meta(ctx);
    const r = await api("GET", "/api/subtitles/saved?" + query(m));
    if (ctx.alive()) setSaved(ctx, r.key, r.saved);
    return r;
  }

  /** A title has started: its downloads join its subtitles (for Subtitle Options). */
  function attach(ctx) {
    if (!searchable(ctx.src)) return;
    refresh(ctx).then(() => { if (ctx.alive() && Panel.id() === "subs") Panel.refresh(); })
      .catch(() => { /* no IMDb id, or the server's busy: nothing to add */ });
  }

  const names = (() => { try { return new Intl.DisplayNames(["en"], { type: "language" }); } catch { return null; } })();
  const langName = (l) => { try { return (names && names.of(base(l))) || l; } catch { return l; } };
  /** A server subtitle's language, as "en" (Plex says "en" or "eng",
   *  Jellyfin "eng"; without one, by its name: "English (SRT External)"). */
  function langOf(s) {
    if (s.lang) {
      try { return base(Intl.getCanonicalLocales(s.lang)[0]); } catch { return base(s.lang); }
    }
    return String(s.label || "").toLowerCase().startsWith(langName(want()).toLowerCase()) ? base(want()) : "";
  }
  const isMine = (s) => langOf(s) === base(want());

  /**
   * Subtitles are wanted for the title that's just started (they were on for
   * the show before, Subtitles When Available is on, or C was pressed with
   * none to turn on): on with the best there is. In order: the server's own
   * file, its pick or in your language; one downloaded for the title before,
   * or failing that one found on OpenSubtitles now (downloaded and kept, for
   * everyone); picture subtitles in your language, drawn in by the server
   * (On Demand); the server's own file in another language.
   * Gives up as soon as subtitles are turned on or off meanwhile.
   * opts.say: say it's looking (C pressed)
   */
  const running = new WeakSet(); // ctx.list (one per title playing)
  async function ensure(ctx, opts) {
    if (!ctx || running.has(ctx.list) || !ctx.alive() || Player.cc || ctx.burn) return;
    running.add(ctx.list);
    try {
      const stop = () => !ctx.alive() || !!Player.cc || !Player.ccWanted;
      const own = ctx.list.filter((x) => x.url && !x.dl && !x.forced);
      const first = own.find((x) => x.selected) || own.find(isMine);
      if (first) return void (await ctx.show(first));
      let found = null, err = null;
      if (searchable(ctx.src)) {
        if (opts && opts.say) App.osd(`Looking for ${langName(want())} subtitles...`, 20000);
        try {
          const m = await meta(ctx);
          if (stop()) return;
          const r = await api("POST", "/api/subtitles/auto", Object.assign({}, m, { lang: want() }));
          if (!ctx.alive()) return;
          setSaved(ctx, r.key, r.saved);
          if (Panel.id() === "subs") Panel.refresh();
          if (r.sub) found = ctx.list.find((x) => x.dl && x.dl.id === r.sub.id) || null;
        } catch (e) {
          err = e;
        }
      }
      if (stop()) return;
      const pick = found || (ctx.burnable && ctx.list.find((x) => !x.url && !x.forced && isMine(x))) || own[0];
      if (pick) return void (await ctx.show(pick));
      App.osd(`No ${langName(want())} subtitles found for this` + (err ? ` (${err.message})` : ""), 4000);
    } catch { /* (showing it said why it couldn't) */ } finally {
      running.delete(ctx.list);
    }
  }

  /** What's playing, if subtitles can be searched for it. */
  function current() {
    const v = App.vod();
    if (v) {
      if (Player.ch !== v || !searchable(v.src)) return null;
      return {
        src: v.src, item: v.item, pl: v.play, list: v.subs, burn: v.burn, burnable: true,
        alive: () => App.vod() === v && Player.ch === v,
        show: (s) => OnDemand.chooseSub(s),
      };
    }
    const c = Channels.current();
    return c && searchable(c.src) ? c : null;
  }

  // ------------------------------------------------------------ the panel
  let cur = null; // { ctx, onBack, state: busy | done | error, err, key, results, langs, li, what, taking }

  function describe(m) {
    if (m.type === "series") return `${m.title || "this show"} season ${m.season}, episode ${m.episode}${m.eptitle ? ` ("${m.eptitle}")` : ""}`;
    return m.title ? `${m.title}${m.year ? ` (${m.year})` : ""}` : "this movie";
  }

  /** Languages in the results: yours first, then the most subtitled. */
  function languages(results) {
    const by = new Map();
    for (const r of results) {
      const x = by.get(r.language) || { lang: r.lang, language: r.language, n: 0 };
      x.n++;
      by.set(r.language, x);
    }
    const w = base(want());
    return [...by.values()].sort((a, b) => (base(b.lang) === w) - (base(a.lang) === w) || b.n - a.n || a.language.localeCompare(b.language));
  }

  function open(ctx, onBack) {
    const s = (cur = { ctx, onBack, state: "busy", li: 0, what: "" });
    Panel.open({ id: "subsearch", title: "Search for Subtitles", rows: () => rows(s), onBack });
    (async () => {
      const m = await meta(ctx);
      s.what = describe(m);
      s.meta = m;
      if (cur === s) Panel.refresh();
      const r = await api("GET", "/api/subtitles/search?" + query(m));
      if (!ctx.alive()) return;
      setSaved(ctx, r.key, r.saved);
      Object.assign(s, { state: "done", key: r.key, results: r.results, langs: languages(r.results) });
    })().catch((e) => {
      s.state = "error";
      s.err = e.message || String(e);
    }).finally(() => { if (cur === s && Panel.id() === "subsearch") Panel.refresh(); });
  }

  const tidy = (name) => String(name || "").replace(/\.(srt|sub|vtt|ass)$/i, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  /** A file name without what every result shares (the show, the episode,
   *  the title), leaving what tells them apart: "720p.WEB-DL.DD5.1-CtrlHD.sdh". */
  function short(name, m) {
    let s = tidy(name);
    const ep = /^.*?\b(?:s\d{1,2}[ ._-]?e\d{1,3}|\d{1,2}x\d{2,3})\b/i.exec(s);
    if (ep) s = s.slice(ep[0].length);
    for (const t of [m && m.eptitle, m && m.title]) {
      const w = String(t || "").toLowerCase().match(/[a-z0-9]+/g);
      if (w) s = s.replace(new RegExp("^[\\W_]*" + w.join("[\\W_]+") + "(?![a-z0-9])", "i"), "");
    }
    if (m && m.type === "movie") s = s.replace(/^[\W_]*[([]?(19|20)\d\d[)\]]?(?![0-9])/, "");
    s = s.replace(/^[\W_]+|[\W_]+$/g, "");
    return s || tidy(name);
  }

  function rows(s) {
    if (s.state === "busy") {
      return [{ label: s.what ? `Searching OpenSubtitles for ${s.what}...` : "Searching OpenSubtitles...", disabled: true }];
    }
    if (s.state === "error") {
      return [
        { label: s.err, disabled: true },
        { label: "Try Again", desc: "Search OpenSubtitles again.", act: () => open(s.ctx, s.onBack) },
      ];
    }
    const out = [];
    const saved = entry(s.ctx.src, s.ctx.item).saved.map(toSub).map((x) => s.ctx.list.find((y) => y.id === x.id) || x);
    if (!s.langs.length) {
      out.push({ label: "No subtitles found", disabled: true, desc: `OpenSubtitles has no subtitles for ${s.what}.` });
    } else {
      s.li = Math.min(s.li, s.langs.length - 1);
      const L = s.langs[s.li];
      out.push({
        label: "Language", value: `${L.language} (${L.n})`,
        desc: `◀▶ for subtitles in another language (OpenSubtitles has ${s.langs.length === 1 ? "only this one" : s.langs.length} for this). The one you pick is remembered for next time.`,
        step: (d) => {
          s.li = (s.li + d + s.langs.length) % s.langs.length;
          App.setPrefs({ subLang: s.langs[s.li].lang });
        },
      });
      out.push({ sep: true });
      const here = saved.filter((x) => x.dl.language === L.language);
      for (const x of here) {
        out.push({
          label: x.label, check: showing(x),
          desc: `Downloaded before, and kept on this server for everyone who plays this. ${x.dl.name || x.dl.release}`,
          act: () => pick(s, x),
        });
      }
      const have = new Set(saved.map((x) => x.dl.id));
      const list = s.results.filter((r) => r.language === L.language && !have.has(r.id)).slice(0, 60);
      for (const r of list) {
        out.push({
          label: s.taking === r.id ? "Downloading..." : short(r.name || r.release, s.meta) || "Subtitles",
          disabled: !!s.taking,
          // (the file's name last: the box cuts off what doesn't fit)
          desc: (r.fit >= 3 ? "Made for the same release as this video: likely in step. " : "") +
            `OK downloads it and shows it, and keeps it with this title for everyone. ${r.name}${r.fps ? ` (${r.fps} fps)` : ""}`,
          act: () => take(s, r),
        });
      }
      if (!here.length && !list.length) out.push({ label: `No ${L.language} subtitles`, disabled: true });
    }
    if (saved.length) {
      out.push({ sep: true });
      for (const x of saved) {
        out.push({
          label: `Remove ${x.label}`,
          desc: `Forget this download, for everyone who plays this title (one that's out of step, or for another cut). ${x.dl.name || x.dl.release}`,
          act: () => remove(s, x),
        });
      }
    }
    return out;
  }

  /** Show a subtitle, then go back to Subtitle Options (to set its offset). */
  async function pick(s, sub) {
    if (!s.ctx.alive()) return;
    await s.ctx.show(sub);
    if (cur === s && Panel.id() === "subsearch") {
      Panel.close();
      if (s.onBack) s.onBack();
    }
  }

  async function take(s, r) {
    if (s.taking) return;
    s.taking = r.id;
    Panel.refresh();
    try {
      const out = await api("POST", "/api/subtitles/keep", { key: s.key, id: r.id });
      if (!s.ctx.alive()) return;
      setSaved(s.ctx, s.key, out.saved);
      const sub = s.ctx.list.find((x) => x.dl && x.dl.id === out.sub.id);
      if (sub) await pick(s, sub);
    } catch (e) {
      App.osd(`Couldn't get those subtitles: ${e.message}`, 5000);
    } finally {
      s.taking = null;
      if (cur === s && Panel.id() === "subsearch") Panel.refresh();
    }
  }

  async function remove(s, sub) {
    try {
      const was = showing(sub);
      const out = await api("POST", "/api/subtitles/drop", { key: s.key, id: sub.dl.id });
      if (!s.ctx.alive()) return;
      setSaved(s.ctx, s.key, out.saved);
      if (was) Player.setTrack(null);
      App.osd(`Removed ${sub.label}`, 3000);
    } catch (e) {
      App.osd(`Couldn't remove it: ${e.message}`, 5000);
    }
    if (cur === s && Panel.id() === "subsearch") Panel.refresh();
  }

  window.SubSearch = {
    cached, attach, ensure, current, open, mine,
    /** Subtitle Options opened: fetch the downloads again (someone else on
     *  the channel may have just got one). */
    refresh: () => {
      const ctx = current();
      if (ctx) refresh(ctx).then(() => { if (Panel.id() === "subs") Panel.refresh(); }).catch(() => {});
    },
  };
})();
