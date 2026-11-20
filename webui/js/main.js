/*
 * iGuide-style IPTV viewer: program guide, full-screen player, On Demand
 * (ondemand.js), settings.
 *
 * Everything works from a TV remote's D-pad, OK and Back alone:
 *   watching        Up / Down channel · Left / Right back / ahead 5s
 *                   OK opens the controls · Back hides the info / controls, else opens the guide
 *   controls        Up / Down: the timeline or the row of buttons
 *                   timeline: Left / Right back / ahead 10s (held: 30s) · OK pause
 *                   buttons: Left / Right pick · OK press · Back closes
 *   guide, menus    arrows move · OK chooses · Back goes back (from the guide: the picture)
 *
 * Keys (watching): also W / S channel · A / D 5s · J back 10s · L ahead 10s · 0-9 tune
 *                  Space / K play/pause · C captions on/off · Shift+C subtitle options
 *                  Shift+F display options · M mute · F full screen · G guide
 *                  O On Demand · I info · P controls
 *                  Esc / Backspace work as Back
 *                  (also: PgUp/PgDn channel,
 *                   [ ] subtitle offset -/+0.1s, { } 1s, \ reset, media keys,
 *                   remote Guide / Info / Captions / Settings keys)
 * Keys (menus):    arrows / WASD move · Enter OK · Esc / Backspace back
 *                  guide: Shift+Left/Right -/+ 1 day · PgUp/PgDn page · 0-9 channel · O On Demand
 *                  (its first rows are On Demand and Search; Down past the last channel
 *                   jumps back to them)
 * Anywhere:        F1 settings
 *                  (custom channels, see channels.js: the controls have Vote, and
 *                   play/pause and ◀▶ ask everyone watching to pause or seek)
 *                  Skip Intro / Skip Credits over the picture: OK presses it, Back hides it
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
  const PROGS_X = 164;               // left edge of the listings
  const DAY = 24 * 60 * MIN;
  const DAYS_BACK = 1, DAYS_AHEAD = 8;

  const stage = $("stage"), tv = $("tv"), guideEl = $("guide");
  /** Stage width: 800, or 1067 in 16:9 mode (set by the .wide class, see style.css). */
  const stageW = () => stage.offsetWidth;
  /** Whole half-hour columns on screen (3, or 4 in 16:9 mode): the navigable span. */
  const cols = () => Math.floor((stageW() - PROGS_X) / SLOT_PX);
  const navSpan = () => cols() * SLOT;

  const App = (window.App = {
    all: [],           // every channel from enabled playlists, in channel order
    channels: [],      // the ones not hidden: what the guide shows
    data: new Map(),   // playlist id -> parsed playlist
    guide: null,       // merged XMLTV data
    epgStatus: "",
    epgBusy: false,
    mode: "guide",     // guide | watch | menu | vod (On Demand's lists)
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
    sel: 0,          // selected channel index (into App.channels); on a shortcut, the last one
    pos: 0,          // selected guide row (see "rows")
    top: 0,          // guide row in the first visible row
    find: null,      // Search (channels): { s: keyboard session, hits, list, typing }
    backTo: null,    // a shortcut row to come back to (On Demand's)
    ws: U.floorSlot(Date.now()), // window start
    focus: Date.now(),           // time the cursor sits on
    tunedKey: null,
    vod: null,       // the On Demand title playing (a channel-like object, see ondemand.js), or null
    entry: "", entryTimer: 0,
  };
  const nowSlot = () => U.floorSlot(Date.now());

  // --------------------------------------------------------------------- rows
  /*
   * The guide's rows: shortcuts that look like channels at the top (On
   * Demand, Search), then the channels; after a search, its row and just the
   * channels that matched. S.pos is the selected row and S.top the first on
   * screen. The list doesn't wrap around on screen: Down past the last
   * channel jumps back to the top, Up from the top to the last channel.
   */
  const shortcuts = () => (S.find && S.find.list ? ["found"] : ["ondemand", "search"]);
  /** Channel indexes a search narrowed the guide to, or null: all of them. */
  const shown = () => (S.find && S.find.list) || null;
  const nRows = () => (N() ? shortcuts().length + (shown() || App.channels).length : 0);
  /** A row: { special } or { idx } (a channel). */
  function rowAt(p) {
    const sc = shortcuts();
    if (p < sc.length) return { special: sc[p] };
    const l = shown();
    return { idx: l ? l[p - sc.length] : p - sc.length };
  }
  function posOf(idx) {
    const l = shown();
    const i = l ? l.indexOf(idx) : idx;
    return i < 0 ? -1 : shortcuts().length + i;
  }
  const onChannel = () => rowAt(S.pos).idx != null;
  /** Scroll as little as needed to show the selected row. */
  function reveal() {
    if (S.pos < S.top) S.top = S.pos;
    if (S.pos >= S.top + ROWS) S.top = S.pos - ROWS + 1;
    S.top = U.clamp(S.top, 0, Math.max(0, nRows() - ROWS));
  }
  /** Put a channel in the top row (or as near as the end of the list lets it). */
  function toTop(idx) {
    S.sel = idx;
    S.pos = Math.max(0, posOf(idx));
    S.top = S.pos;
    reveal();
  }
  const tunedIdx = () => App.channels.findIndex((c) => c.key === S.tunedKey);
  const tunedCh = () => App.all.find((c) => c.key === S.tunedKey) || null;
  /** What's on the picture: an On Demand title, else the tuned channel. */
  const playing = () => S.vod || tunedCh();
  App.vod = () => S.vod;
  /** "23 ESPN", or for On Demand "S1 E3" / the year. */
  const chanText = (ch) => (ch.vod ? ch.call : `${ch.n} ${ch.call}`);
  /** Channel key for per-channel options (none for On Demand). */
  const optKey = () => (S.vod ? null : S.tunedKey);

  // ------------------------------------------------------------------ render
  const els = {
    clock: $("clock"), title: $("i-title"), chan: $("i-chan"), time: $("i-time"),
    icons: $("i-icons"), desc: $("i-desc"), day: $("tb-day"),
    t: [$("tb-t0"), $("tb-t1"), $("tb-t2"), $("tb-t3")], chans: $("chans"), progs: $("progs"), empty: $("empty"),
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
  App.badgeHtml = (hd, rating) => badges({ hd }, rating ? { rating } : null);

  /** Fill the info panel (top left). Shared with the settings screen.
   *  `head` (On Demand): a heading line above the title, the screen's name;
   *  the description then starts right under the title when there's no time. */
  App.showInfo = function ({ head = "", title = "", chan = "", time = "", icons = "", desc = "" }) {
    const info = $("info");
    info.classList.toggle("head", !!head);
    info.classList.toggle("notime", !!head && !time && !icons);
    if (head) $("i-head-t").textContent = head;
    els.chan.textContent = chan;
    fitText(els.chan, chan, true);
    els.title.style.maxWidth = Math.max(120, $("info").offsetWidth - 55 - 11 - els.chan.offsetWidth - 14) + "px";
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
      // only the guide's visible rows exist, so this already asks for just a
      // few icons at a time; lazy/async keep them from holding up the page
      img.loading = "lazy";
      img.decoding = "async";
      img.onerror = () => img.remove();
      img.src = U.mediaUrl(ch.logo);
      c.appendChild(img);
    }
    const num = document.createElement("div");
    num.className = "num";
    num.textContent = showEntry ? S.entry + "_" : ch.n;
    if (!ch.logo) c.classList.add("nologo");
    c.append(num, callEl(ch.call, ch.logo ? 94 : 142));
    c.addEventListener("click", () => select(idx, S.focus));
    return c;
  }
  /** A channel's name, squeezed (or stretched) to the column's width. */
  function callEl(text, avail) {
    const call = document.createElement("div");
    call.className = "call";
    const MIN_SX = 0.72;
    let sx = Math.min(1.4, avail / Math.max(1, U.textW(text, 20)));
    if (sx < MIN_SX) {
      while (text.length > 2 && U.textW(text + "...", 20) * MIN_SX > avail) text = text.slice(0, -1);
      text = text.trimEnd() + "...";
      sx = MIN_SX;
    }
    call.textContent = text;
    call.style.transform = `scaleX(${sx.toFixed(3)})`;
    return call;
  }

  // ---------------------------------------------------------------- shortcuts
  /* On Demand and Search, at the top of the guide, drawn like channels: an
     icon where the logo goes, a name, and one listing across. */
  const ICONS = {
    ondemand: '<svg class="icon" viewBox="0 0 44 40" aria-hidden="true"><rect x="4" y="5" width="36" height="25" rx="4" fill="#fff"/>' +
      '<path d="M18.5,11 L29,17.5 L18.5,24 Z" fill="#26498b"/><rect x="15" y="33" width="14" height="3.4" rx="1.7" fill="#fff"/></svg>',
    search: '<svg class="icon" viewBox="0 0 44 40" aria-hidden="true"><circle cx="19" cy="17" r="10" fill="none" stroke="#fff" stroke-width="4.6"/>' +
      '<path d="M26.5,24.5 L34.5,32.5" stroke="#fff" stroke-width="5.6" stroke-linecap="round"/></svg>',
  };
  const chans = (n) => (n === 1 ? "1 Channel" : `${n || "No"} Channels`);
  function shortcut(kind) {
    const f = S.find;
    switch (kind) {
      case "ondemand": {
        const has = OnDemand.hasSources();
        return {
          icon: ICONS.ondemand, num: "ON", call: "DEMAND",
          text: has ? "Movies and TV Shows" : "Set Up On Demand",
          info: has
            ? { title: "On Demand", chan: "ON DEMAND", desc: "Movies and TV shows from your media server, to watch whenever you like. Press OK." }
            : { title: "On Demand", chan: "ON DEMAND", desc: "Watch the movies and shows on your Plex or Jellyfin server. Press OK to set it up." },
        };
      }
      case "search":
        return {
          icon: ICONS.search, call: "SEARCH", text: "Search Channels",
          info: { title: "Search Channels", desc: "Find a channel by typing part of its name, or its number. Press OK." },
        };
      case "found": {
        const q = f.s.q.trim(), n = f.list.length;
        return {
          icon: ICONS.search, call: "SEARCH", text: `"${q}": ${chans(n)}`,
          info: { title: `"${q}"`, chan: chans(n), desc: "Only the channels that match are showing. OK or Back changes the search; Back from there shows every channel." },
        };
      }
    }
  }
  /** A shortcut's row: the channel-like cell and its listing. */
  function shortcutRow(sc, pos, row, isSel, chanFrag, progFrag, toFit, W) {
    const c = document.createElement("div");
    c.className = "chan special";
    c.style.top = ROW_TOP[row] + "px";
    c.insertAdjacentHTML("beforeend", sc.icon);
    if (sc.num) {
      const num = document.createElement("div");
      num.className = "num on";
      num.textContent = sc.num;
      c.appendChild(num);
    }
    c.appendChild(callEl(sc.call, 94));
    const cell = document.createElement("div");
    cell.className = "cell special" + (isSel ? " sel" : "");
    cell.style.left = "0px";
    cell.style.width = W - PROGS_X + "px";
    cell.style.top = ROW_TOP[row] + "px";
    const span = document.createElement("span");
    cell.appendChild(span);
    toFit.push([span, sc.text]);
    const click = () => (S.pos === pos ? enter() : go(pos));
    c.addEventListener("click", click);
    cell.addEventListener("click", click);
    chanFrag.appendChild(c);
    progFrag.appendChild(cell);
  }

  function renderGrid() {
    if (App.mode !== "guide") return;
    if (S.find && S.find.typing) return renderFind();
    guideEl.classList.remove("searching");
    Keyboard.hide();
    const ws = S.ws;
    els.day.textContent = U.dayLabel(ws);
    els.t.forEach((el, k) => (el.textContent = U.fmtSlot(ws + k * SLOT)));

    if (!N()) {
      els.chans.replaceChildren();
      els.progs.replaceChildren();
      els.empty.classList.add("show");
      els.empty.textContent = App.all.length
        ? "All channels are hidden. Press OK for Settings to show them."
        : OnDemand.hasSources()
          ? "No channels yet. Press OK for On Demand. Add an M3U playlist in Settings (F1)."
          : "No channels yet. Press OK for Settings to add an M3U playlist.";
      App.showInfo({
        title: "Welcome",
        desc: "Add an IPTV playlist (M3U or M3U8) from a web address or a file on this computer, then come back here to browse.",
      });
      return;
    }
    els.empty.classList.remove("show");

    const W = stageW();
    const visEnd = ws + ((W - PROGS_X) / SLOT_PX) * SLOT;
    const selRow = rowAt(S.pos);
    const sel = selRow.idx != null ? programAt(App.channels[selRow.idx], S.focus) : null;
    const chanFrag = document.createDocumentFragment();
    const progFrag = document.createDocumentFragment();
    const cellsToFit = [];

    for (let row = 0; row < Math.min(ROWS, nRows() - S.top); row++) {
      const pos = S.top + row, r = rowAt(pos);
      if (r.special) {
        shortcutRow(shortcut(r.special), pos, row, pos === S.pos, chanFrag, progFrag, cellsToFit, W);
        continue;
      }
      const idx = r.idx;
      const ch = App.channels[idx];
      chanFrag.appendChild(chanCell(ch, idx, row, S.entry && idx === S.sel));

      for (const p of programsIn(ch, ws, visEnd)) {
        const x0 = ((Math.max(p.start, ws) - ws) / SLOT) * SLOT_PX;
        const x1 = ((Math.min(p.end, horizon) - ws) / SLOT) * SLOT_PX - GAP;
        const w = Math.min(x1, W) - x0;
        if (w <= 0) continue;
        const isSel = pos === S.pos && same(p, sel);
        const cell = document.createElement("div");
        cell.className = "cell" + (p.cat ? " " + p.cat : "") + (isSel ? " sel" : "");
        cell.style.left = x0 + "px";
        cell.style.width = x1 - x0 + "px";
        cell.style.top = ROW_TOP[row] + "px";
        if (w > 72) {
          const span = document.createElement("span");
          span.style.maxWidth = Math.max(0, Math.min(x1, W - PROGS_X) - x0 - 13) + "px";
          cell.appendChild(span);
          cellsToFit.push([span, p.year && p.cat === "movie" ? `${p.title} (${p.year})` : p.title]);
        }
        cell.addEventListener("click", () => {
          if (pos === S.pos && same(programAt(App.channels[idx], S.focus), p)) enter();
          else go(pos, Math.max(p.start, S.ws));
        });
        progFrag.appendChild(cell);
      }
    }
    els.chans.replaceChildren(chanFrag);
    els.progs.replaceChildren(progFrag);
    for (const [span, text] of cellsToFit) fitText(span, text, false);

    if (selRow.special) App.showInfo(shortcut(selRow.special).info);
    else renderInfo(App.channels[S.sel], sel);
  }

  function renderClock() {
    const t = U.fmtClock(Date.now());
    els.clock.textContent = t;
    $("b-clock").textContent = t;
    $("m-clock").textContent = t;
  }

  // -------------------------------------------------------------- navigation
  function clampWs() {
    S.ws = Math.max(nowSlot(), Math.min(S.ws, horizon - (cols() + 1) * SLOT));
  }
  /** Select a row (and the time the cursor sits on, if given). */
  function go(pos, focus) {
    S.pos = U.clamp(pos, 0, Math.max(0, nRows() - 1));
    const r = rowAt(S.pos);
    if (r.idx != null) S.sel = r.idx;
    if (focus != null) S.focus = focus;
    reveal();
    renderGrid();
  }
  const select = (idx, focus) => go(posOf(idx), focus);
  /** Up / down a row. Past the end it jumps to the other end (`wrap`; not for the mouse wheel). */
  function moveVert(d, wrap = true) {
    const n = nRows();
    if (!n) return;
    let p = S.pos + d;
    if (p >= n) p = wrap ? 0 : n - 1;
    else if (p < 0) p = wrap ? n - 1 : 0;
    go(p);
  }
  function page(d) {
    const n = nRows();
    if (!n) return;
    if (d > 0 && S.pos === n - 1) return go(0);   // at the end: back to the top
    if (d < 0 && S.pos === 0) return go(n - 1);
    S.top = U.clamp(S.top + d * ROWS, 0, Math.max(0, n - ROWS));
    go(S.pos + d * ROWS);
  }

  // --------------------------------------------------------- search channels
  /*
   * The Search shortcut: the on-screen keyboard (keyboard.js) in place of
   * the listings. Matching is done here, so what matches shows in the info
   * panel at once, as you type: channels whose number is what's typed, then
   * those with a word starting with it, then numbers starting with it, then
   * names with it anywhere. Search then shows the guide with only those
   * channels (under a row saying what was searched); OK on that row or Back
   * returns to the keyboard, and Back from the keyboard to every channel.
   */
  const fold = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
  function findChannels(q) {
    const f = fold(q);
    if (!f) return [];
    const tiers = [[], [], [], []];
    const digits = /^\d+$/.test(f);
    App.channels.forEach((c, i) => {
      const src = `${c.name} ${c.call}`;
      if (c.fold == null || c.foldSrc !== src) { c.fold = " " + fold(src) + " "; c.foldSrc = src; }
      const n = String(c.n);
      if (digits && n === f) tiers[0].push(i);
      else if (c.fold.includes(" " + f)) tiers[1].push(i);
      else if (digits && n.startsWith(f)) tiers[2].push(i);
      else if (f.length > 1 && c.fold.includes(f)) tiers[3].push(i);
    });
    return tiers.flat();
  }
  function openFind() {
    if (!S.find) {
      const f = (S.find = { hits: [], list: null, typing: false });
      f.s = Keyboard.session({
        placeholder: "Type a channel name or number",
        onInput: (q) => { f.hits = findChannels(q); findShow(); },
        onGo: showFound,
        onBack: closeFind,
        hint: () => Voice.hint(App.channels.map((c) => c.name)),
      });
    }
    S.find.typing = true;
    renderGrid();
  }
  /** Back from the keyboard: every channel again, on the Search row. */
  function closeFind() {
    S.find = null;
    go(shortcuts().indexOf("search"));
  }
  /** Search: the guide, showing only the channels that match. */
  function showFound() {
    const f = S.find;
    if (!f.hits.length) return;
    f.list = f.hits.slice();
    f.typing = false;
    S.top = 0;
    go(shortcuts().length);
  }
  function renderFind() {
    guideEl.classList.add("searching");
    Keyboard.show($("g-search"), S.find.s);
    $("g-hint").textContent = Keyboard.hint;
    findShow();
  }
  /** What's typed matches: the count in the field, the channels in the info panel. */
  function findShow() {
    const f = S.find, q = f.s.q.trim(), n = f.hits.length;
    Keyboard.status(q ? chans(n) : "", { canGo: n > 0 });
    App.showInfo(!q
      ? { title: "Search Channels", desc: `Type part of a channel's name, or its number, here or on a keyboard${Keyboard.voice ? ", or say it with Voice" : ""}. What matches shows here as you type; Search shows it in the guide.` }
      : {
        title: `"${q}"`, chan: chans(n),
        desc: n ? f.hits.slice(0, 24).map((i) => `${App.channels[i].n} ${App.channels[i].call}`).join(", ") : "No channel matches.",
      });
  }

  function moveRight() {
    if (!N() || !onChannel()) return;
    const ch = App.channels[S.sel];
    const p = programAt(ch, S.focus);
    if (p.end >= horizon) return;
    const next = programAt(ch, p.end);
    while (next.start >= S.ws + navSpan()) S.ws += SLOT;
    clampWs();
    S.focus = Math.max(next.start, S.ws);
    renderGrid();
  }
  function moveLeft() {
    if (!N() || !onChannel()) return;
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
    S.focus = Math.max(S.ws, Math.min(S.focus + d * DAY, S.ws + navSpan() - 1));
    renderGrid();
  }

  // ------------------------------------------------------------------- modes
  function setMode(m) {
    App.mode = m;
    stage.classList.toggle("watching", m === "watch");
    stage.classList.toggle("in-menu", m === "menu");
    stage.classList.toggle("in-vod", m === "vod");
    document.body.classList.toggle("watching", m === "watch");
    document.body.classList.toggle("in-menu", m === "menu");
    if (m !== "watch") { hideBanner(); hidePbar(); Panel.close(); }
    else S.backTo = null;
    layoutTv();
  }
  /** The guide: on the channel playing, at the top; or back on the shortcut
   *  it was left from (On Demand). A search is over. */
  App.openGuide = function () {
    setMode("guide");
    S.ws = nowSlot();
    S.focus = Date.now();
    S.find = null;
    if (N()) {
      const ti = tunedIdx();
      toTop(ti >= 0 ? ti : U.clamp(S.sel, 0, N() - 1));
      const back = S.backTo ? shortcuts().indexOf(S.backTo) : -1;
      if (back >= 0) { S.pos = back; reveal(); }
    }
    S.backTo = null;
    renderGrid();
  };
  App.watch = function () {
    if (S.vod) { setMode("watch"); showBanner(); return; }
    if (!N()) return OnDemand.hasSources() ? App.openOnDemand() : App.openMenu();
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
    if (menuFrom === "watch" && (N() || S.vod)) App.watch();
    else if (menuFrom === "vod") App.openOnDemand();
    else App.openGuide();
  };

  /*
   * On Demand: its lists replace the guide's listings (the header, info and
   * picture stay). A title plays full screen like a channel, with the same
   * banner and controls; Back returns to the lists. Like a channel, it keeps
   * playing in the guide's picture while you browse the lists, the guide or
   * Settings, until you tune a channel or play something else. When it ends,
   * the channel you were on comes back.
   */
  let vodFrom = "guide";
  App.openOnDemand = function () {
    if (App.mode === "guide" || App.mode === "watch") vodFrom = App.mode;
    setMode("vod");
    OnDemand.open();
  };
  /** Back from On Demand's top list: to the guide, or the picture it was opened from. */
  App.closeOnDemand = function () {
    if (vodFrom === "watch" && (N() || S.vod)) App.watch();
    else App.openGuide();
  };
  /** Play an On Demand title. `replace`: the same title again (another
   *  subtitle drawn in), keeping its place and the controls. */
  App.playVod = function (ch, replace) {
    if (!replace) endVod();
    S.vod = ch;
    endScrub(false);
    Player.load(ch);
    Player.setOffset(0);
    Player.setScreen(screenFor(null));
    if (replace) return;
    setMode("watch");
    showBanner();
  };
  /** Stop the On Demand title, if any, telling its server where it got to. */
  function endVod() {
    const v = S.vod;
    if (!v) return null;
    S.vod = null;
    OnDemand.stopped(v);
    return v;
  }
  /** Stop the On Demand title and put the channel back on. */
  function stopVod() {
    if (!endVod()) return;
    const i = tunedIdx();
    if (i >= 0) tune(i);
    else if (N()) tune(U.clamp(S.sel, 0, N() - 1));
    else Player.stop();
  }
  App.stopVod = stopVod;

  function enter() {
    if (!N()) return OnDemand.hasSources() ? App.openOnDemand() : App.openMenu();
    const r = rowAt(S.pos);
    if (r.special === "ondemand") { App.openOnDemand(); S.backTo = "ondemand"; return; }
    if (r.special) return openFind();
    const ch = App.channels[S.sel];
    if (S.vod || ch.key !== S.tunedKey) tune(S.sel); // (tuning stops an On Demand title)
    App.watch();
  }

  /** Put the video over the guide's picture-in-picture slot, or full window.
   *  In squish mode the box is laid out at its shape on the TV (3/4 as wide)
   *  and stretched back out, so the picture, captions and an embed's own
   *  player all come out the right shape. */
  function layoutTv() {
    const k = squish();
    if (App.mode === "watch") {
      tv.classList.add("full");
      tv.classList.remove("pip");
      if (k === 1) tv.style.left = tv.style.top = tv.style.width = tv.style.height = "";
      else Object.assign(tv.style, { left: "0px", top: "0px", width: window.innerWidth * k + "px", height: window.innerHeight + "px" });
    } else {
      const r = $("pipslot").getBoundingClientRect();
      tv.classList.add("pip");
      tv.classList.remove("full");
      tv.style.left = r.left + "px";
      tv.style.top = r.top + "px";
      tv.style.width = r.width * k + "px";
      tv.style.height = r.height + "px";
    }
    tv.style.transform = k === 1 ? "" : `scaleX(${1 / k})`;
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
    if (App.mode === "watch") { tune(idx); announce(); }
    else { S.find = null; toTop(idx); renderGrid(); }
  }

  // --------------------------------------------------------------- tuning
  function tune(idx) {
    const ch = App.channels[idx];
    if (!ch) return;
    endVod();
    S.tunedKey = ch.key;
    Store.cfg.last = ch.key;
    Store.save();
    endScrub(false);
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
    if (S.vod) return showPbar(); // On Demand: no channels to change; show where it's at
    if (!n) return;
    const i = tunedIdx();
    tune(((i < 0 ? 0 : i) + d + n) % n);
    announce();
  }
  /** After a channel change: the info banner, unless the controls are open
   *  (their title row already names the new channel). */
  function announce() {
    if (ctl.on && !bannerHold) renderPbar();
    else showBanner();
  }

  // ------------------------------------------------------------------ banner
  // ms 0 holds the banner up until the controls close (the Info button)
  let bannerTimer = 0, bannerHold = false;
  /** On Demand's time line: "1h 52m · Ends at 9:42p" */
  function vodTime(ch) {
    const len = OnDemand.fmtLen(ch.dur);
    if (Player.loading || !ch.dur) return len;
    const end = U.fmtSlot(Date.now() + Math.max(0, ch.dur - Player.time()) * 1000);
    return [len, `Ends at ${end}`].filter(Boolean).join(" · ");
  }

  function showBanner(ms = 5000) {
    const ch = playing();
    if (!ch || App.mode !== "watch") return;
    const p = ch.vod ? null : programAt(ch, Date.now());
    const chanEl = $("b-chan"), titleEl = $("b-title");
    renderClock();
    $("banner").classList.add("show");
    fitText(chanEl, chanText(ch), true);
    titleEl.style.maxWidth = Math.max(160, $("banner").offsetWidth - 182 - chanEl.offsetWidth - 58 - 18) + "px";
    fitText(titleEl, !p || p.empty ? ch.name : p.title, true);
    $("b-time").textContent = Player.error ? "No Signal" : !p ? vodTime(ch) : p.none ? ch.group || "Live" : U.fmtRange(p.start, p.end);
    const desc = Player.error
      ? Player.error
      : Player.loading ? (p ? "Tuning..." : "Starting...")
        : !p ? ch.desc : p.none ? (p.empty ? ch.name : "No program information.") : describe(p);
    fitText($("b-desc"), desc, true);
    clearTimeout(bannerTimer);
    if (ms === 0) bannerHold = true;
    if (!bannerHold) bannerTimer = setTimeout(hideBanner, ms);
    placeOverlays();
  }
  function hideBanner() {
    bannerHold = false;
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
  /** Back while watching: hide the info banner / controls; with neither
   *  showing, the guide. */
  function back() {
    if (bannerShown() || pbarShown()) { hideBanner(); hidePbar(); }
    else if (S.vod) App.openOnDemand();
    else App.openGuide();
  }

  // ------------------------------------------------------- progress / trick bar
  const pb = {
    root: $("pbar"), title: $("pb-title"), chan: $("pb-chan"), left: $("pb-left"), right: $("pb-right"),
    track: $("pb-track"), fill: $("pb-fill"), mark: $("pb-mark"), tab: $("pb-tab"), pos: $("pb-pos"),
    state: $("pb-state").firstElementChild,
  };
  const ICON = {
    play: "M7,1 L19,8 L7,15 Z",
    pause: "M5,1 H10 V15 H5 Z M14,1 H19 V15 H14 Z",
    rew: "M11,1 L1,8 L11,15 Z M23,1 L13,8 L23,15 Z",
    ff: "M1,1 L11,8 L1,15 Z M13,1 L23,8 L13,15 Z",
  };
  let pbarTimer = 0, pbarTick = 0, flash = { dir: 0, until: 0 }, pbarHover = false;
  const pbarShown = () => pb.root.classList.contains("show");

  /*
   * Remote control focus in the control bar. OK opens the bar with focus on
   * the timeline (or, where the channel can't seek, on the buttons); Up and
   * Down move between the timeline and the row of buttons. The bar shown by
   * moving the mouse has no focus, so the arrows still change channel.
   */
  const CTL_MS = 8000;
  const ALL_BTNS = Array.from(pb.root.querySelectorAll(".pb-btn"));
  /** The buttons showing (Vote only on custom channels). */
  const btns = () => ALL_BTNS.filter((b) => !b.classList.contains("off"));
  const ctl = { on: false, row: "bar", btn: 0 };
  const btnIdx = (a) => Math.max(0, btns().findIndex((b) => b.dataset.act === a));
  /** Open the controls with focus; `act` focuses that button. */
  function openCtl(act) {
    if (App.mode !== "watch" || !playing()) return;
    voteButtons(playing());
    if (!ctl.on || act) {
      ctl.on = true;
      ctl.row = range() && !act ? "bar" : "btns";
      ctl.btn = act ? btnIdx(act) : 0;
    }
    if (!bannerHold) hideBanner(); // the bar would jump when it timed out
    showPbar(CTL_MS);
  }
  function moveBtn(d) {
    ctl.btn = U.clamp(ctl.btn + d, 0, btns().length - 1);
    renderCtl();
  }
  function renderCtl() {
    const on = ctl.on && pbarShown();
    if (on && ctl.row === "bar" && !range()) ctl.row = "btns";
    pb.root.classList.toggle("focus-bar", on && ctl.row === "bar");
    const shown = btns();
    ALL_BTNS.forEach((b) => b.classList.toggle("focus", on && ctl.row === "btns" && b === shown[ctl.btn]));
  }
  /** Keys while the controls have focus. */
  function keyCtl(e, nav) {
    if (!nav) return false;
    armPbar(CTL_MS);
    if (nav === "back") { hideBanner(); hidePbar(); return true; }
    if (ctl.row === "bar") {
      if (nav === "up") ctl.row = "btns";
      else if (nav === "left" || nav === "right") act.skip((nav === "left" ? -1 : 1) * (e.repeat ? 30 : 10));
      else if (nav === "ok") act.play();
    } else {
      if (nav === "down" && range()) ctl.row = "bar";
      else if (nav === "left" || nav === "right") moveBtn(nav === "left" ? -1 : 1);
      else if (nav === "ok") {
        const b = btns()[ctl.btn];
        if (b) act[b.dataset.act]({ fromCtl: true });
      }
    }
    renderCtl();
    return true;
  }

  /*
   * Where the picture can go. A custom channel is the same moment for
   * everyone, so its span is the episode on the channel's time (intro
   * left out when it's skipped), and letting go of the marker asks everyone
   * watching to go there (see channels.js); otherwise, the player's.
   */
  const chanSeek = () => (Player.ch && Player.ch.custom && !S.vod ? Channels.seekInfo() : null);
  function range() {
    const c = chanSeek();
    return c ? (c.paused ? null : { vod: true, start: c.start, end: c.end, custom: true }) : Player.range();
  }
  function nowTime() { const c = chanSeek(); return c ? c.t : Player.time(); }
  function clampTime(t) {
    const r = range();
    return r && r.custom ? U.clamp(t, r.start, r.end - 5) : Player.clampTime(t);
  }

  /*
   * Seeking with the arrows moves the marker at once but seeks only once
   * they've been let go of for a moment, so holding one down (or tapping it
   * a few times) doesn't send the player a seek per key repeat. (A custom
   * channel waits a little longer: each seek there is a vote.)
   */
  let scrub = null, scrubTimer = 0;
  function scrubBy(sec) {
    const from = scrub != null ? scrub : nowTime();
    const t = clampTime(from + sec);
    if (t == null) return false;
    scrub = t;
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => endScrub(true), chanSeek() ? 1200 : 350);
    return true;
  }
  function endScrub(seek) {
    clearTimeout(scrubTimer);
    if (seek && scrub != null) {
      if (chanSeek()) Channels.seek(scrub);
      else Player.seekTo(scrub);
    }
    scrub = null;
  }

  function showPbar(ms) {
    if (App.mode !== "watch" || !playing()) return;
    pb.root.classList.add("show");
    placeOverlays();
    renderPbar();
    clearInterval(pbarTick);
    pbarTick = setInterval(renderPbar, 250);
    armPbar(ms || (ctl.on ? CTL_MS : 4000));
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
    const held = ctl.on && bannerHold;
    ctl.on = false;
    pb.root.classList.remove("show");
    renderCtl();
    if (held) hideBanner(); // the Info button's banner goes with the controls
    placeOverlays();
  }

  function renderPbar() {
    const ch = playing();
    if (!ch || !pbarShown()) return;
    const now = Date.now();
    const p = ch.vod ? null : programAt(ch, now);
    fitText(pb.chan, chanText(ch), true);
    pb.title.style.maxWidth = Math.max(160, pb.root.offsetWidth - 30 - pb.chan.offsetWidth - 20) + "px";
    fitText(pb.title, !p || p.empty ? ch.name : p.title, true);

    const r = range();
    const cs = chanSeek();
    let left = "", right = "", frac = 1, pos = "";
    const t = scrub != null ? scrub : nowTime();
    if (cs && cs.paused) {
      left = "0:00"; right = U.fmtDur(cs.end);
      pos = `Paused ${U.fmtDur(Math.max(0, (cs.until - now) / 1000))}`;
      frac = cs.t / cs.end;
    } else if (r && r.vod) {
      left = "0:00"; right = U.fmtDur(r.end); pos = U.fmtDur(t);
      frac = (t - r.start) / (r.end - r.start);
    } else if (r) {
      const behind = r.end - t;
      left = U.fmtSlot(now - (r.end - r.start) * 1000); right = "Live";
      pos = behind < 15 ? "Live" : "-" + U.fmtDur(behind);
      frac = (t - r.start) / (r.end - r.start);
    } else if (p && !p.none) {
      left = U.fmtSlot(p.start); right = U.fmtSlot(p.end); pos = U.fmtSlot(now);
      frac = (now - p.start) / (p.end - p.start);
    } else {
      pos = Player.error ? "No Signal" : Player.loading ? (p ? "Tuning" : "Starting") : p ? "Live" : "";
      if (!p) frac = 0;
    }
    frac = U.clamp(frac || 0, 0, 1);
    pb.left.textContent = left;
    pb.right.textContent = right;
    pb.fill.style.width = frac * 100 + "%";
    pb.mark.style.left = frac * 100 + "%";
    pb.pos.textContent = pos;

    let state = "play";
    if ((Player.paused() && Player.canPause()) || (cs && cs.paused)) state = "pause";
    if (flash.until > now) state = flash.dir < 0 ? "rew" : "ff";
    pb.state.setAttribute("d", Player.canPause() || cs ? ICON[state] : "");

    // tab hangs under the marker, kept inside the bar
    const trackX = pb.track.offsetLeft, trackW = pb.track.offsetWidth;
    const tabW = pb.tab.offsetWidth;
    pb.tab.style.left = U.clamp(trackX + frac * trackW - tabW / 2, 0, pb.root.offsetWidth - tabW) + "px";

    pb.root.querySelector('[data-act="subs"]').classList.toggle("on", !!Player.cc);
    voteButtons(ch);
    renderCtl();
  }
  /** Vote: on custom channels, with how a vote stands. */
  function voteButtons(ch) {
    const custom = !!(ch && ch.custom && !ch.vod);
    const b = pb.root.querySelector('[data-act="vote"]');
    b.classList.toggle("off", !custom);
    if (custom) b.textContent = Channels.voteText();
    ctl.btn = U.clamp(ctl.btn, 0, btns().length - 1);
  }
  App.refreshControls = () => {
    if (pbarShown()) renderPbar();
    if (Panel.id() === "vote") Panel.refresh();
  };

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
      // a custom channel: ask everyone watching to pause it (or go on)
      if (chanSeek()) { Channels.pauseKey(); showPbar(); return; }
      if (!Player.togglePause()) return;
      showPbar();
    },
    /** Jump `sec` seconds (negative: back). */
    skip(sec) {
      const cs = chanSeek();
      if (scrubBy(sec)) flash = { dir: Math.sign(sec), until: Date.now() + 900 };
      else if (cs && cs.paused) osd("It's paused for everyone: resume it first (play, or Vote, Resume)", 3000);
      else osd(sec < 0 ? "Rewind isn't available on this channel" : "Fast forward isn't available on this channel");
      showPbar();
    },
    rew() { act.skip(-10); },
    /** Custom channels: Start Over, Previous, Skip, Play Next in Order (a vote when other TVs are watching). */
    vote(o) {
      if (!(Player.ch && Player.ch.custom) && Panel.id() !== "vote") return;
      togglePanel("vote", o && o.fromCtl);
      if (Panel.id() === "vote") Channels.poke();
    },
    ff() { act.skip(10); },
    cc() {
      const v = S.vod;
      if (v && v.burn) { OnDemand.chooseSub(null); return; } // subtitles drawn into the picture
      const label = Player.toggleCC();
      const file = v && (v.subs.find((x) => x.url && !x.dl) || SubSearch.mine(v.subs) || v.subs.find((x) => x.url));
      const chanFile = !v && Player.ch && Player.ch.custom ? Channels.subFile() : null;
      if (label === null && file) OnDemand.chooseSub(file);
      else if (label === null && chanFile) {
        Channels.showSub(chanFile).then(() => osd(`Subtitles: ${chanFile.label}`), (e) => osd(`Couldn't load the subtitles: ${e.message}`, 4000));
      }
      else if (label === null) osd(SubSearch.current() ? "No subtitles in this video. Subtitle Options (Shift+C) can search for some." : "No subtitles in this stream. See Subtitles for more options.", 4000);
      else osd(label === "Off" ? "Subtitles Off" : `Subtitles: ${label}`);
      if (pbarShown()) renderPbar();
    },
    offset(d) {
      const o = setOffset(d === 0 ? 0 : Player.ccOffset + d);
      osd(`Subtitle Offset ${fmtOffset(o)}` + (Player.cc ? "" : " (subtitles are off)"));
    },
    subFile() { $("file-sub").click(); },
    // from the controls, Back in the panel goes back to the controls
    subs(o) { togglePanel("subs", o && o.fromCtl); },
    screen(o) { togglePanel("screen", o && o.fromCtl); },
    info(o) {
      if (bannerShown()) hideBanner();
      else showBanner(ctl.on || (o && o.fromCtl) ? 0 : 5000);
      if (pbarShown()) renderPbar();
    },
    mute() { osd(Player.toggleMute() ? "Mute" : "Sound On"); },
    guide() { App.openGuide(); },
    ondemand() { App.openOnDemand(); },
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
    const key = optKey();
    if (key) {
      if (o) Store.cfg.ccOffsets[key] = o; else delete Store.cfg.ccOffsets[key];
      Store.save();
    }
    return o;
  }

  const CC_SIZES = ["Small", "Medium", "Large"];
  function subtitleRows() {
    const v = S.vod;
    // the title's subtitles (On Demand), or the custom channel episode's files
    const vodSubs = v ? v.subs : Channels.subs();
    const chooseSub = (s) => { const c = !v && Channels.current(); return v ? OnDemand.chooseSub(s) : c ? c.show(s) : null; };
    const subOn = (s) => (v ? OnDemand.subOn(s) : Player.cc === Player.EXT && Player.extName === s.label);
    // a subtitle file from the server has its own row, not a loaded file's
    const fromServer = (x) => x.t === Player.EXT && vodSubs.some((s) => s.url && s.label === Player.extName);
    const tracks = Player.ccTracks().filter((x) => !fromServer(x));
    const yt = !!Player.yt;
    const rows = [{
      label: "Off", check: !Player.cc && !(v && v.burn) && !(yt && Player.ytCC), desc: "No subtitles.",
      act: () => { if (v && v.burn) OnDemand.chooseSub(null); else { Player.setTrack(null); if (yt) Player.ytSetCC(null); } },
    }];
    // YouTube's own captions, drawn by its player (the languages, when it says)
    if (yt) {
      const langs = Player.ytTracks();
      if (!langs.length) {
        rows.push({
          label: "YouTube's Captions", check: Player.ytCC,
          desc: "Captions from YouTube, drawn by its player: the video's own, or made by machine. Not every video has them.",
          act: () => Player.ytSetCC(""),
        });
      }
      for (const x of langs) {
        rows.push({
          label: x.label, check: Player.ytCC && (Player.ytLang ? Player.ytLang === x.lang : x.lang.split("-")[0] === (navigator.language || "en").split("-")[0]),
          desc: "Captions from YouTube, drawn by its player.", act: () => Player.ytSetCC(x.lang),
        });
      }
    }
    for (const s of vodSubs) {
      rows.push({
        label: s.label, check: subOn(s),
        desc: s.dl ? `Downloaded from OpenSubtitles, and kept on this server for everyone who plays this. ${s.dl.name || s.dl.release}`
          : s.url ? "A subtitle file on the server."
          : "Subtitles inside the video, drawn into the picture by the server. Changing them starts the picture again where it was.",
        act: () => chooseSub(s),
      });
    }
    for (const x of tracks) {
      const t = x.t;
      const desc = t === Player.EXT ? "Subtitles from a file on this computer."
        : (t.kind === "captions" ? "Closed captions" : "Subtitles") + (t.language ? ` (${t.language})` : "") + " sent by this channel.";
      rows.push({ label: x.label, check: Player.cc === t, desc, act: () => Player.setTrack(t) });
    }
    if (!tracks.length && !vodSubs.length && !yt) {
      rows.push({ label: "None in this stream", disabled: true });
    }
    rows.push({ sep: true });
    // (YouTube's own captions have neither: only a file loaded over it)
    if (!yt || Player.extCues) rows.push({
      label: "Offset", value: fmtOffset(Player.ccOffset),
      desc: "◀ shows subtitles sooner, ▶ later, by 0.1s (hold Shift for 1s). Remembered for this channel.",
      step: (d, big) => setOffset(Player.ccOffset + d * (big ? 1 : 0.1)),
      act: () => {},
    });
    if (!yt || Player.extCues) rows.push({ label: "Reset Offset", desc: "Put the subtitles back in step with the stream (offset 0.0s).", act: () => setOffset(0) });
    if (!yt || Player.extCues) rows.push({
      label: "Size", value: CC_SIZES[Player.ccSize()],
      desc: "Size of the subtitle text. The same for every channel.",
      step: (d) => App.setPrefs({ ccSize: U.clamp(Player.ccSize() + d, 0, 2) }),
      act: () => App.setPrefs({ ccSize: (Player.ccSize() + 1) % 3 }),
    });
    const found = SubSearch.current();
    if (found) rows.push({
      label: "Search for Subtitles...",
      desc: "Find subtitles for this on OpenSubtitles, in any language, as Plex does. The one you pick is kept with this title on the server, for everyone who plays it.",
      act: () => SubSearch.open(found, () => togglePanel("subs", subsFromCtl)),
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
    const key = optKey();
    const own = key && Store.cfg.screenCh[key];
    Object.assign(own || Store.cfg.screen, patch);
    Store.save();
    Player.setScreen(screenFor(key));
  }
  /** Overscan, either one setting or width and height apart (Separate X/Y). */
  function overscanRows(sc) {
    const [x, y] = Player.overscanXY(sc);
    const OS_DESC = "Above 0 pushes the edges off the screen, as a TV does. Below 0 (underscan) shrinks the picture.";
    const row = (label, v, prop, desc) => ({
      label, value: v + "%", desc,
      step: (d) => changeScreen({ [prop]: U.clamp(v + d, -50, 50) }),
    });
    const split = {
      label: "Separate X/Y", value: sc.splitScan ? "On" : "Off",
      desc: sc.splitScan ? "Overscan the width and the height apart. Off sets both to the width's." : "Set the overscan of the width and the height apart, to stretch or squeeze the picture one way only.",
      step: () => changeScreen(sc.splitScan ? { splitScan: false } : { splitScan: true, overscanY: x }),
    };
    return sc.splitScan
      ? [row("Overscan X", x, "overscan", "Width. " + OS_DESC), row("Overscan Y", y, "overscanY", "Height. " + OS_DESC), split]
      : [row("Overscan", x, "overscan", OS_DESC), split];
  }
  function screenRows() {
    const sc = Player.screen, key = optKey();
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
      ...overscanRows(sc),
      { sep: true },
      key && {
        label: "Apply To", value: own ? "This Channel" : "All Channels",
        desc: own ? "These settings are only for this channel. Other channels use the settings for all channels."
          : "These settings are for every channel without settings of its own. Choose This Channel to set this one apart.",
        step: () => {
          if (own) delete Store.cfg.screenCh[key];
          else Store.cfg.screenCh[key] = Object.assign({}, sc);
          Store.save();
          Player.setScreen(screenFor(key));
        },
      },
      { label: "Reset to Defaults", desc: "Auto shape, Fit, no crop, no overscan.", act: () => changeScreen(Object.assign({}, Player.SCREEN_DEFAULT)) },
      ...(document.fullscreenEnabled ? [{ sep: true }, {
        label: "Full Screen", value: document.fullscreenElement ? "On" : "Off",
        desc: "Fill the whole display, hiding the browser's toolbars. Also F, or double-click the picture.",
        step: () => act.fullscreen(),
      }] : []),
    ].filter(Boolean);
  }
  document.addEventListener("fullscreenchange", () => Panel.refresh());

  const PANELS = {
    subs: { title: "Subtitle Options", rows: subtitleRows },
    screen: { title: "Display Options", rows: screenRows },
    vote: { title: "Vote", rows: () => Channels.voteRows() },
  };
  let subsFromCtl = false; // Subtitle Options was opened from the controls (Back from a search goes back to it, then them)
  function togglePanel(id, fromCtl) {
    if (Panel.id() === id) return Panel.close();
    if (App.mode !== "watch" || !playing()) return;
    if (id === "subs") { subsFromCtl = !!fromCtl; SubSearch.refresh(); }
    hideBanner();
    hidePbar();
    Panel.open(Object.assign({ id, onBack: fromCtl ? () => openCtl(id) : null }, PANELS[id]));
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
    // an On Demand title ended: the channel comes back on (watching it full
    // screen: back to the lists)
    if (type === "ended" && S.vod && Player.ch === S.vod) {
      stopVod();
      if (App.mode === "watch") App.openOnDemand();
      else if (App.mode === "vod") OnDemand.open();
    }
    if (type === "cc" || type === "tracks" || type === "size") Panel.refresh();
    // the Vote panel: only on a custom channel, and its rows follow the episode
    if (type === "state" && Panel.id() === "vote") {
      if (Player.ch && Player.ch.custom) Panel.refresh(); else Panel.close();
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

  // ---------------------------------------------------- skip intro / credits
  /*
   * Skip Intro and Skip Credits, as Plex shows them: a button over the
   * picture while an On Demand title (ondemand.js) or a custom channel
   * (channels.js, where it's a vote) is in its intro or end credits. OK
   * presses it (unless the controls are open), a click too; Back hides it
   * until the next one.
   */
  const skipEl = $("skip-pop");
  let skipNow = null, skipHidden = "";
  function skipPopNow() {
    if (App.mode !== "watch" || Panel.isOpen()) return null;
    const p = S.vod ? OnDemand.skipPop() : Player.ch && Player.ch.custom ? Channels.skipPop() : null;
    return p && p.key !== skipHidden ? p : null;
  }
  function renderSkip() {
    skipNow = skipPopNow();
    skipEl.classList.toggle("show", !!skipNow);
    if (skipNow) skipEl.textContent = skipNow.label;
  }
  setInterval(renderSkip, 500);
  function pressSkip() {
    const p = skipNow;
    if (!p) return;
    skipHidden = p.key;
    renderSkip();
    p.go();
  }
  skipEl.addEventListener("click", (e) => { e.stopPropagation(); pressSkip(); });

  // ------------------------------------------------------------------- input
  function keyWatch(e, k) {
    const c = k.length === 1 ? k.toLowerCase() : k;
    const nav = U.nav(e);
    if (ctl.on && pbarShown() && keyCtl(e, nav)) return true;
    if (skipNow && skipEl.classList.contains("show")) {
      if (nav === "ok") { pressSkip(); return true; }
      if (nav === "back") { skipHidden = skipNow.key; renderSkip(); return true; }
    }
    if (e.shiftKey && c === "c") { act.subs(); return true; }
    if (e.shiftKey && c === "f") { act.screen(); return true; }
    if (nav === "ok") { openCtl(); return true; }
    if (nav === "back") { back(); return true; } // Esc, Backspace or the remote's Back
    switch (c) {
      case "ArrowUp": case "w": case "PageUp": surf(-1); break;
      case "ArrowDown": case "s": case "PageDown": surf(1); break;
      case "ChannelUp": surf(1); break;
      case "ChannelDown": surf(-1); break;
      case "ArrowRight": case "d": act.skip(e.repeat ? 15 : 5); break;
      case "ArrowLeft": case "a": act.skip(e.repeat ? -15 : -5); break;
      case "l": case "MediaFastForward": case "MediaTrackNext": act.skip(10); break;
      case "j": case "MediaRewind": case "MediaTrackPrevious": act.skip(-10); break;
      case " ": case "k": case "MediaPlayPause": case "MediaPlay": case "MediaPause": act.play(); break;
      case "c": case "ClosedCaptionToggle": case "Subtitle": act.cc(); break;
      case "m": act.mute(); break;
      case "i": case "Info": act.info(); break;
      case "p": pbarShown() && ctl.on ? hidePbar() : openCtl(); break;
      case "g": case "Guide": case "ContextMenu": App.openGuide(); break;
      case "o": App.openOnDemand(); break;
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
      case "back":
        if (shown()) openFind(); // a search's channels: back to the keyboard
        else if (N() || S.vod) App.watch();
        return true;
    }
    switch (k) {
      case "PageUp": case "ChannelUp": page(-1); break;
      case "PageDown": case "ChannelDown": page(1); break;
      case " ": enter(); break;
      case "g": case "G": case "Guide": if (N() || S.vod) App.watch(); break;
      case "o": case "O": App.openOnDemand(); break;
      default: return false;
    }
    return true;
  }

  function onKey(e) {
    if (e.isTrusted) {
      Player.unlock();
      guardBack();
      if (U.isBack(e)) lastBackKey = Date.now();
    }
    if (Dialog.key(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === "F1" || k === "Settings") {
      e.preventDefault();
      if (App.mode === "menu") Settings.close(); else App.openMenu();
      return;
    }
    if (App.mode === "menu") { if (Settings.key(e)) e.preventDefault(); return; }
    if (App.mode === "vod") { if (OnDemand.key(e)) e.preventDefault(); return; }
    if (App.mode === "guide" && S.find && S.find.typing) { if (Keyboard.key(e)) e.preventDefault(); return; }
    if (App.mode === "watch" && Panel.key(e)) { e.preventDefault(); return; }
    if (/^[0-9]$/.test(k)) { digit(k); e.preventDefault(); return; }
    let handled = true;
    if ((k === "f" || k === "F") && !e.shiftKey) act.fullscreen();
    else handled = App.mode === "watch" ? keyWatch(e, k) : keyGuide(e, k);
    if (handled) e.preventDefault();
  }
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", (e) => { Player.unlock(); if (e.isTrusted) guardBack(); }, true);

  /*
   * The Back button on a TV remote. Android TV browsers mostly don't send it
   * to the page as a key: they go back in the browser's history instead. So
   * on TVs we keep one extra history entry on top of the page; Back takes it
   * off (popstate), we treat that as the Back key and put it back. Added only
   * after a key press or click, since browsers skip history entries a page
   * adds before the user has interacted with it. ?tv in the address turns
   * this on anywhere, ?tv=0 off.
   */
  const tvParam = new URLSearchParams(location.search).get("tv");
  const TV = tvParam != null ? tvParam !== "0"
    : U.app || /\b(Android TV|GoogleTV|Google TV|AFT\w*|SHIELD|BRAVIA|CrKey|SMART-TV|SmartTV|Tizen|Web0S|webOS)\b/i.test(navigator.userAgent) ||
      matchMedia("(any-pointer: none)").matches;
  let guarded = false, lastBackKey = 0;
  function guardBack() {
    if (!TV || guarded) return;
    guarded = true;
    history.pushState({ remoteBack: true }, "");
  }
  window.addEventListener("popstate", () => {
    if (!guarded) return;
    guarded = false;
    guardBack();
    // a remote that also sent Back as a key has already been handled
    if (Date.now() - lastBackKey < 600) return;
    onKey({
      key: "GoBack", keyCode: 0, repeat: false, isTrusted: false,
      shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      preventDefault() {}, stopPropagation() {},
    });
  });

  let wheelAcc = 0;
  document.addEventListener("wheel", (e) => {
    if (Dialog.isOpen()) return;
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 60) return;
    const d = Math.sign(wheelAcc);
    wheelAcc = 0;
    if (App.mode === "menu") Settings.wheel(d);
    else if (App.mode === "vod") OnDemand.wheel(d);
    else if (App.mode === "watch") Panel.isOpen() ? Panel.move(d) : surf(d);
    else if (S.find && S.find.typing) Keyboard.move(d);
    else moveVert(d, false);
  }, { passive: true });

  // the picture: from the guide (or On Demand) it starts watching; while watching it toggles the bar
  let clickTimer = 0;
  tv.addEventListener("click", () => {
    if (App.mode !== "watch") {
      if (App.mode === "guide" || App.mode === "vod") App.watch();
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
    const f = U.clamp((e.clientX - r.left) / r.width, 0, 1);
    const cr = chanSeek() && range();
    if (cr) { Channels.seek(clampTime(cr.start + f * (cr.end - cr.start))); showPbar(); }
    else if (Player.seekFrac(f)) showPbar();
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
  /*
   * Squish mode: the box sends out 16:9 and a converter squeezes the whole
   * frame onto a 4:3 TV, so every pixel shows up 3/4 as wide as it is tall.
   * Everything is drawn 4/3 wider to cancel that out: the window is treated
   * as a 4:3 screen.
   */
  /** How wide a pixel shows up on the TV, as a fraction of its height. */
  function squish() { return Store.cfg.prefs.squish ? 3 / 4 : 1; }
  /*
   * 16:9 mode: for a widescreen display shown as it is. The stage is 1067
   * wide instead of 800 (see style.css): the header and info panel widen,
   * the picture-in-picture is 16:9 and the guide reaches a half hour further.
   */
  function fit() {
    stage.classList.toggle("wide", !!Store.cfg.prefs.wide);
    const k = squish();
    const s = Math.min((window.innerWidth * k) / stageW(), window.innerHeight / 600);
    stage.style.setProperty("--sx", s / k);
    stage.style.setProperty("--sy", s);
    layoutTv();
  }
  App.fit = fit;
  window.addEventListener("resize", fit);

  // ------------------------------------------------------------- data: lineup
  /** Recompute the channel list from enabled playlists, order and hidden sets. */
  App.rebuild = function () {
    const cfg = Store.cfg;
    const list = [], seen = new Set();
    const icons = cfg.prefs.chanIcons !== false;
    for (const pl of cfg.playlists) {
      if (!pl.enabled) continue;
      const d = App.data.get(pl.id);
      if (!d) continue;
      for (const c of d.channels) {
        let key = pl.id + "|" + c.url;
        for (let k = 2; seen.has(key); k++) key = pl.id + "|" + c.url + "#" + k;
        seen.add(key);
        list.push({
          key, url: c.url, name: c.name, call: U.shortName(c.name),
          logo: c.logo || (icons ? Logos.find(c) : ""), group: c.group,
          tvgId: c.tvgId, tvgName: c.tvgName, plId: pl.id, plName: pl.name, embed: !!c.embed,
          hd: !!c.hd || /\b(HD|FHD|UHD|4K|1080[pi]?|720p)\b/i.test(c.name), sched: [], nat: list.length,
        });
      }
    }
    // channels made from a media server's shows (channels.js), after the playlists'
    if (window.Channels) for (const c of Channels.channels()) list.push(Object.assign(c, { sched: [], nat: list.length }));
    const pos = new Map(cfg.order.map((k, i) => [k, i]));
    const rank = (c) => (pos.has(c.key) ? pos.get(c.key) : 1e9 + c.nat);
    list.sort((a, b) => rank(a) - rank(b));
    const hidden = new Set(cfg.hidden);
    list.forEach((c, i) => { c.n = i + 1; c.hidden = hidden.has(c.key); });

    App.all = list;
    App.channels = list.filter((c) => !c.hidden);
    attachGuide();

    // keep watching the same channel if it still exists (an On Demand title
    // keeps playing: the channel comes back on when it stops)
    const t = tunedCh();
    if (S.vod) { /* playing On Demand */ }
    else if (t && !t.hidden) Player.ch = t;
    else if (S.tunedKey) {
      if (N()) tune(Math.min(Math.max(0, S.sel), N() - 1));
      else { S.tunedKey = null; Player.stop(); }
    }
    if (S.sel >= N()) S.sel = Math.max(0, N() - 1);
    // a search: match again (channel indexes have changed)
    if (S.find) {
      S.find.hits = findChannels(S.find.s.q);
      if (S.find.list) S.find.list = S.find.hits.length ? S.find.hits.slice() : null;
    }
    // stay on the same channel (or shortcut)
    if (S.pos >= shortcuts().length) S.pos = posOf(S.sel) < 0 ? shortcuts().length : posOf(S.sel);
    S.pos = U.clamp(S.pos, 0, Math.max(0, nRows() - 1));
    reveal();
    refreshViews();
  };

  function attachGuide() {
    for (const c of App.all) c.sched = c.custom ? Channels.programs(c.custom) : XMLTV.withKinds(XMLTV.lookup(App.guide, c) || [], c);
  }

  function refreshViews() {
    if (App.mode === "guide") renderGrid();
    else if (App.mode === "menu") Settings.render();
    else if (App.mode === "vod") OnDemand.render();
  }
  App.refreshViews = refreshViews;

  // ---------------------------------------------------------- data: playlists
  /** Playlists downloaded from the web (refreshed hourly): M3U addresses and zlive. */
  const isWeb = (pl) => pl.type === "url" || pl.type === "zlive";
  App.isWeb = isWeb;

  /** Read (and with `refresh`, re-download) one playlist into App.data. */
  App.loadPlaylist = async function (pl, refresh) {
    const zl = pl.type === "zlive";
    if (zl) pl.name = "zlive"; // older versions saved the site's full address as its name
    let text = null;
    if (isWeb(pl) && refresh) {
      try {
        // zlive's list is open to web pages, so it never needs the proxy
        const got = await U.fetchText(pl.url, zl ? "" : Store.cfg.prefs.proxy);
        if (zl) Zlive.parse(got, pl.url); // keep the saved copy if this one is broken
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
      try { parsed = Zlive.parse(text, pl.url); } catch (e) { pl.error = e.message; App.data.delete(pl.id); return null; }
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

  /** Turn zlive's channels on (downloading its list from `address`, the site
   *  the user typed in) or off. Turning off keeps the list, channel order and
   *  hidden channels for next time. */
  App.setZlive = async function (on, address) {
    let pl = App.zlive();
    const url = on ? Zlive.manifestUrl(address || (pl && pl.url)) : "";
    if (!on) {
      if (pl) pl.enabled = false;
    } else if (pl) {
      const prev = pl.url, moved = url !== prev;
      pl.url = url;
      pl.enabled = true;
      if (moved || !App.data.has(pl.id) || !pl.updated || Date.now() - pl.updated > 3600e3) await App.loadPlaylist(pl, true);
      if (!App.data.has(pl.id) || (moved && pl.error)) {
        const err = pl.error;
        // a new address that didn't work: keep the old one and its saved list
        if (moved) { pl.url = prev; await App.loadPlaylist(pl, false); }
        pl.enabled = false;
        throw new Error(err || "Couldn't download zlive's channel list");
      }
    } else {
      pl = {
        id: "zlive", name: "zlive", type: "zlive", url,
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
    // squish mode is for a 4:3 TV: it can't be on along with 16:9 mode
    if (patch.squish) patch = Object.assign({}, patch, { wide: false });
    else if (patch.wide) patch = Object.assign({}, patch, { squish: false });
    Object.assign(Store.cfg.prefs, patch);
    Store.save();
    Player.ccDefault = !!Store.cfg.prefs.ccDefault;
    Player.setCCSize(Store.cfg.prefs.ccSize);
    if ("squish" in patch || "wide" in patch) fit();
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

  /** Settings that arrived from the server while running (sync.js): load the
   *  playlists and guide again. `sources`: the On Demand servers changed. */
  App.reloadData = async function (sources) {
    App.data.clear();
    await Promise.all(Store.cfg.playlists.map((pl) => App.loadPlaylist(pl, false)));
    App.setPrefs({});
    App.rebuild();
    if (sources) OnDemand.changed();
    const stale = Store.cfg.playlists.filter((pl) => isWeb(pl) && pl.enabled && (!App.data.has(pl.id) || !pl.updated));
    if (stale.length) {
      await Promise.all(stale.map((pl) => App.loadPlaylist(pl, true)));
      Store.saveLocal();
      App.rebuild();
    }
    App.loadGuideData(false);
  };

  /** Editing a group's settings (sync.js): say so on screen the whole time. */
  function showEditing() {
    const el = document.createElement("div");
    el.id = "editing";
    el.textContent = `Editing ${Sync.editing.name}'s settings · Settings > Account > Done to finish`;
    document.body.appendChild(el);
    document.title = `${Sync.editing.name}: Settings · TV Listings`;
  }

  // -------------------------------------------------------------------- boot
  async function boot() {
    App.setPrefs({});
    fit();
    renderClock();
    lastMinute = Math.floor(Date.now() / MIN);
    await U.serverReady; // sign-in and the stream proxy, before anything plays
    await Sync.ready;    // settings saved on the server, if they're newer
    if (Sync.editing) showEditing();
    await Promise.all(Store.cfg.playlists.map((pl) => App.loadPlaylist(pl, false)).concat([Channels.load()]));
    App.rebuild();
    if (N()) {
      const i = App.channels.findIndex((c) => c.key === Store.cfg.last);
      tune(i >= 0 ? i : 0);
      App.openGuide();
    } else {
      Player.stop();
      if (OnDemand.hasSources()) App.openOnDemand();
      else App.openMenu(0);
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
  // settings.js, ondemand.js and its sources load after this file
  window.addEventListener("DOMContentLoaded", boot);
})();
