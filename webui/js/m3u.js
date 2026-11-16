/*
 * M3U / M3U8 channel-list parser.
 *
 *   #EXTM3U url-tvg="http://epg.example/guide.xml.gz"
 *   #EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://..." group-title="UK",BBC One HD
 *   http://example.com/bbc1.m3u8
 *
 * Also accepts a bare list of URLs, one per line. A file that is itself an HLS
 * stream manifest (has #EXT-X-* tags) is reported with `isStream: true`.
 */
(function () {
  "use strict";

  /** Split "-1 a="x,y" b=z,Title" at the first comma outside quotes. */
  function splitInf(s) {
    let q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') q = !q;
      else if (c === "," && !q) return [s.slice(0, i), s.slice(i + 1)];
    }
    return [s, ""];
  }

  function attrs(s) {
    const out = {};
    const re = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
    let m;
    while ((m = re.exec(s))) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    return out;
  }

  function resolve(url, base) {
    try { return base ? new URL(url, base).href : new URL(url).href; } catch { return url; }
  }

  function nameFromUrl(url) {
    try {
      const u = new URL(url);
      const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
      return decodeURIComponent(last).replace(/\.[a-z0-9]{2,5}$/i, "") || u.hostname;
    } catch { return "Channel"; }
  }

  function parse(text, baseUrl) {
    text = String(text || "").replace(/^﻿/, "");
    const res = { channels: [], epg: [], isStream: false };
    if (/^#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|INDEPENDENT-SEGMENTS)/m.test(text)) {
      res.isStream = true;
      return res;
    }
    let cur = null, pendingGroup = "";
    for (const raw of text.split(/\r\n|\r|\n/)) {
      const line = raw.trim();
      if (!line) continue;

      if (/^#EXTM3U/i.test(line)) {
        const a = attrs(line.slice(7));
        const e = a["url-tvg"] || a["x-tvg-url"] || a["tvg-url"];
        if (e) for (const u of e.split(",")) if (u.trim()) res.epg.push(resolve(u.trim(), baseUrl));
        continue;
      }
      if (/^#EXTINF:/i.test(line)) {
        const [a, title] = splitInf(line.slice(8));
        const at = attrs(a);
        cur = {
          name: title.trim() || at["tvg-name"] || "",
          tvgId: at["tvg-id"] || "",
          tvgName: at["tvg-name"] || "",
          logo: at["tvg-logo"] || at.logo || "",
          group: at["group-title"] || pendingGroup,
        };
        pendingGroup = "";
        continue;
      }
      if (/^#EXTGRP:/i.test(line)) {
        const g = line.slice(8).trim();
        if (cur) cur.group = cur.group || g; else pendingGroup = g;
        continue;
      }
      if (line[0] === "#") continue; // #EXTVLCOPT, #KODIPROP, comments ...

      const ch = cur || { name: "", tvgId: "", tvgName: "", logo: "", group: pendingGroup };
      ch.url = resolve(line, baseUrl);
      if (!ch.name) ch.name = nameFromUrl(ch.url);
      if (ch.logo) ch.logo = resolve(ch.logo, baseUrl);
      res.channels.push(ch);
      cur = null;
      pendingGroup = "";
    }
    return res;
  }

  window.M3U = { parse };
})();
