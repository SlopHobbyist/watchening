/*
 * iGuide-style IPTV viewer: program guide, full-screen player, settings.
 *
 * Keys (watching): Up / W previous channel · Down / S next channel · 0-9 tune
 *                  Right / D ahead 5s · Left / A back 5s · J ahead 10s · L back 10s
 *                  Space / K play/pause · C captions on/off · Shift+C subtitle options
 *                  Shift+F screen options · M mute · F full screen · G guide
 *                  Enter / Esc controls + info · I info · P controls
 *                  (also: PgUp/PgDn channel, Backspace last channel,
 *                   [ ] subtitle offset -/+0.1s, { } 1s, \ reset, media keys)
 * Keys (menus):    arrows / WASD move · Enter OK · Esc / Backspace back
 *                  guide: Shift+Left/Right -/+ 1 day · PgUp/PgDn page · 0-9 channel
 *                  Esc leaves the guide for the picture
 * Anywhere:        F1 settings
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
        ? "All channels are hidden. Press F1 for Settings to show them."
        : "No channels yet. Press F1 for Settings to add an M3U playlist.";
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
    $("m-clock").textContent = t;
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
    document.body.classList.toggle("in-menu", m === "menu");
    if (m !== "watch") { hideBanner(); hidePbar(); Panel.close(); }
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
  // settings goes back to wherever it was opened from
  let menuFrom = "guide";
  App.openMenu = function (page) {
    if (App.mode !== "menu") menuFrom = App.mode;
    setMode("menu");
    Settings.open(page);
  };
  App.closeMenu = function () {
    if (menuFrom === "watch" && N()) App.watch();
    else App.openGuide();
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
    Player.setFull(App.mode === "watch");
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
    Player.setOffset(Store.cfg.ccOffsets[ch.key] || 0);
    Player.setScreen(screenFor(ch.key));
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
    placeOverlays();
  }
  function hideBanner() {
    clearTimeout(bannerTimer);
    $("banner").classList.remove("show");
    placeOverlays();
  }
  const bannerShown = () => $("banner").classList.contains("show");

  /** Info banner and control bar can show together (the bar stacks above
   *  the banner); captions move up out of their way, without animating. */
  function placeOverlays() {
    const b = bannerShown(), p = pbarShown();
    stage.classList.toggle("both", b && p);
    tv.classList.toggle("lift-b", b && !p);
    tv.classList.toggle("lift-p", p && !b);
    tv.classList.toggle("lift-bp", b && p);
  }
  /** Enter / Esc: show both, or hide whichever is showing. */
  function toggleOverlays() {
    if (bannerShown() || pbarShown()) { hideBanner(); hidePbar(); }
    else { showBanner(6000); showPbar(6000); }
  }

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
    pb.root.classList.add("show");
    placeOverlays();
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
    placeOverlays();
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
    /** Jump `sec` seconds (negative: back). */
    skip(sec) {
      if (Player.skip(sec)) flash = { dir: Math.sign(sec), until: Date.now() + 900 };
      else osd(sec < 0 ? "Rewind isn't available on this channel" : "Fast forward isn't available on this channel");
      showPbar();
    },
    rew() { act.skip(-10); },
    ff() { act.skip(10); },
    cc() {
      const label = Player.toggleCC();
      if (label === null) osd("No subtitles in this stream. Shift+C for subtitle options.", 4000);
      else osd(label === "Off" ? "Subtitles Off" : `Subtitles: ${label}`);
      if (pbarShown()) renderPbar();
    },
    offset(d) {
      const o = setOffset(d === 0 ? 0 : Player.ccOffset + d);
      osd(`Subtitle Offset ${fmtOffset(o)}` + (Player.cc ? "" : " (subtitles are off)"));
    },
    subFile() { $("file-sub").click(); },
    subs() { togglePanel("subs"); },
    screen() { togglePanel("screen"); },
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

  // -------------------------------------------------------- pop-out options
  /** Subtitle offset, remembered per channel. */
  function setOffset(sec) {
    const o = Player.setOffset(sec);
    const key = S.tunedKey;
    if (key) {
      if (o) Store.cfg.ccOffsets[key] = o; else delete Store.cfg.ccOffsets[key];
      Store.save();
    }
    return o;
  }

  const CC_SIZES = ["Small", "Medium", "Large"];
  function subtitleRows() {
    const tracks = Player.ccTracks();
    const rows = [{ label: "Off", check: !Player.cc, desc: "No subtitles.", act: () => Player.setTrack(null) }];
    for (const x of tracks) {
      const t = x.t;
      const desc = t === Player.EXT ? "Subtitles from a file on this computer."
        : (t.kind === "captions" ? "Closed captions" : "Subtitles") + (t.language ? ` (${t.language})` : "") + " sent by this channel.";
      rows.push({ label: x.label, check: Player.cc === t, desc, act: () => Player.setTrack(t) });
    }
    if (!tracks.length) {
      rows.push({ label: "None in this stream", disabled: true });
    }
    rows.push({ sep: true });
    rows.push({
      label: "Offset", value: fmtOffset(Player.ccOffset),
      desc: "◀ shows subtitles sooner, ▶ later, by 0.1s (hold Shift for 1s). Remembered for this channel.",
      step: (d, big) => setOffset(Player.ccOffset + d * (big ? 1 : 0.1)),
      act: () => {},
    });
    rows.push({ label: "Reset Offset", desc: "Put the subtitles back in step with the stream (offset 0.0s).", act: () => setOffset(0) });
    rows.push({
      label: "Size", value: CC_SIZES[Player.ccSize()],
      desc: "Size of the subtitle text. The same for every channel.",
      step: (d) => App.setPrefs({ ccSize: U.clamp(Player.ccSize() + d, 0, 2) }),
      act: () => App.setPrefs({ ccSize: (Player.ccSize() + 1) % 3 }),
    });
    rows.push({
      label: "Load Subtitle File...",
      desc: "Show an .srt or .vtt file from this computer over this channel. You can also drag the file onto the window.",
      act: () => $("file-sub").click(),
    });
    return rows;
  }

  // Screen options apply to every channel, unless a channel has its own.
  const screenFor = (key) => Object.assign({}, Player.SCREEN_DEFAULT, Store.cfg.screen, (key && Store.cfg.screenCh[key]) || {});
  const ASPECTS = [["auto", "Auto"], ["16:9", "16:9"], ["4:3", "4:3"]];
  const SCALES = [["fit", "Fit"], ["stretch", "Stretch"], ["zoom", "Zoom"]];
  const CROPS = [["off", "Off"], ["sides", "Sides"], ["tb", "Top/Bottom"]];
  const nameOf = (list, v) => (list.find((x) => x[0] === v) || list[0])[1];
  const cycle = (list, v, d) => list[(Math.max(0, list.findIndex((x) => x[0] === v)) + d + list.length) % list.length][0];

  function changeScreen(patch) {
    const key = S.tunedKey;
    const own = key && Store.cfg.screenCh[key];
    Object.assign(own || Store.cfg.screen, patch);
    Store.save();
    Player.setScreen(screenFor(key));
  }
  function screenRows() {
    const sc = Player.screen, key = S.tunedKey;
    const own = !!(key && Store.cfg.screenCh[key]);
    const src = Player.videoSize();
    const opt = (label, list, prop, desc) => ({
      label, value: nameOf(list, sc[prop]), desc,
      step: (d) => changeScreen({ [prop]: cycle(list, sc[prop], d) }),
    });
    return [
      opt("Aspect Ratio", ASPECTS, "aspect", {
        auto: "Use the channel's own shape" + (src ? ` (${src.w}x${src.h})` : "") + ". Pick 16:9 or 4:3 if people look too thin or too wide.",
        "16:9": "Show the picture as widescreen (16:9), whatever shape the channel says it is.",
        "4:3": "Show the picture as 4:3, whatever shape the channel says it is.",
      }[sc.aspect]),
      opt("Scaling", SCALES, "scale", {
        fit: "Show the whole picture, with black bars where its shape doesn't match the screen.",
        stretch: "Stretch the picture to fill the screen. Use with Crop Sides to send 4:3 shows out as 16:9.",
        zoom: "Fill the screen without reshaping the picture, cutting off whatever doesn't fit.",
      }[sc.scale]),
      opt("Crop", CROPS, "crop", {
        off: "Show the whole picture, including any black bars built into it.",
        sides: "Trim the black bars beside 4:3 shows sent inside a 16:9 picture, leaving the middle 4:3.",
        tb: "Trim the black bars above and below widescreen shows sent inside a 4:3 picture.",
      }[sc.crop]),
      {
        label: "Overscan", value: (sc.overscan || 0) + "%",
        desc: "Trim the outer edge of the picture, as a TV does. Hides lines and noise along the edges of some channels.",
        step: (d) => changeScreen({ overscan: U.clamp((sc.overscan || 0) + d, 0, 10) }),
      },
      { sep: true },
      {
        label: "Apply To", value: own ? "This Channel" : "All Channels",
        desc: own ? "These settings are only for this channel. Other channels use the settings for all channels."
          : "These settings are for every channel without settings of its own. Choose This Channel to set this one apart.",
        step: () => {
          if (!key) return;
          if (own) delete Store.cfg.screenCh[key];
          else Store.cfg.screenCh[key] = Object.assign({}, sc);
          Store.save();
          Player.setScreen(screenFor(key));
        },
      },
      { label: "Reset to Defaults", desc: "Auto shape, Fit, no crop, no overscan.", act: () => changeScreen(Object.assign({}, Player.SCREEN_DEFAULT)) },
    ];
  }

  const PANELS = {
    subs: { title: "Subtitle Options", rows: subtitleRows },
    screen: { title: "Screen Options", rows: screenRows },
  };
  function togglePanel(id) {
    if (Panel.id() === id) return Panel.close();
    if (App.mode !== "watch" || !tunedCh()) return;
    hideBanner();
    hidePbar();
    Panel.open(Object.assign({ id }, PANELS[id]));
  }

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
    if (type === "cc" || type === "tracks" || type === "size") Panel.refresh();
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
    const c = k.length === 1 ? k.toLowerCase() : k;
    if (e.shiftKey && c === "c") { act.subs(); return true; }
    if (e.shiftKey && c === "f") { act.screen(); return true; }
    switch (c) {
      case "ArrowUp": case "w": case "PageUp": surf(-1); break;
      case "ArrowDown": case "s": case "PageDown": surf(1); break;
      case "ChannelUp": surf(1); break;
      case "ChannelDown": surf(-1); break;
      case "ArrowRight": case "d": act.skip(5); break;
      case "ArrowLeft": case "a": act.skip(-5); break;
      case "j": case "MediaFastForward": case "MediaTrackNext": act.skip(10); break;
      case "l": case "MediaRewind": case "MediaTrackPrevious": act.skip(-10); break;
      case " ": case "k": case "MediaPlayPause": case "MediaPlay": case "MediaPause": act.play(); break;
      case "c": act.cc(); break;
      case "m": act.mute(); break;
      case "Enter": case "Escape": toggleOverlays(); break;
      case "i": bannerShown() ? hideBanner() : showBanner(); break;
      case "p": pbarShown() ? hidePbar() : showPbar(); break;
      case "g": case "ContextMenu": App.openGuide(); break;
      case "Backspace": lastChannel(); break;
      case "[": act.offset(-0.1); break;
      case "]": act.offset(0.1); break;
      case "{": act.offset(-1); break;
      case "}": act.offset(1); break;
      case "\\": act.offset(0); break;
      default: return false;
    }
    return true;
  }
  function keyGuide(e, k) {
    if (S.entry && k === "Enter") { commitEntry(); return true; }
    switch (U.nav(e)) {
      case "up": moveVert(-1); return true;
      case "down": moveVert(1); return true;
      case "left": e.shiftKey ? shiftDay(-1) : moveLeft(); return true;
      case "right": e.shiftKey ? shiftDay(1) : moveRight(); return true;
      case "ok": enter(); return true;
      case "back": if (N()) App.watch(); return true;
    }
    switch (k) {
      case "PageUp": case "ChannelUp": page(-1); break;
      case "PageDown": case "ChannelDown": page(1); break;
      case " ": enter(); break;
      case "g": case "G": if (N()) App.watch(); break;
      default: return false;
    }
    return true;
  }

  document.addEventListener("keydown", (e) => {
    Player.unlock();
    if (Dialog.key(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === "F1") {
      e.preventDefault();
      if (App.mode === "menu") Settings.close(); else App.openMenu();
      return;
    }
    if (App.mode === "menu") { if (Settings.key(e)) e.preventDefault(); return; }
    if (App.mode === "watch" && Panel.key(e)) { e.preventDefault(); return; }
    if (/^[0-9]$/.test(k)) { digit(k); e.preventDefault(); return; }
    let handled = true;
    if ((k === "f" || k === "F") && !e.shiftKey) act.fullscreen();
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
    else if (App.mode === "watch") Panel.isOpen() ? Panel.move(d) : surf(d);
    else moveVert(d);
  }, { passive: true });

  // the picture: from the guide it starts watching; while watching it toggles the bar
  let clickTimer = 0;
  tv.addEventListener("click", () => {
    if (App.mode !== "watch") {
      if (App.mode === "guide") App.watch();
      return;
    }
    if (Panel.isOpen()) return Panel.close();
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
    if (Panel.isOpen()) return;
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
          tvgId: c.tvgId, tvgName: c.tvgName, plId: pl.id, plName: pl.name, embed: !!c.embed,
          hd: !!c.hd || /\b(HD|FHD|UHD|4K|1080[pi]?|720p)\b/i.test(c.name), sched: [], nat: list.length,
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
  /** Playlists downloaded from the web (refreshed hourly): M3U addresses and zlive. */
  const isWeb = (pl) => pl.type === "url" || pl.type === "zlive";
  App.isWeb = isWeb;

  /** Read (and with `refresh`, re-download) one playlist into App.data. */
  App.loadPlaylist = async function (pl, refresh) {
    const zl = pl.type === "zlive";
    let text = null;
    if (isWeb(pl) && refresh) {
      try {
        // zlive's list is open to web pages, so it never needs the proxy
        const got = await U.fetchText(pl.url, zl ? "" : Store.cfg.prefs.proxy);
        if (zl) Zlive.parse(got); // keep the saved copy if this one is broken
        text = got;
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
    let parsed;
    if (zl) {
      try { parsed = Zlive.parse(text); } catch (e) { pl.error = e.message; App.data.delete(pl.id); return null; }
    } else parsed = M3U.parse(text, pl.type === "url" ? pl.url : "");
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

  /** The zlive channel source (a playlist of type "zlive"), if ever turned on. */
  App.zlive = () => Store.cfg.playlists.find((p) => p.type === "zlive") || null;

  /** Turn zlive's channels on (downloading its list) or off. Turning off
   *  keeps the list, channel order and hidden channels for next time. */
  App.setZlive = async function (on) {
    let pl = App.zlive();
    if (!on) {
      if (pl) pl.enabled = false;
    } else if (pl) {
      pl.enabled = true;
      if (!App.data.has(pl.id) || !pl.updated || Date.now() - pl.updated > 3600e3) await App.loadPlaylist(pl, true);
      if (!App.data.has(pl.id)) { pl.enabled = false; throw new Error(pl.error || "Couldn't download zlive's channel list"); }
    } else {
      pl = {
        id: "zlive", name: "zlive.st", type: "zlive", url: Zlive.MANIFEST,
        enabled: true, count: 0, updated: 0, error: "",
      };
      await App.loadPlaylist(pl, true);
      if (!App.data.has(pl.id)) throw new Error(pl.error || "Couldn't download zlive's channel list");
      Store.cfg.playlists.push(pl);
    }
    Store.save();
    App.rebuild();
    App.loadGuideData(false);
    return pl;
  };

  App.refreshAll = async function () {
    const pls = Store.cfg.playlists.filter(isWeb);
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
      (pl) => isWeb(pl) && (pl.enabled || pl.type !== "zlive") && (!App.data.has(pl.id) || !pl.updated || Date.now() - pl.updated > 3600e3));
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
