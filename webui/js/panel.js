/*
 * Pop-out options over the picture (Subtitle Options, Display Options): a
 * title strip, a list of rows, a description of the selected row and a key
 * hint. The picture keeps playing underneath.
 *
 *   Panel.open({ id, title, rows: () => [row], desc, onBack })
 *   (onBack: called after the Back key closes the panel)
 *
 *   row: { label, desc, disabled,
 *          check: bool         a choice, drawn with a radio mark
 *          value, step(d, big) a setting, drawn  label  < value >  and changed
 *                              with Left/Right (big: Shift held)
 *          act()               what OK does (default: step(1)) }
 *        { sep: true }         a divider
 *
 * rows() is called again after every change, so rows always show the
 * current state.
 */
(function () {
  "use strict";
  const { $ } = U;
  const root = $("pnl"), titleEl = $("pnl-title"), rowsEl = $("pnl-rows"), descEl = $("pnl-desc"), hintEl = $("pnl-hint");
  const ARROW_L = '<svg viewBox="0 0 10 16" data-d="-1"><path d="M9,1 L1,8 L9,15 Z"/></svg>';
  const ARROW_R = '<svg viewBox="0 0 10 16" data-d="1"><path d="M1,1 L9,8 L1,15 Z"/></svg>';
  let cur = null; // { id, title, rows, desc, sel, list }

  const usable = (r) => !!r && !r.sep && !r.disabled;

  function div(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function open(opts) {
    cur = Object.assign({ sel: -1 }, opts);
    titleEl.textContent = opts.title || "";
    root.classList.add("show");
    render();
  }

  function close() {
    if (!cur) return;
    cur = null;
    root.classList.remove("show");
  }

  /** Keep the selection on a usable row: first time, the chosen option. */
  function fixSel(list) {
    if (usable(list[cur.sel])) return;
    if (cur.sel < 0) {
      const chosen = list.findIndex((r) => r.check && usable(r));
      cur.sel = chosen >= 0 ? chosen : 0;
      if (usable(list[cur.sel])) return;
    }
    for (let k = 1; k < list.length; k++) {
      for (const i of [cur.sel + k, cur.sel - k]) {
        if (usable(list[i])) { cur.sel = i; return; }
      }
    }
  }

  function render() {
    if (!cur) return;
    const list = (cur.list = cur.rows());
    fixSel(list);
    const frag = document.createDocumentFragment();
    let selEl = null;
    list.forEach((r, i) => {
      if (r.sep) { frag.appendChild(div("pnl-sep")); return; }
      const el = div("pnl-row" + (i === cur.sel ? " sel" : "") + (r.disabled ? " disabled" : ""));
      if ("check" in r) el.appendChild(div("pnl-mark" + (r.check ? " on" : "")));
      el.appendChild(div("pnl-lbl", r.label));
      if (r.value != null) {
        const v = div("pnl-val");
        v.innerHTML = ARROW_L + "<span></span>" + ARROW_R;
        v.querySelector("span").textContent = r.value;
        v.querySelectorAll("svg").forEach((a) => a.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!usable(r)) return;
          cur.sel = i;
          step(r, +a.dataset.d, e.shiftKey);
        }));
        el.appendChild(v);
      }
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!cur || !usable(r)) return;
        cur.sel = i;
        choose(r);
      });
      if (i === cur.sel) selEl = el;
      frag.appendChild(el);
    });
    rowsEl.replaceChildren(frag);
    if (selEl) {
      const top = selEl.offsetTop - 4, bot = selEl.offsetTop + selEl.offsetHeight + 4;
      if (top < rowsEl.scrollTop) rowsEl.scrollTop = top;
      else if (bot > rowsEl.scrollTop + rowsEl.clientHeight) rowsEl.scrollTop = bot - rowsEl.clientHeight;
    }
    // the selected row's name in lime over its description, as in Settings' info panel
    const r = list[cur.sel];
    descEl.replaceChildren(div("pnl-dt", r && !r.sep ? r.label : ""), div("pnl-dd", (r && r.desc) || cur.desc || ""));
    hintEl.textContent = r && r.step ? "◀▶ Change · ▲▼ Select · Back Close" : "OK Select · ▲▼ Move · Back Close";
  }

  function step(r, d, big) {
    if (r.step) r.step(d, big);
    render();
  }
  function choose(r) {
    if (r.act) r.act();
    else if (r.step) r.step(1, false);
    render();
  }

  function move(d) {
    const list = cur.list;
    for (let i = cur.sel + d; i >= 0 && i < list.length; i += d) {
      if (usable(list[i])) { cur.sel = i; break; }
    }
    render();
  }

  /** Menu keys while open. Returns true when the panel used the key. */
  function key(e) {
    if (!cur) return false;
    const nav = U.nav(e);
    if (!nav) return false;
    const r = cur.list[cur.sel];
    if (nav === "up") move(-1);
    else if (nav === "down") move(1);
    else if (nav === "left" || nav === "right") { if (usable(r) && r.step) step(r, nav === "left" ? -1 : 1, e.shiftKey); }
    else if (nav === "ok") { if (usable(r)) choose(r); }
    else if (nav === "back") { const fn = cur.onBack; close(); if (fn) fn(); }
    return true;
  }

  root.addEventListener("click", (e) => e.stopPropagation());

  window.Panel = {
    open, close, key, move,
    refresh: render,
    isOpen: () => !!cur,
    id: () => (cur ? cur.id : null),
  };
})();
