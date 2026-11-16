/*
 * XMLTV guide data parser. Produces, per XMLTV channel id, a sorted list of
 * programs shaped for the guide grid:
 *   { title, sub, desc, start, end, rating, year, isNew, cat }
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

  function category(cats) {
    if (/movie|film/.test(cats)) return "movie";
    if (/sport/.test(cats)) return "sports";
    if (/child|kids|animation|cartoon/.test(cats)) return "kids";
    return "";
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
      const cats = Array.from(p.getElementsByTagName("category"), (e) => e.textContent.toLowerCase()).join(" ");
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

  window.XMLTV = { parse, merge, lookup, parseTime };
})();
