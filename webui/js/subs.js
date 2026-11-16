/*
 * Subtitle helpers: SRT / WebVTT file parsing and safe cue rendering.
 */
(function () {
  "use strict";

  const TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/;
  function secs(s) {
    const m = TIME.exec(s);
    if (!m) return NaN;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +m[4].padEnd(3, "0") / 1000 : 0);
  }

  /** SRT or VTT text -> [{ start, end, text }] sorted by start. */
  function parse(text) {
    const cues = [];
    const blocks = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
    for (const b of blocks) {
      const lines = b.split("\n");
      const i = lines.findIndex((l) => l.includes("-->"));
      if (i < 0) continue;
      const [a, z] = lines[i].split("-->");
      const start = secs(a), end = secs(z);
      const body = lines.slice(i + 1).join("\n").trim();
      if (Number.isFinite(start) && Number.isFinite(end) && body) cues.push({ start, end, text: body });
    }
    return cues.sort((x, y) => x.start - y.start);
  }

  /** Cue text -> HTML. Keeps <i>/<b>/<u>, drops all other markup. */
  function html(text) {
    let s = String(text)
      .replace(/\{\\[^}]*\}/g, "")                      // ASS-style overrides {\an8}
      .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    s = s.replace(/&lt;(\/?)([ibu])(?:\.[^&]*)?&gt;/gi, "<$1$2>")   // <i>, </i>, <i.class>
         .replace(/&lt;(?:(?!&gt;).)*&gt;/g, "");                // <c.x>, <v Bob>, <00:01.000>, <font ...>
    return s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => `<span class="cc-line">${l}</span>`)
      .join("<br>");
  }

  window.Subs = { parse, html };
})();
