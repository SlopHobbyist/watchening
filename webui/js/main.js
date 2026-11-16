/*
 * iGuide-style IPTV viewer: program guide, full-screen player, settings.
 *
 * Keys (guide):    arrows move · PgUp/PgDn page · Shift+Left/Right -/+ 1 day
 *                  Enter tune · 0-9 channel entry · Esc / G back to TV · S settings
 * Keys (watching): Up/Down, PgUp/PgDn channel · 0-9 tune · Enter / I info
 *                  Space pause · Left/Right rewind 10s / forward 30s
 *                  C subtitles · [ ] subtitle offset -/+0.1s ({ } 1s, \ reset)
 *                  V load .srt/.vtt · M mute · L last channel · F full screen
 *                  G / Esc guide · S settings
 * Mouse:           click a listing to select it, click again to tune · wheel scrolls
 *                  click the picture to watch; while watching, move the mouse
 *                  for the control bar, double-click for full screen
 */
(function () {
  "use strict";
  const { $, MIN, fitText } = U;

  // ---------------------------------------------------------------- constants
  const SLOT = 30 * MIN;
  const SLOT_PX = 196;               // pixels per half hour
  const ROWS = 4;
  const ROW_TOP = [2, 56, 111, 165]; // row offsets inside #grid
  const GAP = 3;                     // gap between listings
  const NAV_SPAN = 3 * SLOT;         // the three visible columns are navigable
  const DAY = 24 * 60 * MIN;
  const DAYS_BACK = 1, DAYS_AHEAD = 8;

  const stage = $("stage"), tv = $("tv");

  const App = (window.App = {
    all: [],           // every channel from enabled playlists, in channel order
    channels: [],      // the ones not hidden: what the guide shows
    data: new Map(),   // playlist id -> parsed playlist
    guide: null,       // merged XMLTV data
    epgStatus: "",
    epgBusy: false,
    mode: "guide",     // guide | watch | menu
  });
  let epoch = 0, horizon = 0;
  function setWindow() {
    const m = U.midnight(Date.now());
    epoch = m - DAYS_BACK * DAY;
    horizon = m + DAYS_AHEAD * DAY;
  }
  setWindow();

  // ----------------------------------------------------------------- schedule
  /** The program on `ch` at time t. Gaps (and channels without guide data)
   *  get a placeholder spanning the gap, flagged `none`. */
  function programAt(ch, t) {
    const a = ch.sched;
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].end <= t) lo = mid + 1;
      else if (a[mid].start > t) hi = mid - 1;
      else return a[mid];
    }
    const start = lo > 0 ? a[lo - 1].end : Math.min(epoch, t);
    const end = lo < a.length ? a[lo].start : Math.max(horizon, t + SLOT);
    return a.length
      ? { title: "To Be Announced", start, end, none: true }
      : { title: ch.name, start, end, none: true, empty: true };
  }
  function programsIn(ch, from, to) {
    const out = [];
    let p = programAt(ch, from);
    while (p.start < to) { out.push(p); if (p.end >= horizon) break; p = programAt(ch, p.end); }
    return out;
  }
  const same = (a, b) => a && b && a.start === b.start && a.title === b.title;

  function describe(p) {
    const parts = [];
    if (p.sub) parts.push(`"${p.sub}"`);
    if (p.isNew) parts.push("New");
    if (p.year && p.cat === "movie") parts.push(`(${p.year})`);
    if (p.desc) parts.push(p.desc);
    return parts.join(", ");
  }

  // -------------------------------------------------------------------- state
  const N = () => App.channels.length;
  const S = {
    sel: 0,          // selected channel index (into App.channels)
    top: 0,          // channel index in the first visible row
    ws: U.floorSlot(Date.now()), // window start
    focus: Date.now(),           // time the cursor sits on
    tunedKey: null,
    lastKey: null,
    entry: "", entryTimer: 0,
  };
  const nowSlot = () => U.floorSlot(Date.now());
  const rowOf = (idx) => (idx - S.top + N()) % N();
  const tunedIdx = () => App.channels.findIndex((c) => c.key === S.tunedKey);
  const tunedCh = () => App.all.find((c) => c.key === S.tunedKey) || null;

  // ------------------------------------------------------------------ render
  const els = {
    clock: $("clock"), title: $("i-title"), chan: $("i-chan"), time: $("i-time"),
    icons: $("i-icons"), desc: $("i-desc"), day: $("tb-day"),
    t: [$("tb-t0"), $("tb-t1"), $("tb-t2")], chans: $("chans"), progs: $("progs"), empty: $("empty"),
  };

  /*
   * Ratings badges: a flat white rounded box with the lettering cut out of it.
   * The box's drop shadow (CSS) shows through the cut-outs, so the letters read
   * as dark, with the background peeking along their top-left edges.
   * TV ratings stack "TV" over "PG"; MPAA ratings ("PG-13") and HD are one line.
   */
  let badgeId = 0;
  function badgeSvg(w, h, texts) {
    const id = "bm" + ++badgeId;
    const cut = texts.map(({ t, x, y, size, len, stroke = 0 }) =>
      `<text x="${x}" y="${y}" font-size="${size}" text-anchor="middle"` +
      (len ? ` textLength="${len}" lengthAdjust="spacingAndGlyphs"` : "") +
      (stroke ? ` stroke="#000" stroke-width="${stroke}" stroke-linejoin="round"` : "") +
      `>${U.esc(t)}</text>`).join("");
    // The shadow is a solid card under the cut-out one, so every hole shows dark.
    return `<svg class="badge" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="${U.esc(texts.map((x) => x.t).join("-"))}">
      <mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">
        <rect width="${w}" height="${h}" rx="4.5" fill="#fff"/>${cut}
      </mask>
      <rect x="1" y="1.5" width="${w - 0.5}" height="${h - 0.5}" rx="4.5" class="badge-shadow"/>
      <rect width="${w}" height="${h}" rx="4.5" class="badge-fill" mask="url(#${id})"/></svg>`;
  }
  // TV ratings: 30x28 card, "TV" over the rating in small, widely set caps.
  function badgeTV(r) {
    const lo = r.replace(/^TV-/, "");
    const W = 30, H = 28;
    return badgeSvg(W, H, [
      { t: "TV", x: W / 2, y: 12.2, size: 13, len: 20.5, stroke: 0.55 },
      { t: lo, x: W / 2, y: 24, size: 13, len: lo.length > 1 ? 21.5 : 0, stroke: 0.55 },
    ]);
  }
  // MPAA ratings / HD / CC: one line of big caps filling ~55% of the card height.
  function badgeBox(txt) {
    const size = 21, H = 28;
    const len = Math.round(U.textW(txt, size) * 1.08);
    const W = Math.max(30, len + 8);
    return badgeSvg(W, H, [{ t: txt, x: W / 2, y: 21.5, size, len, stroke: 0.45 }]);
  }
  function badges(ch, p) {
    let s = "";
    if (ch.hd) s += badgeBox("HD");
    if (p && /^TV-/.test(p.rating || "")) s += badgeTV(p.rating);
    else if (p && p.rating) s += badgeBox(p.rating);
    return s;
  }

  /** Fill the info panel (top left). Shared with the settings screen. */
  App.showInfo = function ({ title = "", chan = "", time = "", icons = "", desc = "" }) {
    els.chan.textContent = chan;
    fitText(els.chan, chan, true);
    els.title.style.maxWidth = Math.max(120, 464 - 55 - 11 - els.chan.offsetWidth - 14) + "px";
    fitText(els.title, title, true);
    els.time.textContent = time;
    els.icons.innerHTML = icons;
    fitText(els.desc, desc, false);
  };

  function renderInfo(ch, p) {
    App.showInfo({
      title: p.empty ? ch.name : p.title,
      chan: `${ch.n} ${ch.call}`,
      time: p.none ? ch.group || "Live" : U.fmtRange(p.start, p.end),
      icons: badges(ch, p.none ? null : p),
      desc: p.none
        ? p.empty
          ? `${ch.name}${ch.group ? ` (${ch.group})` : ""}. No guide information is available for this channel.`
          : "No program information."
        : describe(p),
    });
  }

  /** Channel column: logo, number, and the name squeezed to fit (the column
   *  draws its glyphs horizontally stretched, so short names get wider). */
  function chanCell(ch, idx, row, showEntry) {
    const c = document.createElement("div");
    c.className = "chan" + (showEntry ? " entry" : "");
    c.style.top = ROW_TOP[row] + "px";
    if (ch.logo) {
      const img = document.createElement("img");
      img.className = "logo";
      img.referrerPolicy = "no-referrer";
      img.alt = "";
      img.draggable = false;
      img.onerror = () => img.remove();
      img.src = ch.logo;
      c.appendChild(img);
    }
    const num = document.createElement("div");
    num.className = "num";
    num.textContent = showEntry ? S.entry + "_" : ch.n;
    const call = document.createElement("div");
    call.className = "call";
    if (!ch.logo) c.classList.add("nologo");
    const AVAIL = ch.logo ? 94 : 142, MIN_SX = 0.72;
    let text = ch.call, w = U.textW(text, 20);
    let sx = Math.min(1.4, AVAIL / Math.max(1, w));
    if (sx < MIN_SX) {
      while (text.length > 2 && U.textW(text + "...", 20) * MIN_SX > AVAIL) text = text.slice(0, -1);
      text = text.trimEnd() + "...";
      sx = MIN_SX;
    }
    call.textContent = text;
    call.style.transform = `scaleX(${sx.toFixed(3)})`;
    c.append(num, call);
    c.addEventListener("click", () => select(idx, S.focus));
    return c;
  }

  function renderGrid() {
    if (App.mode !== "guide") return;
    const ws = S.ws;
    els.day.textContent = U.dayLabel(ws);
    els.t.forEach((el, k) => (el.textContent = U.fmtSlot(ws + k * SLOT)));

    if (!N()) {
      els.chans.replaceChildren();
      els.progs.replaceChildren();
      els.empty.classList.add("show");
      els.empty.textContent = App.all.length
        ? "All channels are hidden. Press S for Settings to show them."
        : "No channels yet. Press S (or choose Settings below) to add an M3U playlist.";
      App.showInfo({
        title: "Welcome",
        desc: "Add an IPTV playlist (M3U or M3U8) from a web address or a file on this computer, then come back here to browse.",
      });
      return;
    }
    els.empty.classList.remove("show");

    const visEnd = ws + ((800 - 164) / SLOT_PX) * SLOT;
    const sel = programAt(App.channels[S.sel], S.focus);
    const chanFrag = document.createDocumentFragment();
    const progFrag = document.createDocumentFragment();
    const cellsToFit = [];

    for (let row = 0; row < Math.min(ROWS, N()); row++) {
      const idx = (S.top + row) % N();
      const ch = App.channels[idx];
      chanFrag.appendChild(chanCell(ch, idx, row, S.entry && idx === S.sel));

      for (const p of programsIn(ch, ws, visEnd)) {
        const x0 = ((Math.max(p.start, ws) - ws) / SLOT) * SLOT_PX;
        const x1 = ((Math.min(p.end, horizon) - ws) / SLOT) * SLOT_PX - GAP;
        const w = Math.min(x1, 800) - x0;
        if (w <= 0) continue;
        const isSel = idx === S.sel && same(p, sel);
        const cell = document.createElement("div");
        cell.className = "cell" + (p.cat ? " " + p.cat : "") + (isSel ? " sel" : "");
        cell.style.left = x0 + "px";
        cell.style.width = x1 - x0 + "px";
        cell.style.top = ROW_TOP[row] + "px";
        if (w > 72) {
          const span = document.createElement("span");
          span.style.maxWidth = Math.max(0, Math.min(x1, 636) - x0 - 13) + "px";
          cell.appendChild(span);
          cellsToFit.push([span, p.year && p.cat === "movie" ? `${p.title} (${p.year})` : p.title]);
        }
        cell.addEventListener("click", () => {
          if (idx === S.sel && same(programAt(App.channels[idx], S.focus), p)) enter();
          else select(idx, Math.max(p.start, S.ws));
        });
        progFrag.appendChild(cell);
      }
    }
    els.chans.replaceChildren(chanFrag);
    els.progs.replaceChildren(progFrag);
    for (const [span, text] of cellsToFit) fitText(span, text, false);

    renderInfo(App.channels[S.sel], sel);
  }

  function renderClock() {
    const t = U.fmtClock(Date.now());
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
    if (N() <= ROWS) S.top = 0;
    else if (rowOf(idx) >= ROWS) S.top = idx;
    renderGrid();
  }
  function moveVert(d) {
    const n = N();
    if (!n) return;
    S.sel = (S.sel + d + n) % n;
    if (n <= ROWS) S.top = 0;
    else if (rowOf(S.sel) >= ROWS) S.top = d < 0 ? S.sel : (S.sel - ROWS + 1 + n) % n;
    renderGrid();
  }
  function page(d) {
    const n = N();
    if (!n) return;
    S.sel = (((S.sel + d * ROWS) % n) + n) % n;
    S.top = n <= ROWS ? 0 : (((S.top + d * ROWS) % n) + n) % n;
    if (n > ROWS && rowOf(S.sel) >= ROWS) S.top = S.sel;
    renderGrid();
  }
  function moveRight() {
    if (!N()) return;
    const ch = App.channels[S.sel];
    const p = programAt(ch, S.focus);
    if (p.end >= horizon) return;
    const next = programAt(ch, p.end);
    while (next.start >= S.ws + NAV_SPAN) S.ws += SLOT;
    clampWs();
    S.focus = Math.max(next.start, S.ws);
    renderGrid();
  }
  function moveLeft() {
    if (!N()) return;
    const ch = App.channels[S.sel];
    const p = programAt(ch, S.focus);
    const ns = nowSlot();
    if (p.start < S.ws && S.ws > ns) {          // reveal the rest of a long show first
      S.ws = Math.max(ns, U.floorSlot(p.start));
      S.focus = Math.max(p.start, S.ws);
      return renderGrid();
    }
    if (p.start <= S.ws) {
      if (S.ws <= ns) return;                    // can't go back past now
      const prev = programAt(ch, p.start - 1);
      S.ws = Math.max(ns, U.floorSlot(prev.start));
      S.focus = Math.max(prev.start, S.ws);
      return renderGrid();
    }
    const prev = programAt(ch, p.start - 1);
    S.focus = Math.max(prev.start, S.ws);
    renderGrid();
  }
  function shiftDay(d) {
    S.ws += d * DAY;
    clampWs();
    S.focus = Math.max(S.ws, Math.min(S.focus + d * DAY, S.ws + NAV_SPAN - 1));
    renderGrid();
  }

  // ------------------------------------------------------------------- modes
  function setMode(m) {
    App.mode = m;
    stage.classList.toggle("watching", m === "watch");
    stage.classList.toggle("in-menu", m === "menu");
    document.body.classList.toggle("watching", m === "watch");
    if (m !== "watch") { hideBanner(); hidePbar(); }
    layoutTv();
  }
  App.openGuide = function () {
    setMode("guide");
    S.ws = nowSlot();
    S.focus = Date.now();
    const ti = tunedIdx();
    if (ti >= 0) { S.sel = ti; S.top = ti; }
    if (S.sel >= N()) S.sel = 0;
    if (N() <= ROWS) S.top = 0;
    renderGrid();
  };
  App.watch = function () {
    if (!N()) return App.openMenu();
    if (tunedIdx() < 0) tune(Math.min(S.sel, N() - 1));
    setMode("watch");
    showBanner();
  };
  App.openMenu = function (page) {
    setMode("menu");
    Settings.open(page);
  };
  function enter() {
    if (!N()) return App.openMenu();
    const ch = App.channels[S.sel];
    if (ch.key !== S.tunedKey) tune(S.sel);
    App.watch();
  }

  /** Put the video over the guide's picture-in-picture slot, or full window. */
  function layoutTv() {
    if (App.mode === "watch") {
      tv.classList.add("full");
      tv.classList.remove("pip");
      tv.style.left = tv.style.top = tv.style.width = tv.style.height = "";
    } else {
      const r = $("pipslot").getBoundingClientRect();
      tv.classList.add("pip");
      tv.classList.remove("full");
      tv.style.left = r.left + "px";
      tv.style.top = r.top + "px";
      tv.style.width = r.width + "px";
      tv.style.height = r.height + "px";
    }
  }

  // ------------------------------------------------------------ channel entry
  function digit(dg) {
    if (!N()) return;
    S.entry = (S.entry + dg).slice(0, 4);
    clearTimeout(S.entryTimer);
    if (App.mode === "watch") { $("osd-num").textContent = S.entry + "-"; $("osd-num").classList.add("show"); }
    else renderGrid();
    const maxDigits = String(App.all.length).length;
    if (S.entry.length >= maxDigits) commitEntry();
    else S.entryTimer = setTimeout(commitEntry, 1800);
  }
  function commitEntry() {
    clearTimeout(S.entryTimer);
    const n = parseInt(S.entry, 10);
    S.entry = "";
    $("osd-num").classList.remove("show");
    if (isNaN(n) || !N()) return renderGrid();
    let idx = App.channels.findIndex((c) => c.n >= n);
    if (idx < 0) idx = N() - 1;
    if (App.mode === "watch") { tune(idx); showBanner(); }
    else { S.sel = idx; S.top = N() <= ROWS ? 0 : idx; renderGrid(); }
  }

  // --------------------------------------------------------------- tuning
  function tune(idx) {
    const ch = App.channels[idx];
    if (!ch) return;
    if (S.tunedKey !== ch.key) S.lastKey = S.tunedKey;
    S.tunedKey = ch.key;
    Store.cfg.last = ch.key;
    Store.save();
    Player.load(ch);
  }
  App.tuneKey = (key) => {
    const i = App.channels.findIndex((c) => c.key === key);
    if (i >= 0) tune(i);
    return i >= 0;
  };
  function surf(d) {
    const n = N();
    if (!n) return;
    const i = tunedIdx();
    tune(((i < 0 ? 0 : i) + d + n) % n);
    showBanner();
  }
  function lastChannel() {
    if (!S.lastKey) return;
    if (App.tuneKey(S.lastKey)) showBanner();
  }

  // ------------------------------------------------------------------ banner
  let bannerTimer = 0;
  function showBanner(ms = 5000) {
    const ch = tunedCh();
    if (!ch || App.mode !== "watch") return;
    hidePbar();
    const p = programAt(ch, Date.now());
    const chanEl = $("b-chan"), titleEl = $("b-title");
    renderClock();
    $("banner").classList.add("show");
    fitText(chanEl, `${ch.n} ${ch.call}`, true);
    titleEl.style.maxWidth = Math.max(160, 792 - 182 - chanEl.offsetWidth - 58 - 18) + "px";
    fitText(titleEl, p.empty ? ch.name : p.title, true);
    $("b-time").textContent = Player.error ? "No Signal" : p.none ? ch.group || "Live" : U.fmtRange(p.start, p.end);
    const desc = Player.error
      ? Player.error
      : Player.loading ? "Tuning..." : p.none ? (p.empty ? ch.name : "No program information.") : describe(p);
    fitText($("b-desc"), desc, true);
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, ms);
  }
  function hideBanner() { clearTimeout(bannerTimer); $("banner").classList.remove("show"); }
  const bannerShown = () => $("banner").classList.contains("show");

  // ------------------------------------------------------- progress / trick bar
  const pb = {
    root: $("pbar"), title: $("pb-title"), chan: $("pb-chan"), left: $("pb-left"), right: $("pb-right"),
    track: $("pb-track"), fill: $("pb-fill"), mark: $("pb-mark"), tab: $("pb-tab"), pos: $("pb-pos"),
    state: $("pb-state").firstElementChild, playIcon: $("pb-play-icon"),
  };
  const ICON = {
    play: "M7,1 L19,8 L7,15 Z",
    pause: "M5,1 H10 V15 H5 Z M14,1 H19 V15 H14 Z",
    rew: "M11,1 L1,8 L11,15 Z M23,1 L13,8 L23,15 Z",
    ff: "M1,1 L11,8 L1,15 Z M13,1 L23,8 L13,15 Z",
  };
  let pbarTimer = 0, pbarTick = 0, flash = { dir: 0, until: 0 }, pbarHover = false;
  const pbarShown = () => pb.root.classList.contains("show");

  function showPbar(ms = 4000) {
    if (App.mode !== "watch" || !tunedCh()) return;
    hideBanner();
    pb.root.classList.add("show");
    tv.classList.add("lifted");
    renderPbar();
    clearInterval(pbarTick);
    pbarTick = setInterval(renderPbar, 250);
    armPbar(ms);
  }
  function armPbar(ms) {
    clearTimeout(pbarTimer);
    pbarTimer = setTimeout(() => {
      // a paused picture keeps its bar, as does a bar under the mouse
      if (pbarHover || (Player.paused() && Player.canPause())) armPbar(1500);
      else hidePbar();
    }, ms);
  }
  function hidePbar() {
    clearTimeout(pbarTimer);
    clearInterval(pbarTick);
    pb.root.classList.remove("show");
    tv.classList.remove("lifted");
  }

  function renderPbar() {
    const ch = tunedCh();
    if (!ch || !pbarShown()) return;
    const now = Date.now();
    const p = programAt(ch, now);
    fitText(pb.chan, `${ch.n} ${ch.call}`, true);
    pb.title.style.maxWidth = Math.max(160, 720 - 30 - pb.chan.offsetWidth - 20) + "px";
    fitText(pb.title, p.empty ? ch.name : p.title, true);

    const r = Player.range();
    let left = "", right = "", frac = 1, pos = "";
    if (r && r.vod) {
      const t = Player.time();
      left = "0:00"; right = U.fmtDur(r.end); pos = U.fmtDur(t);
      frac = (t - r.start) / (r.end - r.start);
    } else if (r) {
      const t = Player.time(), behind = r.end - t;
      left = U.fmtSlot(now - (r.end - r.start) * 1000); right = "Live";
      pos = behind < 15 ? "Live" : "-" + U.fmtDur(behind);
      frac = (t - r.start) / (r.end - r.start);
    } else if (!p.none) {
      left = U.fmtSlot(p.start); right = U.fmtSlot(p.end); pos = U.fmtSlot(now);
      frac = (now - p.start) / (p.end - p.start);
    } else {
      pos = Player.error ? "No Signal" : Player.loading ? "Tuning" : "Live";
    }
    frac = U.clamp(frac || 0, 0, 1);
    pb.left.textContent = left;
    pb.right.textContent = right;
    pb.fill.style.width = frac * 100 + "%";
    pb.mark.style.left = frac * 100 + "%";
    pb.pos.textContent = pos;

    let state = "play";
    if (Player.paused() && Player.canPause()) state = "pause";
    if (flash.until > now) state = flash.dir < 0 ? "rew" : "ff";
    pb.state.setAttribute("d", Player.canPause() ? ICON[state] : "");
    pb.playIcon.setAttribute("d", Player.paused() ? ICON.play : ICON.pause);

    // tab hangs under the marker, kept inside the bar
    const trackX = pb.track.offsetLeft, trackW = pb.track.offsetWidth;
    const tabW = pb.tab.offsetWidth;
    pb.tab.style.left = U.clamp(trackX + frac * trackW - tabW / 2, 0, 720 - tabW) + "px";

    pb.root.classList.toggle("seekable", !!r);
    pb.root.querySelector('[data-act="play"]').classList.toggle("disabled", !Player.canPause());
    pb.root.querySelector('[data-act="cc"]').classList.toggle("on", !!Player.cc);
  }

  // ----------------------------------------------------------------- actions
  let osdTimer = 0;
  function osd(text, ms = 2500) {
    const el = $("osd");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => el.classList.remove("show"), ms);
  }
  App.osd = osd;

  const fmtOffset = (o) => (o > 0 ? "+" : o < 0 ? "-" : "") + Math.abs(o).toFixed(1) + "s";
  const act = {
    play() {
      if (!Player.togglePause()) return;
      showPbar();
    },
    rew() {
      if (Player.skip(-10)) flash = { dir: -1, until: Date.now() + 900 };
      else osd("Rewind isn't available on this channel");
      showPbar();
    },
    ff() {
      if (Player.skip(30)) flash = { dir: 1, until: Date.now() + 900 };
      else osd("Fast forward isn't available on this channel");
      showPbar();
    },
    cc() {
      const label = Player.cycleCC();
      if (label === null) osd("No subtitles in this stream. Press V to load an .srt or .vtt file.", 4000);
      else osd(label === "Off" ? "Subtitles Off" : `Subtitles: ${label}`);
      if (pbarShown()) renderPbar();
    },
    offset(d) {
      const o = Player.nudgeOffset(d);
      osd(`Subtitle Offset ${fmtOffset(o)}` + (Player.cc ? "" : " (subtitles are off)"));
    },
    subFile() { $("file-sub").click(); },
    mute() { osd(Player.toggleMute() ? "Mute" : "Sound On"); },
    guide() { App.openGuide(); },
    fullscreen() {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen().catch(() => {});
    },
    watch() { App.watch(); },
    menu() { App.openMenu(); },
  };
  App.act = act;

  Player.on((type, msg) => {
    if (type === "error") {
      if (App.mode === "watch") showBanner(8000);
      else osd(msg, 5000);
    } else if (type === "muted") {
      osd("Sound is off: press any key or click to turn it on", 4000);
    } else if (type === "unmuted") {
      clearTimeout(osdTimer);
      $("osd").classList.remove("show");
    } else if (type === "state" || type === "cc") {
      if (pbarShown()) renderPbar();
      if (type === "state" && App.mode === "watch" && bannerShown() && !Player.loading) showBanner();
    }
  });

  $("file-sub").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) loadSubFile(f);
  });
  async function loadSubFile(f) {
    if (!Player.ch) return osd("Tune to a channel first");
    try {
      const n = Player.loadSubs(f.name, await U.readFile(f));
      osd(`Subtitles: ${Player.ccLabel()} (${n} lines)`, 3000);
    } catch (err) {
      osd(err.message, 4000);
    }
  }

  // ------------------------------------------------------------------- input
  function keyWatch(e, k) {
    switch (k) {
      case "ArrowUp": case "PageUp": case "ChannelUp": case "+": surf(1); break;
      case "ArrowDown": case "PageDown": case "ChannelDown": case "-": surf(-1); break;
      case " ": case "k": case "K": case "MediaPlayPause": case "MediaPlay": case "MediaPause": act.play(); break;
      case "ArrowLeft": case ",": case "MediaRewind": case "MediaTrackPrevious": act.rew(); break;
      case "ArrowRight": case ".": case "MediaFastForward": case "MediaTrackNext": act.ff(); break;
      case "Enter": case "i": case "I": bannerShown() ? hideBanner() : showBanner(); break;
      case "c": case "C": act.cc(); break;
      case "[": act.offset(-0.1); break;
      case "]": act.offset(0.1); break;
      case "{": act.offset(-1); break;
      case "}": act.offset(1); break;
      case "\\": act.offset(0); break;
      case "v": case "V": act.subFile(); break;
      case "m": case "M": act.mute(); break;
      case "l": case "L": case "Backspace": lastChannel(); break;
      case "p": case "P": pbarShown() ? hidePbar() : showPbar(); break;
      case "Escape":
        if (bannerShown()) hideBanner();
        else if (pbarShown()) hidePbar();
        else App.openGuide();
        break;
      case "g": case "G": case "ContextMenu": App.openGuide(); break;
      default: return false;
    }
    return true;
  }
  function keyGuide(e, k) {
    if (S.entry && k === "Enter") { commitEntry(); return true; }
    switch (k) {
      case "ArrowUp": moveVert(-1); break;
      case "ArrowDown": moveVert(1); break;
      case "ArrowLeft": e.shiftKey ? shiftDay(-1) : moveLeft(); break;
      case "ArrowRight": e.shiftKey ? shiftDay(1) : moveRight(); break;
      case "PageUp": case "ChannelUp": page(-1); break;
      case "PageDown": case "ChannelDown": page(1); break;
      case "Enter": case " ": enter(); break;
      case "Escape": case "g": case "G": case "Backspace": if (N()) App.watch(); break;
      default: return false;
    }
    return true;
  }

  document.addEventListener("keydown", (e) => {
    Player.unlock();
    if (Dialog.key(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (App.mode === "menu") { if (Settings.key(e)) e.preventDefault(); return; }
    if (/^[0-9]$/.test(k)) { digit(k); e.preventDefault(); return; }
    let handled = true;
    if (k === "s" || k === "S") App.openMenu();
    else if (k === "f" || k === "F") act.fullscreen();
    else handled = App.mode === "watch" ? keyWatch(e, k) : keyGuide(e, k);
    if (handled) e.preventDefault();
  });
  document.addEventListener("pointerdown", () => Player.unlock(), true);

  let wheelAcc = 0;
  document.addEventListener("wheel", (e) => {
    if (Dialog.isOpen()) return;
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 60) return;
    const d = Math.sign(wheelAcc);
    wheelAcc = 0;
    if (App.mode === "menu") Settings.wheel(d);
    else if (App.mode === "watch") surf(-d);
    else moveVert(d);
  }, { passive: true });

  // the picture: from the guide it starts watching; while watching it toggles the bar
  let clickTimer = 0;
  tv.addEventListener("click", () => {
    if (App.mode !== "watch") {
      if (App.mode === "guide") App.watch();
      return;
    }
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => (pbarShown() ? hidePbar() : showPbar()), 220);
  });
  tv.addEventListener("dblclick", () => {
    if (App.mode !== "watch") return;
    clearTimeout(clickTimer);
    act.fullscreen();
  });

  // mouse movement while watching: show the bar, hide the cursor when idle
  let idleTimer = 0, lastMove = 0;
  document.addEventListener("mousemove", (e) => {
    if (App.mode !== "watch") return;
    document.body.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add("idle"), 3000);
    if (Math.abs(e.movementX) + Math.abs(e.movementY) < 3) return;
    const now = Date.now();
    if (now - lastMove < 200) return;
    lastMove = now;
    if (!pbarShown() && !bannerShown()) showPbar();
    else if (pbarShown()) armPbar(4000);
  });

  pb.root.addEventListener("mouseenter", () => (pbarHover = true));
  pb.root.addEventListener("mouseleave", () => (pbarHover = false));
  pb.root.querySelectorAll(".pb-btn").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); act[b.dataset.act](); }));
  pb.track.addEventListener("click", (e) => {
    const r = pb.track.getBoundingClientRect();
    if (Player.seekFrac((e.clientX - r.left) / r.width)) showPbar();
  });
  $("banner").addEventListener("click", hideBanner);
  document.querySelectorAll("#footer .fbtn").forEach((b) => b.addEventListener("click", () => act[b.dataset.act]()));

  // drag a playlist or subtitle file onto the window
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    const subs = files.filter((f) => /\.(srt|vtt)$/i.test(f.name));
    const lists = files.filter((f) => !/\.(srt|vtt)$/i.test(f.name));
    if (subs.length) loadSubFile(subs[0]);
    if (lists.length) Settings.addFiles(lists);
  });

  // ----------------------------------------------------------------- scaling
  function fit() {
    const s = Math.min(window.innerWidth / 800, window.innerHeight / 600);
    stage.style.setProperty("--scale", s);
    layoutTv();
  }
  window.addEventListener("resize", fit);

  // ------------------------------------------------------------- data: lineup
  /** Recompute the channel list from enabled playlists, order and hidden sets. */
  App.rebuild = function () {
    const cfg = Store.cfg;
    const list = [], seen = new Set();
    for (const pl of cfg.playlists) {
      if (!pl.enabled) continue;
      const d = App.data.get(pl.id);
      if (!d) continue;
      for (const c of d.channels) {
        let key = pl.id + "|" + c.url;
        for (let k = 2; seen.has(key); k++) key = pl.id + "|" + c.url + "#" + k;
        seen.add(key);
        list.push({
          key, url: c.url, name: c.name, call: U.shortName(c.name), logo: c.logo, group: c.group,
          tvgId: c.tvgId, tvgName: c.tvgName, plId: pl.id, plName: pl.name,
          hd: /\b(HD|FHD|UHD|4K|1080[pi]?|720p)\b/i.test(c.name), sched: [], nat: list.length,
        });
      }
    }
    const pos = new Map(cfg.order.map((k, i) => [k, i]));
    const rank = (c) => (pos.has(c.key) ? pos.get(c.key) : 1e9 + c.nat);
    list.sort((a, b) => rank(a) - rank(b));
    const hidden = new Set(cfg.hidden);
    list.forEach((c, i) => { c.n = i + 1; c.hidden = hidden.has(c.key); });

    App.all = list;
    App.channels = list.filter((c) => !c.hidden);
    attachGuide();

    // keep watching the same channel if it still exists
    const t = tunedCh();
    if (t && !t.hidden) Player.ch = t;
    else if (S.tunedKey) {
      if (N()) tune(Math.min(Math.max(0, S.sel), N() - 1));
      else { S.tunedKey = null; Player.stop(); }
    }
    if (S.sel >= N()) S.sel = Math.max(0, N() - 1);
    if (N() <= ROWS) S.top = 0;
    else if (S.top >= N()) S.top = S.sel;
    refreshViews();
  };

  function attachGuide() {
    for (const c of App.all) c.sched = XMLTV.lookup(App.guide, c) || [];
  }

  function refreshViews() {
    if (App.mode === "guide") renderGrid();
    else if (App.mode === "menu") Settings.render();
  }
  App.refreshViews = refreshViews;

  // ---------------------------------------------------------- data: playlists
  /** Read (and with `refresh`, re-download) one playlist into App.data. */
  App.loadPlaylist = async function (pl, refresh) {
    let text = null;
    if (pl.type === "url" && refresh) {
      try {
        text = await U.fetchText(pl.url, Store.cfg.prefs.proxy);
        await Store.put("pl:" + pl.id, text);
        pl.updated = Date.now();
        pl.error = "";
      } catch (e) {
        pl.error = e.message;
      }
    }
    if (text == null) text = await Store.get("pl:" + pl.id);
    if (text == null) {
      if (!pl.error) pl.error = "Not downloaded yet";
      App.data.delete(pl.id);
      return null;
    }
    let parsed = M3U.parse(text, pl.type === "url" ? pl.url : "");
    if (parsed.isStream) {
      // a single HLS stream added by URL: treat it as a one-channel playlist
      parsed = { channels: [{ name: pl.name, url: pl.url, tvgId: "", tvgName: "", logo: "", group: "" }], epg: [] };
    }
    pl.count = parsed.channels.length;
    App.data.set(pl.id, parsed);
    return parsed;
  };

  function nameFromUrl(url) {
    try {
      const u = new URL(url);
      const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
      const base = last.replace(/\.(m3u8?|txt|php)$/i, "");
      return base && !/^(get|playlist|index|list|tv|iptv)$/i.test(base) ? base : u.hostname.replace(/^www\./, "");
    } catch {
      return "Playlist";
    }
  }

  async function addPlaylist(pl, text) {
    await Store.put("pl:" + pl.id, text);
    Store.cfg.playlists.push(pl);
    await App.loadPlaylist(pl, false);
    Store.save();
    App.rebuild();
    App.loadGuideData(false);
    return pl;
  }

  App.addUrl = async function (url, name) {
    let u;
    try { u = new URL(url); } catch { throw new Error("That doesn't look like a web address"); }
    if (!/^https?:$/.test(u.protocol)) throw new Error("Only http:// and https:// addresses can be loaded");
    const text = await U.fetchText(u.href, Store.cfg.prefs.proxy);
    const parsed = M3U.parse(text, u.href);
    if (!parsed.isStream && !parsed.channels.length) throw new Error("No channels were found at that address");
    const pl = {
      id: U.uid(), name: name || nameFromUrl(u.href), type: "url", url: u.href,
      enabled: true, count: 0, updated: Date.now(), error: "",
    };
    return addPlaylist(pl, text);
  };

  App.addFile = async function (file) {
    const text = await U.readFile(file);
    const parsed = M3U.parse(text, "");
    if (parsed.isStream) throw new Error(`${file.name} is a single video stream, not a channel list. Add its web address instead.`);
    if (!parsed.channels.length) throw new Error(`No channels were found in ${file.name}`);
    const pl = {
      id: U.uid(), name: file.name.replace(/\.(m3u8?|txt)$/i, ""), type: "file", url: file.name,
      enabled: true, count: 0, updated: Date.now(), error: "",
    };
    return addPlaylist(pl, text);
  };

  App.removePlaylist = async function (pl) {
    const cfg = Store.cfg;
    cfg.playlists = cfg.playlists.filter((p) => p !== pl);
    const mine = (k) => k.startsWith(pl.id + "|");
    cfg.order = cfg.order.filter((k) => !mine(k));
    cfg.hidden = cfg.hidden.filter((k) => !mine(k));
    App.data.delete(pl.id);
    await Store.del("pl:" + pl.id);
    Store.save();
    App.rebuild();
    App.loadGuideData(false);
  };

  App.refreshAll = async function () {
    const pls = Store.cfg.playlists.filter((p) => p.type === "url");
    await Promise.all(pls.map((p) => App.loadPlaylist(p, true)));
    Store.save();
    App.rebuild();
    await App.loadGuideData(true);
    return pls;
  };

  // --------------------------------------------------------- data: guide (EPG)
  App.epgSources = function () {
    const custom = (Store.cfg.prefs.epgUrl || "").trim();
    if (custom) return custom.split(/[\s,]+/).filter(Boolean);
    const set = new Set();
    for (const pl of Store.cfg.playlists) {
      const d = pl.enabled && App.data.get(pl.id);
      if (d) d.epg.forEach((u) => set.add(u));
    }
    return [...set];
  };

  let epgRun = 0;
  App.loadGuideData = async function (force) {
    const my = ++epgRun;
    const urls = App.epgSources();
    setWindow();
    if (!urls.length) {
      App.guide = null;
      App.epgBusy = false;
      App.epgStatus = "No guide data. Enter an XMLTV address, or use a playlist that names one (url-tvg).";
      attachGuide();
      refreshViews();
      return;
    }
    App.epgBusy = true;
    App.epgStatus = "Loading guide data...";
    refreshViews();
    const guides = [], errs = [];
    for (const url of urls) {
      try {
        let rec = await Store.get("epg:" + url);
        if (force || !rec || Date.now() - rec.ts > 6 * 3600e3) {
          try {
            const text = await U.fetchText(url, Store.cfg.prefs.proxy);
            rec = { ts: Date.now(), text };
            await Store.put("epg:" + url, rec);
          } catch (e) {
            if (!rec) throw e;
            errs.push(e.message + " (using saved copy)");
          }
        }
        if (my !== epgRun) return;
        guides.push(XMLTV.parse(rec.text, epoch, horizon));
      } catch (e) {
        errs.push(e.message);
      }
      if (my !== epgRun) return;
    }
    App.guide = guides.length ? XMLTV.merge(guides) : null;
    App.epgBusy = false;
    attachGuide();
    const matched = App.all.filter((c) => c.sched.length).length;
    App.epgStatus = App.guide
      ? `Listings for ${matched} of ${App.all.length} channels.` + (errs.length ? ` Problem: ${errs[0]}` : "")
      : `Couldn't load guide data: ${errs[0] || "unknown error"}`;
    refreshViews();
  };

  App.setPrefs = function (patch) {
    Object.assign(Store.cfg.prefs, patch);
    Store.save();
    Player.ccDefault = !!Store.cfg.prefs.ccDefault;
    Player.setCCSize(Store.cfg.prefs.ccSize);
  };

  // ------------------------------------------------------------------- clock
  let lastMinute = -1;
  setInterval(() => {
    const m = Math.floor(Date.now() / MIN);
    if (m === lastMinute) return;
    lastMinute = m;
    renderClock();
    if (U.midnight(Date.now()) - DAYS_BACK * DAY !== epoch) { setWindow(); App.loadGuideData(false); }
    if (App.mode === "guide" && S.ws < nowSlot()) {
      S.ws = nowSlot();
      if (S.focus < S.ws) S.focus = S.ws;
      renderGrid();
    }
  }, 1000);

  // -------------------------------------------------------------------- boot
  async function boot() {
    App.setPrefs({});
    fit();
    renderClock();
    lastMinute = Math.floor(Date.now() / MIN);
    await Promise.all(Store.cfg.playlists.map((pl) => App.loadPlaylist(pl, false)));
    App.rebuild();
    if (N()) {
      const i = App.channels.findIndex((c) => c.key === Store.cfg.last);
      tune(i >= 0 ? i : 0);
      App.openGuide();
    } else {
      Player.stop();
      App.openMenu(0);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refreshViews);

    // re-download web playlists that are more than an hour old
    const stale = Store.cfg.playlists.filter(
      (pl) => pl.type === "url" && (!App.data.has(pl.id) || !pl.updated || Date.now() - pl.updated > 3600e3));
    if (stale.length) {
      await Promise.all(stale.map((pl) => App.loadPlaylist(pl, true)));
      Store.save();
      App.rebuild();
    }
    App.loadGuideData(false);
  }
  // settings.js loads after this file
  window.addEventListener("DOMContentLoaded", boot);
})();
