/*
 * iGuide-style interactive program guide.
 *
 * Keys (guide):   arrows move · PgUp/PgDn page channels · Shift+Left/Right -/+ 1 day
 *                 Enter tune · 0-9 channel entry · Esc / G exit to TV
 * Keys (TV):      Up/Down or PgUp/PgDn channel · 0-9 tune · Enter / I info banner
 *                 G / Esc guide · L last channel
 * Mouse:          click a listing to select it, click again to tune · wheel scrolls
 *                 click the picture to go full screen
 *
 * IPTV hook:      give a channel a `stream` URL in lineup.js (or call
 *                 guide.setStream(channelNumber, url)). HLS works natively in
 *                 Safari, or anywhere if hls.js is loaded on the page.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- constants
  const MIN = 60000;
  const SLOT = 30 * MIN;
  const SLOT_PX = 196;               // pixels per half hour
  const ROWS = 4;
  const ROW_TOP = [2, 56, 111, 165]; // row offsets inside #grid
  const ROW_H = 52;
  const GAP = 3;                     // gap between listings
  const NAV_SPAN = 3 * SLOT;         // 7:00 / 7:30 / 8:00 columns are navigable
  const DAYS_BACK = 1, DAYS_AHEAD = 8;

  const $ = (id) => document.getElementById(id);
  const stage = $("stage");

  // ------------------------------------------------------------------ helpers
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const floorSlot = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0); return d.getTime(); };
  const midnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const minOfDay = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };

  const h12 = (d) => ((d.getHours() + 11) % 12) + 1;
  const ap = (d) => (d.getHours() < 12 ? "a" : "p");
  const mm = (d) => String(d.getMinutes()).padStart(2, "0");
  const fmtClock = (t) => { const d = new Date(t); return `${h12(d)}:${mm(d)}${ap(d)}m`; };
  const fmtSlot = (t) => { const d = new Date(t); return `${h12(d)}:${mm(d)}${ap(d)}`; };
  const fmtShort = (t) => { const d = new Date(t); return d.getMinutes() ? `${h12(d)}:${mm(d)}` : `${h12(d)}`; };
  function fmtRange(s, e) {
    const a = ap(new Date(s)), b = ap(new Date(e));
    return a === b ? `${fmtShort(s)}-${fmtShort(e)}${b}` : `${fmtShort(s)}${a}-${fmtShort(e)}${b}`;
  }
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function dayLabel(t) {
    const today = midnight(Date.now());
    const day = midnight(t);
    if (day === today) return "Today";
    const d = new Date(t);
    return day - today < 6.5 * 24 * 60 * MIN ? DOW[d.getDay()] : `${d.getMonth() + 1}/${d.getDate()}`;
  }
  function stars(n) {
    if (!n) return "";
    return "★".repeat(Math.floor(n)) + (n % 1 ? "½" : "");
  }

  /** Shorten text word by word (adding "...") until it fits the element's box. */
  function fitText(el, text, oneLine) {
    el.textContent = text;
    // multi-line: allow a few px of glyph overflow (less than half a line)
    const over = () => (oneLine ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 8);
    if (!over()) return;
    const words = text.split(" ");
    let lo = 0, hi = words.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      el.textContent = words.slice(0, mid).join(" ").replace(/[,;:.]+$/, "") + "...";
      if (over()) hi = mid - 1; else lo = mid;
    }
    if (lo === 0) {
      // a single long word: trim characters
      let w = words[0];
      el.textContent = w + "...";
      while (w.length > 1 && over()) { w = w.slice(0, -1); el.textContent = w + "..."; }
    } else {
      el.textContent = words.slice(0, lo).join(" ").replace(/[,;:.]+$/, "") + "...";
    }
  }

  // ----------------------------------------------------------------- schedule
  const PAID = ["Paid Programming", 30, "", "Paid programming.", "L"];
  const channels = (window.LINEUP || []).slice().sort((a, b) => a.n - b.n);
  const epoch = midnight(Date.now()) - DAYS_BACK * 24 * 60 * MIN;
  const horizon = midnight(Date.now()) + DAYS_AHEAD * 24 * 60 * MIN;

  function makeProgram(show, start, dur, r, daypart) {
    const [title, , rating, desc, flags = "", extra] = show;
    const p = {
      title, start, end: start + dur * MIN, rating: rating || "", desc: desc || "",
      cat: flags.includes("m") ? "movie" : flags.includes("s") ? "sports" : flags.includes("k") ? "kids" : "",
      isNew: flags.includes("N") && daypart === "P" && r() < 0.55,
    };
    if (p.cat === "movie" && extra && !Array.isArray(extra)) p.movie = extra;
    if (Array.isArray(extra) && extra.length) p.ep = extra[Math.floor(r() * extra.length)];
    return p;
  }

  function buildSchedule(ch) {
    const r = mulberry32(hash(ch.call + ":" + ch.n + ":" + new Date(epoch).toDateString()));
    const pool = (ch.pool && ch.pool.length ? ch.pool : [PAID]);
    const fixed = Object.entries(ch.fixed || {})
      .map(([k, s]) => { const [h, m] = k.split(":").map(Number); return [h * 60 + m, s]; })
      .sort((a, b) => a[0] - b[0]);
    const fixedAt = new Map(fixed);
    const list = [];
    let t = epoch, prev = null;

    while (t < horizon) {
      const mod = minOfDay(t);
      const hr = Math.floor(mod / 60);
      const dp = hr < 6 ? "L" : hr < 17 ? "D" : "P";

      if (fixedAt.has(mod)) {
        const s = fixedAt.get(mod);
        const p = makeProgram(s, t, s[1], r, dp);
        list.push(p); t = p.end; prev = s; continue;
      }
      // minutes until the next fixed show
      let room = Infinity;
      for (const [m] of fixed) { const d = m > mod ? m - mod : m + 1440 - mod; if (d < room) room = d; }

      if (mod % 30) { // realign to the half hour after odd-length shows
        const d = Math.min(30 - (mod % 30), room);
        list.push(makeProgram(PAID, t, d, r, dp)); t += d * MIN; prev = null; continue;
      }
      const hasDp = (s) => /[DPL]/.test(s[4] || "");
      let cands = pool.filter((s) => s[1] <= room && (!hasDp(s) || s[4].includes(dp)));
      if (!cands.length) cands = pool.filter((s) => s[1] <= room && !hasDp(s));
      if (!cands.length) {
        const d = Math.min(30, room);
        list.push(makeProgram(PAID, t, d, r, dp)); t += d * MIN; prev = null; continue;
      }
      let s;
      if (prev && cands.includes(prev) && prev[1] <= 30 && r() < 0.4) s = prev; // back-to-back episodes
      else {
        let others = cands.filter((c) => c !== prev);
        if (!others.length) others = cands;
        s = others[Math.floor(r() * others.length)];
      }
      const p = makeProgram(s, t, s[1], r, dp);
      list.push(p); t = p.end; prev = s;
    }
    return list;
  }
  channels.forEach((ch) => (ch.sched = buildSchedule(ch)));

  function programAt(ch, t) {
    const a = ch.sched;
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].end <= t) lo = mid + 1;
      else if (a[mid].start > t) hi = mid - 1;
      else return a[mid];
    }
    return { title: "To Be Announced", start: floorSlot(t), end: floorSlot(t) + SLOT, rating: "", desc: "", cat: "" };
  }
  function programsIn(ch, from, to) {
    const out = [];
    let p = programAt(ch, from);
    while (p.start < to) { out.push(p); if (p.end >= horizon) break; p = programAt(ch, p.end); }
    return out;
  }

  // -------------------------------------------------------------------- state
  const N = channels.length;
  const S = {
    sel: 0,          // selected channel index
    top: 0,          // channel index in the first visible row
    ws: floorSlot(Date.now()), // window start
    focus: Date.now(),         // time the cursor sits on
    tuned: 0,
    lastTuned: 0,
    watching: false,
    entry: "", entryTimer: 0,
  };
  const nowSlot = () => floorSlot(Date.now());
  const rowOf = (idx) => (idx - S.top + N) % N;

  // ------------------------------------------------------------------ render
  const els = {
    clock: $("clock"), title: $("i-title"), chan: $("i-chan"), time: $("i-time"),
    icons: $("i-icons"), desc: $("i-desc"), day: $("tb-day"),
    t: [$("tb-t0"), $("tb-t1"), $("tb-t2")], chans: $("chans"), progs: $("progs"),
  };

  /*
   * Ratings badges: a flat white rounded box with the lettering cut out of it.
   * The box's drop shadow (CSS) shows through the cut-outs, so the letters read
   * as dark, with the background peeking along their top-left edges.
   * TV ratings stack "TV" over "PG"; MPAA ratings ("PG-13") and HD are one line.
   */
  let badgeId = 0;
  const measureCtx = document.createElement("canvas").getContext("2d");
  function textW(txt, size) {
    measureCtx.font = `400 ${size}px GuideFont`;
    return measureCtx.measureText(txt).width;
  }
  function badgeSvg(w, h, texts) {
    const id = "bm" + ++badgeId;
    const cut = texts.map(({ t, x, y, size, len, stroke = 0 }) =>
      `<text x="${x}" y="${y}" font-size="${size}" text-anchor="middle"` +
      (len ? ` textLength="${len}" lengthAdjust="spacingAndGlyphs"` : "") +
      (stroke ? ` stroke="#000" stroke-width="${stroke}" stroke-linejoin="round"` : "") +
      `>${t}</text>`).join("");
    // The shadow is a solid card under the cut-out one, so every hole shows dark.
    return `<svg class="badge" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="${texts.map((x) => x.t).join("-")}">
      <mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">
        <rect width="${w}" height="${h}" rx="4.5" fill="#fff"/>${cut}
      </mask>
      <rect x="1" y="1.5" width="${w - 0.5}" height="${h - 0.5}" rx="4.5" class="badge-shadow"/>
      <rect width="${w}" height="${h}" rx="4.5" class="badge-fill" mask="url(#${id})"/></svg>`;
  }
  // TV ratings: 30x28 card, "TV" over the rating in small (~7px cap), widely set caps.
  function badgeTV(r) {
    const lo = r.replace(/^TV-/, "");
    const W = 30, H = 28;
    return badgeSvg(W, H, [
      { t: "TV", x: W / 2, y: 12.2, size: 13, len: 20.5, stroke: 0.55 },
      { t: lo, x: W / 2, y: 24, size: 13, len: lo.length > 1 ? 21.5 : 0, stroke: 0.55 },
    ]);
  }
  // MPAA ratings / HD: one line of big caps filling ~55% of the card height.
  function badgeBox(txt) {
    const size = 21, H = 28;
    const len = Math.round(textW(txt, size) * 1.08);
    const W = Math.max(30, len + 8);
    return badgeSvg(W, H, [{ t: txt, x: W / 2, y: 21.5, size, len, stroke: 0.45 }]);
  }

  function describe(p) {
    const parts = [];
    if (p.movie) {
      if (p.movie.cast) parts.push(p.movie.cast);
      parts.push(`(${p.movie.y})`);
      if (p.movie.st) parts.push(stars(p.movie.st));
      parts.push(p.desc);
    } else if (/^"/.test(p.desc)) {
      parts.push(p.desc); // description already carries the episode line
    } else {
      if (p.ep) parts.push(`"${p.ep}"`);
      if (p.isNew) parts.push("New");
      if (p.rating && p.ep) parts.push(`(${p.rating})`);
      parts.push(p.desc);
    }
    return parts.filter(Boolean).join(", ");
  }

  function renderInfo(ch, p) {
    fitText(els.title, p.title, true);
    els.chan.textContent = `${ch.n} ${ch.call}`;
    els.time.textContent = fmtRange(p.start, p.end);
    let icons = "";
    if (ch.hd) icons += badgeBox("HD");
    if (/^TV-/.test(p.rating)) icons += badgeTV(p.rating);
    else if (p.rating && p.rating !== "NR") icons += badgeBox(p.rating);
    els.icons.innerHTML = icons;
    fitText(els.desc, describe(p), false);
  }

  function renderGrid() {
    const ws = S.ws;
    const visEnd = ws + ((800 - 164) / SLOT_PX) * SLOT;
    const sel = programAt(channels[S.sel], S.focus);

    els.day.textContent = dayLabel(ws);
    els.t.forEach((el, k) => (el.textContent = fmtSlot(ws + k * SLOT)));

    const chanFrag = document.createDocumentFragment();
    const progFrag = document.createDocumentFragment();
    const cellsToFit = [];

    for (let row = 0; row < ROWS; row++) {
      const idx = (S.top + row) % N;
      const ch = channels[idx];

      const c = document.createElement("div");
      c.className = "chan";
      c.style.top = ROW_TOP[row] + "px";
      const showEntry = S.entry && idx === S.sel;
      if (showEntry) c.classList.add("entry");
      c.innerHTML = `<div class="num">${showEntry ? S.entry + "_" : ch.n}</div><div class="call">${ch.call}</div>`;
      c.addEventListener("click", () => { select(idx, S.focus); });
      chanFrag.appendChild(c);

      for (const p of programsIn(ch, ws, visEnd)) {
        const x0 = ((Math.max(p.start, ws) - ws) / SLOT) * SLOT_PX;
        const x1 = ((p.end - ws) / SLOT) * SLOT_PX - GAP;
        const w = Math.min(x1, 800) - x0;
        if (w <= 0) continue;
        const cell = document.createElement("div");
        cell.className = "cell" + (p.cat ? " " + p.cat : "") + (idx === S.sel && p === sel ? " sel" : "");
        cell.style.left = x0 + "px";
        cell.style.width = (x1 - x0) + "px";
        cell.style.top = ROW_TOP[row] + "px";
        if (w > 72) {
          const span = document.createElement("span");
          span.style.maxWidth = Math.max(0, Math.min(x1, 636) - x0 - 13) + "px";
          cell.appendChild(span);
          cellsToFit.push([span, p.movie ? `${p.title} (${p.movie.y})` : p.title]);
        }
        cell.addEventListener("click", () => {
          if (idx === S.sel && programAt(channels[idx], S.focus) === p) enter();
          else select(idx, Math.max(p.start, S.ws));
        });
        progFrag.appendChild(cell);
      }
    }
    els.chans.replaceChildren(chanFrag);
    els.progs.replaceChildren(progFrag);
    for (const [span, text] of cellsToFit) fitText(span, text, false);

    renderInfo(channels[S.sel], sel);
  }

  function renderClock() {
    const t = fmtClock(Date.now());
    els.clock.textContent = t;
    $("b-clock").textContent = t;
  }

  // -------------------------------------------------------------- navigation
  function clampWs() {
    S.ws = Math.max(nowSlot(), Math.min(S.ws, horizon - 4 * SLOT));
  }
  function select(idx, focus) {
    S.sel = idx;
    S.focus = focus;
    if (rowOf(idx) >= ROWS) S.top = idx;
    renderGrid();
  }
  function moveVert(d) {
    S.sel = (S.sel + d + N) % N;
    const r = rowOf(S.sel);
    if (r >= ROWS) S.top = d < 0 ? S.sel : (S.sel - ROWS + 1 + N) % N;
    renderGrid();
  }
  function page(d) {
    S.top = (S.top + d * ROWS + N * ROWS) % N;
    S.sel = (S.sel + d * ROWS + N * ROWS) % N;
    renderGrid();
  }
  function moveRight() {
    const ch = channels[S.sel];
    const p = programAt(ch, S.focus);
    if (p.end >= horizon) return;
    const next = programAt(ch, p.end);
    while (next.start >= S.ws + NAV_SPAN) S.ws += SLOT;
    clampWs();
    S.focus = Math.max(next.start, S.ws);
    renderGrid();
  }
  function moveLeft() {
    const ch = channels[S.sel];
    const p = programAt(ch, S.focus);
    const ns = nowSlot();
    if (p.start < S.ws && S.ws > ns) {          // reveal the rest of a long show first
      S.ws = Math.max(ns, floorSlot(p.start));
      S.focus = Math.max(p.start, S.ws);
      return renderGrid();
    }
    if (p.start <= S.ws) {
      if (S.ws <= ns) return;                    // can't go back past now
      const prev = programAt(ch, p.start - 1);
      S.ws = Math.max(ns, floorSlot(prev.start));
      S.focus = Math.max(prev.start, S.ws);
      return renderGrid();
    }
    const prev = programAt(ch, p.start - 1);
    S.focus = Math.max(prev.start, S.ws);
    renderGrid();
  }
  function shiftDay(d) {
    S.ws += d * 24 * 60 * MIN;
    clampWs();
    S.focus = Math.max(S.ws, Math.min(S.focus + d * 24 * 60 * MIN, S.ws + NAV_SPAN - 1));
    renderGrid();
  }

  function openGuide() {
    S.watching = false;
    stage.classList.remove("watching");
    hideBanner();
    S.ws = nowSlot();
    S.focus = Date.now();
    S.sel = S.tuned;
    S.top = S.tuned;
    setTvMode("pip");
    renderGrid();
  }
  function watch() {
    S.watching = true;
    stage.classList.add("watching");
    setTvMode("full");
    showBanner();
  }
  function enter() {
    if (S.tuned !== S.sel) tune(S.sel);
    watch();
  }

  // ------------------------------------------------------------ channel entry
  function digit(dg) {
    S.entry = (S.entry + dg).slice(0, 3);
    clearTimeout(S.entryTimer);
    if (S.watching) { $("osd-num").textContent = S.entry + "-"; $("osd-num").classList.add("show"); }
    else renderGrid();
    if (S.entry.length >= 3) commitEntry();
    else S.entryTimer = setTimeout(commitEntry, 1800);
  }
  function commitEntry() {
    clearTimeout(S.entryTimer);
    const n = parseInt(S.entry, 10);
    S.entry = "";
    $("osd-num").classList.remove("show");
    if (isNaN(n)) return;
    let idx = channels.findIndex((c) => c.n >= n);
    if (idx < 0) idx = N - 1;
    if (S.watching) { tune(idx); showBanner(); }
    else { S.sel = idx; S.top = idx; renderGrid(); }
  }

  // ------------------------------------------------------------------ banner
  let bannerTimer = 0;
  function showBanner() {
    const ch = channels[S.tuned];
    const p = programAt(ch, Date.now());
    $("b-chan").textContent = `${ch.n} ${ch.call}`;
    renderClock();
    $("banner").classList.add("show");
    fitText($("b-title"), p.title, true);
    $("b-time").textContent = fmtRange(p.start, p.end);
    fitText($("b-desc"), describe(p), true);
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, 5000);
  }
  function hideBanner() { clearTimeout(bannerTimer); $("banner").classList.remove("show"); }

  // ---------------------------------------------------------------------- tv
  const tv = $("tv"), video = $("tv-video"), canvas = $("tv-canvas");
  let hls = null;

  function setTvMode(mode) { tv.classList.toggle("pip", mode === "pip"); tv.classList.toggle("full", mode === "full"); }

  function drawTestCard(ch) {
    const g = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const top = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
    const mid = ["#0000c0", "#131313", "#c000c0", "#131313", "#00c0c0", "#131313", "#c0c0c0"];
    const bw = W / 7;
    top.forEach((c, i) => { g.fillStyle = c; g.fillRect(Math.floor(i * bw), 0, Math.ceil(bw), H * 0.67); });
    mid.forEach((c, i) => { g.fillStyle = c; g.fillRect(Math.floor(i * bw), H * 0.67, Math.ceil(bw), H * 0.08); });
    const low = [["#00214c", 1.25], ["#ffffff", 1.25], ["#32006a", 1.25], ["#131313", 1.25], ["#090909", 0.33], ["#131313", 0.34], ["#1d1d1d", 0.33], ["#131313", 1]];
    let x = 0;
    low.forEach(([c, w]) => { g.fillStyle = c; g.fillRect(Math.floor(x), H * 0.75, Math.ceil(w * bw), H * 0.25); x += w * bw; });
    // station ID
    g.fillStyle = "rgba(0,0,0,.72)";
    g.fillRect(W * 0.3, H * 0.27, W * 0.4, H * 0.16);
    g.fillStyle = "#fff";
    g.font = `bold ${Math.round(H * 0.1)}px Arial, sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(ch.call, W / 2, H * 0.35);
  }

  function tune(idx) {
    S.lastTuned = S.tuned;
    S.tuned = idx;
    const ch = channels[idx];
    if (hls) { hls.destroy(); hls = null; }
    if (ch.stream) {
      tv.classList.add("has-stream");
      const isHls = /\.m3u8(\?|$)/i.test(ch.stream);
      if (isHls && !video.canPlayType("application/vnd.apple.mpegurl") && window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls();
        hls.loadSource(ch.stream);
        hls.attachMedia(video);
      } else {
        video.src = ch.stream;
      }
      video.muted = false;
      video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
    } else {
      tv.classList.remove("has-stream");
      video.removeAttribute("src"); video.load();
      drawTestCard(ch);
    }
  }
  function surf(d) { tune((S.tuned + d + N) % N); showBanner(); }

  // ------------------------------------------------------------------- input
  document.addEventListener("keydown", (e) => {
    const k = e.key;
    if (/^[0-9]$/.test(k)) { digit(k); e.preventDefault(); return; }
    if (S.watching) {
      switch (k) {
        case "ArrowUp": case "PageUp": case "+": surf(1); break;
        case "ArrowDown": case "PageDown": case "-": surf(-1); break;
        case "Enter": case "i": case "I": case " ": showBanner(); break;
        case "l": case "L": tune(S.lastTuned); showBanner(); break;
        case "Escape": if ($("banner").classList.contains("show")) hideBanner(); else openGuide(); break;
        case "g": case "G": case "Backspace": openGuide(); break;
        default: return;
      }
    } else {
      if (S.entry && k === "Enter") { commitEntry(); e.preventDefault(); return; }
      switch (k) {
        case "ArrowUp": moveVert(-1); break;
        case "ArrowDown": moveVert(1); break;
        case "ArrowLeft": e.shiftKey ? shiftDay(-1) : moveLeft(); break;
        case "ArrowRight": e.shiftKey ? shiftDay(1) : moveRight(); break;
        case "PageUp": page(-1); break;
        case "PageDown": page(1); break;
        case "Enter": case " ": enter(); break;
        case "Escape": case "g": case "G": case "Backspace": watch(); break;
        default: return;
      }
    }
    e.preventDefault();
  });

  let wheelAcc = 0;
  document.addEventListener("wheel", (e) => {
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 60) return;
    const d = Math.sign(wheelAcc); wheelAcc = 0;
    if (S.watching) surf(-d); else moveVert(d);
  }, { passive: true });

  tv.addEventListener("click", (e) => { e.stopPropagation(); S.watching ? openGuide() : watch(); });

  // ----------------------------------------------------------------- scaling
  function fit() {
    const s = Math.min(window.innerWidth / 800, window.innerHeight / 600);
    stage.style.setProperty("--scale", s);
  }
  window.addEventListener("resize", fit);
  fit();

  // ------------------------------------------------------------------- clock
  let lastMinute = -1;
  setInterval(() => {
    const m = Math.floor(Date.now() / MIN);
    if (m === lastMinute) return;
    lastMinute = m;
    renderClock();
    if (!S.watching && S.ws < nowSlot()) {
      S.ws = nowSlot();
      if (S.focus < S.ws) S.focus = S.ws;
      renderGrid();
    }
  }, 1000);

  // -------------------------------------------------------------------- boot
  tune(0);
  S.tuned = 0; S.lastTuned = 0;
  openGuide();
  renderClock();
  lastMinute = Math.floor(Date.now() / MIN);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => !S.watching && renderGrid());

  // public API for the future IPTV player
  window.guide = {
    channels,
    tune: (n) => { const i = channels.findIndex((c) => c.n === n); if (i >= 0) { tune(i); if (S.watching) showBanner(); else renderGrid(); } },
    setStream: (n, url) => { const c = channels.find((c) => c.n === n); if (c) { c.stream = url; if (channels[S.tuned] === c) tune(S.tuned); } },
    openGuide, watch,
  };
})();
