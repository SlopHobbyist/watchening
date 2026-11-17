/*
 * Modal pop-up in the guide's style: a title strip, optional message, text
 * fields and a vertical list of choices (highlighted like a selected listing).
 *
 *   Dialog.open({ title, text, big, fields: [{ id, label, value, placeholder }],
 *                 buttons: [{ label, act(values) }], onCancel })
 *   (big: a line of large text under the message, such as a code to type in;
 *    Dialog.big() changes it while open)
 *
 * A button's act() may return false (or a promise of false) to keep the
 * dialog open, e.g. after Dialog.message("That URL didn't work", true).
 */
(function () {
  "use strict";
  const { $ } = U;
  const root = $("dlg"), titleEl = $("dlg-title"), textEl = $("dlg-text"), bigEl = $("dlg-big"), itemsEl = $("dlg-items");
  let cur = null;

  function open(opts) {
    if (cur) close();
    cur = { opts, items: [], sel: 0, busy: false };
    const c = cur;
    titleEl.textContent = opts.title || "";
    message(opts.text || "");
    big(opts.big || "");
    itemsEl.replaceChildren();

    for (const f of opts.fields || []) {
      const wrap = document.createElement("div");
      wrap.className = "dlg-field";
      const lab = document.createElement("div");
      lab.className = "dlg-label";
      lab.textContent = f.label || "";
      const inp = document.createElement("input");
      Object.assign(inp, { type: "text", value: f.value || "", placeholder: f.placeholder || "", spellcheck: false, autocomplete: "off" });
      wrap.append(lab, inp);
      itemsEl.appendChild(wrap);
      const item = { kind: "field", el: wrap, input: inp, id: f.id };
      inp.addEventListener("focus", () => cur === c && select(c.items.indexOf(item)));
      wrap.addEventListener("click", () => inp.focus());
      c.items.push(item);
    }
    for (const b of opts.buttons || []) {
      const el = document.createElement("div");
      el.className = "dlg-btn" + (b.disabled ? " disabled" : "");
      el.textContent = b.label;
      const item = { kind: "button", el, b };
      el.addEventListener("click", () => {
        if (cur !== c || b.disabled) return;
        select(c.items.indexOf(item));
        activate();
      });
      itemsEl.appendChild(el);
      c.items.push(item);
    }
    root.classList.add("show");
    let first = c.items.findIndex((it) => !(it.b && it.b.disabled));
    if (typeof opts.sel === "number") first = opts.sel;
    select(Math.max(0, first));
  }

  function select(i) {
    if (!cur || !cur.items.length) return;
    cur.sel = U.clamp(i, 0, cur.items.length - 1);
    cur.items.forEach((it, k) => it.el.classList.toggle("sel", k === cur.sel));
    const it = cur.items[cur.sel];
    if (it.kind === "field") {
      if (document.activeElement !== it.input) it.input.focus();
    } else if (document.activeElement && document.activeElement.tagName === "INPUT") {
      document.activeElement.blur();
    }
  }

  function move(d) {
    const n = cur.items.length;
    let i = cur.sel;
    for (let k = 0; k < n; k++) {
      i = (i + d + n) % n;
      const it = cur.items[i];
      if (!(it.b && it.b.disabled)) break;
    }
    select(i);
  }

  function values() {
    const v = {};
    for (const it of cur.items) if (it.kind === "field") v[it.id] = it.input.value.trim();
    return v;
  }

  async function activate() {
    if (!cur || cur.busy) return;
    const it = cur.items[cur.sel];
    if (!it) return;
    if (it.kind === "field") return move(1);
    if (it.b.disabled) return;
    const c = cur;
    let r;
    if (it.b.act) {
      c.busy = true;
      root.classList.add("busy");
      try { r = await it.b.act(values()); }
      catch (e) { message(e.message || String(e), true); r = false; }
      finally { c.busy = false; root.classList.remove("busy"); }
    }
    if (r !== false && cur === c) close();   // act() may have opened another dialog
  }

  function cancel() {
    if (!cur || cur.busy) return;
    const fn = cur.opts.onCancel;
    close();
    if (fn) fn();
  }

  function close() {
    if (!cur) return;
    root.classList.remove("show");
    if (document.activeElement && document.activeElement.tagName === "INPUT") document.activeElement.blur();
    cur = null;
  }

  function message(text, isError) {
    textEl.textContent = text || "";
    textEl.style.display = text ? "" : "none";
    textEl.classList.toggle("err", !!isError);
  }

  function big(text) {
    bigEl.textContent = text || "";
    bigEl.classList.toggle("show", !!text);
  }

  /** Keyboard input while open. Returns true when the dialog consumed it. */
  function key(e) {
    if (!cur) return false;
    const k = e.key;
    const it = cur.items[cur.sel];
    const typing = !!it && it.kind === "field";   // letters, Backspace and ◀▶ go to the text box
    const n = U.nav(e);
    const nav = typing ? null : n;
    if (k === "Escape" || nav === "back" || U.isBack(e)) cancel();
    else if (n === "ok") activate();
    else if (k === "ArrowDown" || nav === "down" || (k === "Tab" && !e.shiftKey)) move(1);
    else if (k === "ArrowUp" || nav === "up" || (k === "Tab" && e.shiftKey)) move(-1);
    else if (typing) return true;
    e.preventDefault();
    return true;
  }

  function confirm(title, text, okLabel, act) {
    open({ title, text, buttons: [{ label: okLabel, act }, { label: "Cancel" }], sel: 1 });
  }

  // click on the dimmed backdrop cancels
  root.addEventListener("click", (e) => { if (e.target === root) cancel(); });

  window.Dialog = {
    open, close, key, message, big, confirm,
    isOpen: () => !!cur,
    /** Whether the dialog opened with these options is still the one showing. */
    is: (opts) => !!cur && cur.opts === opts,
  };
})();
