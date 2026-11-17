/*
 * On-screen keyboard, for typing with a remote: a field showing what's typed
 * and the keys under it, in the On Demand buttons' rounded style. Used by On
 * Demand's Search (titles) and the guide's Search (channels).
 *
 * QWERTY with the numbers above, laid out like a computer's keyboard (Delete
 * where Backspace is, Search where Enter is, a wide Space at the bottom), but
 * on a straight grid so ▲▼ always land on the key right above or below, and
 * ◀▶ wrap around a row. Going down onto Space and back up returns to the
 * same column. Letters come out capitalized at the start of a word.
 *
 * A keyboard's own keys type too (letters, WASD included); arrows and a
 * remote move over the on-screen keys. Enter searches right after typing on
 * a keyboard, and presses the highlighted key otherwise (a remote's OK).
 * Backspace deletes (with nothing left, it goes back) · Delete clears.
 *
 * Speed: the keys are made once and stay; moving only moves the highlight
 * (two class changes), typing only changes the field's text. What the owner
 * draws in response is up to it.
 *
 *   const s = Keyboard.session({ onInput(q), onGo(q), onBack() })
 *   Keyboard.show(parentEl, s)   put it on screen in parentEl, as s left it
 *   Keyboard.hide()
 *   Keyboard.key(e)              a key while it's showing -> handled
 *   Keyboard.move(d)             ▲▼ (the mouse wheel)
 *   Keyboard.status(note, { pending, canGo })
 *                                the field's note ("4 Matches"), dimmed while
 *                                pending; Search dims when it can't go
 */
(function () {
  "use strict";
  const ROWS = [
    [..."1234567890", { act: "del", label: "Delete" }],
    [..."QWERTYUIOP", { act: "clear", label: "Clear" }],
    [..."ASDFGHJKL'", { act: "go", label: "Search" }],
    [..."ZXCVBNM", { act: "space", label: "Space", span: 4 }],
  ];
  const COLS = 11, MAX = 40;

  function div(cls, text, id) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    if (id) d.id = id;
    if (text != null) d.textContent = text;
    return d;
  }

  // ------------------------------------------------------------------- dom
  const root = div("", null, "kb");
  const field = div("", null, "kb-field");
  field.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="M15,15 L21,21"/></svg>' +
    '<span id="kb-q"></span><span id="kb-caret"></span><span id="kb-ph">Type a name</span><span id="kb-n"></span>';
  const qEl = field.querySelector("#kb-q"), phEl = field.querySelector("#kb-ph"), nEl = field.querySelector("#kb-n");
  const keysEl = div("", null, "kb-keys");
  root.append(field, keysEl);

  /** keys: [{ el, r, c0, c1, ch | act }] · grid[row][col] -> key index */
  const keys = [], grid = [];
  ROWS.forEach((row, r) => {
    grid[r] = [];
    let c = 0;
    for (const k of row) {
      const o = typeof k === "string" ? { ch: k, label: k } : k;
      const span = o.span || 1;
      const key = Object.assign({ r, c0: c, c1: c + span - 1 }, o);
      key.el = div("kb-key" + (o.act ? " act" : ""), o.label);
      if (span > 1) key.el.style.gridColumn = `span ${span}`;
      const i = keys.push(key) - 1;
      key.el.addEventListener("click", () => {
        if (!cur) return;
        cur.typed = false;
        select(i);
        press(i, false);
      });
      keysEl.appendChild(key.el);
      for (let x = c; x < c + span; x++) grid[r][x] = i;
      c += span;
    }
  });
  const goKey = keys[grid[2][10]];

  // ----------------------------------------------------------------- state
  let cur = null;    // the session showing
  let selKey = -1;   // the key with the highlight

  function session(o) {
    return Object.assign({
      q: "",
      ki: grid[1][0], goal: 0,  // the highlighted key (Q to start); the column ▲▼ aim for
      typed: false,             // the last key was typed on a keyboard (then Enter searches)
      placeholder: "Type a name",
      onInput() {}, onGo() {}, onBack() {},
    }, o);
  }

  function show(parent, s) {
    cur = s;
    if (root.parentNode !== parent) parent.appendChild(root);
    phEl.textContent = s.placeholder;
    select(s.ki);
    drawField();
  }
  function hide() {
    cur = null;
    root.remove();
  }

  function select(i) {
    cur.ki = i;
    if (selKey === i) return;
    if (selKey >= 0) keys[selKey].el.classList.remove("sel");
    keys[i].el.classList.add("sel");
    selKey = i;
  }

  /** ◀▶ along a row (wrapping), ▲▼ to the key in the same column. */
  function move(dr, dc) {
    const k = keys[cur.ki];
    if (dc) {
      const i = grid[k.r][(dc > 0 ? k.c1 + 1 : k.c0 - 1 + COLS) % COLS];
      cur.goal = dc > 0 ? keys[i].c0 : keys[i].c1;
      return select(i);
    }
    const r = k.r + dr;
    if (r >= 0 && r < ROWS.length) select(grid[r][cur.goal]);
  }

  function press(i, repeat) {
    const k = keys[i];
    if (repeat && k.act !== "del") return; // holding OK repeats Delete only
    switch (k.act) {
      case "del": return edit(cur.q.slice(0, -1));
      case "clear": return edit("");
      case "space": return type(" ");
      case "go": return go();
    }
    type(/[A-Z]/.test(k.ch) && !/(^|\s)$/.test(cur.q) ? k.ch.toLowerCase() : k.ch);
  }
  function type(ch) {
    if (ch === " " && (!cur.q || cur.q.endsWith(" "))) return;
    if (cur.q.length >= MAX) return;
    edit(cur.q + ch);
  }
  function edit(q) {
    if (q === cur.q) return;
    cur.q = q;
    drawField();
    cur.onInput(q);
  }
  function go() {
    if (cur.q.trim()) cur.onGo(cur.q);
  }

  function drawField() {
    qEl.textContent = cur.q;
    field.classList.toggle("empty", !cur.q);
    if (cur.q.length > 20) qEl.scrollLeft = qEl.scrollWidth; // keep the end in view
  }

  function status(note, o) {
    o = o || {};
    nEl.textContent = note || "";
    nEl.classList.toggle("pending", !!o.pending);
    goKey.el.classList.toggle("off", !cur || !cur.q.trim() || o.canGo === false);
  }

  function key(e) {
    if (!cur) return false;
    const k = e.key, s = cur;
    if (k.length === 1 && /[\p{L}\p{N}\p{P}\p{S} ]/u.test(k)) {
      s.typed = true;
      type(k);
      return true;
    }
    if (k === "Backspace") {
      if (s.q) edit(s.q.slice(0, -1));
      else if (!e.repeat) s.onBack();
      return true;
    }
    if (k === "Delete" || k === "Clear") { edit(""); return true; }
    if (k === "Tab") return true;
    switch (U.nav(e)) {
      case "up": s.typed = false; move(-1, 0); break;
      case "down": s.typed = false; move(1, 0); break;
      case "left": s.typed = false; move(0, -1); break;
      case "right": s.typed = false; move(0, 1); break;
      case "ok":
        if (s.typed && k === "Enter") { if (!e.repeat) go(); } else press(s.ki, e.repeat);
        break;
      case "back": s.onBack(); break;
      default: return false;
    }
    return true;
  }

  window.Keyboard = {
    session, show, hide, key, status,
    move: (d) => cur && move(Math.sign(d), 0),
    isShowing: (s) => !!cur && (!s || cur === s),
    hint: "▲▼◀▶ Select · OK Type · Back Previous Menu",
  };
})();
