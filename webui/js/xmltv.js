/*
 * XMLTV guide data parser. Produces, per XMLTV channel id, a sorted list of
 * programs shaped for the guide grid:
 *   { title, sub, desc, start, end, rating, year, isNew, cat, tagged }
 * `cat` is the show's kind, which picks its color in the grid; `tagged` says
 * whether the guide gave it any categories to tell from.
 */
(function () {
  "use strict";
  const MIN = 60000;

  /** "20261115190000 +0000" -> ms. No zone means local time. */
  function parseTime(s) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(String(s || "").trim());
    if (!m) return NaN;
    const p = m.slice(1, 7).map((x) => +(x || 0));
    if (!m[7]) return new Date(p[0], p[1] - 1, p[2], p[3], p[4], p[5]).getTime();
    let t = Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]);
    if (m[7] !== "Z") {
      const z = m[7].replace(":", "");
      const off = (z[0] === "-" ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(3, 5));
      t -= off * MIN;
    }
    return t;
  }

  const norm = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  const RATING = /^(TV-(Y7?|G|PG|14|MA)|G|PG|PG-13|R|NC-17)(-FV)?$/;

  /*
   * Show colors, as on the classic i-Guide grid: movies purple, sports green,
   * children's shows light blue, everything else the general blue. A show's
   * kind ("movie" | "sports" | "kids" | "") comes from its XMLTV <category>
   * tags, which guide sites write in their own language. Earlier kinds win:
   * a children's movie is a movie, and a cartoon is a children's show even
   * from sites that tag it with every genre the series has ever touched
   * ("Animation, Comedy, ..., Sports").
   */
  const KINDS = [
    // ("film dokumentalny", "documentary film": documentaries aren't movies)
    ["movie", /^(?!.*(document|dokument)).*(movie|film|cinema|pel[ií]cula|sinema|فيلم|أفلام)/],
    ["kids", /child|\bkids?\b|kid's|animation|cartoon|dzieci|bajk|bambini|ragazzi|infantil|enfant|jeunesse|kinder|[cç]ocuk|أطفال/],
    ["sports", new RegExp([
      "sport", "deporte", "\\bspor\\b", "football", "f[uú]tbol", "soccer", "calcio", "pi[lł]k", "basket", "baseball",
      "softball", "hockey", "tenn?is", "golf", "rugby", "cricket", "boxing", "bokser", "wrestling", "\\bmma\\b",
      "\\bufc\\b", "racing", "nascar", "formu[lł]", "motori", "cycling", "volley", "siatk", "koszyk", "\\bski(ing)?\\b",
      "olympi", "athletics", "swimming", "equestrian", "rodeo", "bowling", "darts", "snooker", "padel", "handball",
      "lacrosse", "żużel",
      "رياض", "كرة", "تنس", "دوري", "بطولة", "كأس", "فروسية", "باديل", "فورمولا", "ملاكمة",
    ].join("|"))],
  ];
  /** cats: a show's <category> texts, lowercased */
  function category(cats) {
    for (const [kind, re] of KINDS) if (cats.some((c) => re.test(c))) return kind;
    return "";
  }

  // Untagged shows whose title gives them away as a game or match
  const SPORTS_TITLE = new RegExp("\\s(vs?\\.?|@)\\s|\\b(" + [
    "nfl", "nba", "wnba", "nhl", "mlb", "mls", "ncaa", "ufc", "wwe", "pga", "lpga", "atp", "wta", "nascar", "indycar",
    "motogp", "f1", "formula 1", "grand prix", "premier league", "la ?liga", "serie a", "bundesliga", "ligue 1",
    "champions league", "europa league", "super bowl", "world series", "stanley cup", "world cup", "olympics?",
    "football", "basketball", "baseball", "hockey", "soccer", "tennis", "golf", "boxing", "cricket", "rugby",
  ].join("|") + ")\\b", "i");

  // What a channel mostly shows, from its name, playlist group and guide id
  const CHANNEL_KINDS = [
    ["movie", /\bmovies?\b|\bcine|\bkino|\bfilm|\bflix\b|\btcm\b|turner classic|\bfxm\b|cinemax|\bmgm\b/],
    ["sports", /sport|\bespn|\bbein\b|\bdazn\b|\bnfl\b|\bnba\b|\bnhl\b|\bmlb\b|\bf1\b|formula|deportes|\btsn\b|\btudn\b|\bbtn\b|big ten|sec network|acc network|cbssn|golf|tennis|cricket|racing|\bufc\b|\bwwe\b|fight|calcio/],
    ["kids", /\bkids?\b|child|junior|\bjr\b|cartoon|boomerang|\bboing\b|cbeebies|\bcbbc\b|treehouse|\bytv\b|nick|disney (channel|xd)|baby ?tv|\bduck tv|teletoon|tiny pop|\bgulli\b|\bclan\b|rai (yoyo|gulp)|\bk2\b|frisbee|minimax|jim ?jam|toonami/],
  ];

  function namedKind(ch) {
    const s = [ch.name, ch.group, ch.tvgName, ch.tvgId].join(" ").toLowerCase().replace(/[-_.·]+/g, " ");
    for (const [kind, re] of CHANNEL_KINDS) if (re.test(s)) return kind;
    return "";
  }

  /** What most of a channel's categorized listings are, when most of its
   *  listings are categorized. */
  function listedKind(progs) {
    const n = { movie: 0, sports: 0, kids: 0, "": 0 };
    let tagged = 0;
    for (const p of progs) if (p.tagged) { n[p.cat]++; tagged++; }
    if (tagged < 6 || tagged < progs.length / 2) return "";
    for (const k of ["movie", "kids", "sports"]) if (n[k] >= tagged * 0.7) return k;
    return "";
  }

  /**
   * A channel's listings with kinds filled in where the guide left them out:
   *  - an uncategorized show gets "sports" if its title names a game or
   *    league, else what the channel mostly shows (its listings, else its name)
   *  - on a channel named as a movie or sports channel, a show whose
   *    categories said nothing (a movie tagged just "Drama") takes that kind;
   *    kids channels don't, since their evening sitcoms and adult cartoons
   *    aren't children's shows
   * Leaves the shared listing objects alone (another channel may use them).
   */
  function withKinds(progs, ch) {
    const named = namedKind(ch);
    const strong = named === "movie" || named === "sports" ? named : "";
    if (!progs.some((p) => !p.tagged || (strong && !p.cat))) return progs;
    const theme = listedKind(progs) || named;
    return progs.map((p) => {
      let cat = p.cat;
      if (!p.tagged) cat = theme !== "movie" && SPORTS_TITLE.test(p.title) ? "sports" : theme;
      else if (!cat) cat = strong;
      return cat === p.cat ? p : { ...p, cat };
    });
  }

  /** Parse XMLTV text; keep only programs overlapping [from, to). */
  function parse(text, from, to) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.getElementsByTagName("parsererror").length || !doc.getElementsByTagName("tv").length) {
      throw new Error("Not a valid XMLTV file");
    }
    const names = new Map();
    for (const c of doc.getElementsByTagName("channel")) {
      const id = c.getAttribute("id");
      if (!id) continue;
      names.set(norm(id), id);
      for (const d of c.getElementsByTagName("display-name")) {
        const k = norm(d.textContent);
        if (k && !names.has(k)) names.set(k, id);
      }
    }

    const progs = new Map();
    let count = 0;
    for (const p of doc.getElementsByTagName("programme")) {
      const start = parseTime(p.getAttribute("start"));
      let end = parseTime(p.getAttribute("stop"));
      if (!Number.isFinite(start)) continue;
      if (!Number.isFinite(end) || end <= start) end = start + 30 * MIN;
      if (end <= from || start >= to) continue;
      const id = p.getAttribute("channel");
      const first = (tag) => { const e = p.getElementsByTagName(tag)[0]; return e ? e.textContent.trim() : ""; };
      const cats = Array.from(p.getElementsByTagName("category"), (e) => e.textContent.trim().toLowerCase()).filter(Boolean);
      let rating = "";
      for (const r of p.getElementsByTagName("rating")) {
        const v = r.getElementsByTagName("value")[0];
        if (v && RATING.test(v.textContent.trim())) { rating = v.textContent.trim(); break; }
      }
      const prog = {
        title: first("title") || "Untitled",
        sub: first("sub-title"),
        desc: first("desc"),
        start, end, rating,
        year: (first("date").match(/^\d{4}/) || [""])[0],
        isNew: p.getElementsByTagName("new").length > 0,
        cat: category(cats),
        tagged: cats.length > 0,
      };
      let arr = progs.get(id);
      if (!arr) progs.set(id, (arr = []));
      arr.push(prog);
      count++;
    }
    for (const [id, arr] of progs) {
      arr.sort((a, b) => a.start - b.start);
      // trim overlaps so lookups are unambiguous
      const clean = [];
      for (const p of arr) {
        const prev = clean[clean.length - 1];
        if (prev && prev.end > p.start) prev.end = p.start;
        if (prev && prev.end <= prev.start) clean.pop();
        clean.push(p);
      }
      progs.set(id, clean);
    }
    return { names, progs, count };
  }

  /** Combine several parsed guides; earlier sources win on conflicts. */
  function merge(list) {
    const out = { names: new Map(), progs: new Map(), count: 0 };
    for (const g of list) {
      for (const [k, v] of g.names) if (!out.names.has(k)) out.names.set(k, v);
      for (const [k, v] of g.progs) if (!out.progs.has(k)) out.progs.set(k, v);
      out.count += g.count;
    }
    return out;
  }

  /** Find the guide entry for a playlist channel: tvg-id, then names. */
  function lookup(guide, ch) {
    if (!guide) return null;
    if (ch.tvgId && guide.progs.has(ch.tvgId)) return guide.progs.get(ch.tvgId);
    for (const k of [ch.tvgId, ch.tvgName, ch.name, ch.call]) {
      const id = k && guide.names.get(norm(k));
      if (id && guide.progs.has(id)) return guide.progs.get(id);
    }
    return null;
  }

  window.XMLTV = { parse, merge, lookup, parseTime, withKinds };
})();
