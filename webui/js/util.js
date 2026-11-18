/*
 * Shared helpers: time formatting in the guide's style ("7-7:30p"),
 * text fitting, fetching.
 */
(function () {
  "use strict";
  const MIN = 60000;
  const U = (window.U = { MIN });

  U.$ = (id) => document.getElementById(id);
  U.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /** Menu keys: arrows and WASD move, Enter is OK, Esc / Backspace go back.
   *  TV remotes: the D-pad's centre button is OK (Enter, or Select / Android
   *  keyCode 23 in some web views); the remote's Back button arrives as
   *  GoBack / BrowserBack, Android keyCode 4, webOS 461 or Tizen 10009 (or not
   *  at all: see the history guard in main.js). */
  U.nav = (e) => {
    switch (e.key) {
      case "ArrowUp": case "w": case "W": return "up";
      case "ArrowDown": case "s": case "S": return "down";
      case "ArrowLeft": case "a": case "A": return "left";
      case "ArrowRight": case "d": case "D": return "right";
      case "Enter": case "Select": return "ok";
      case "Escape": case "Backspace": case "GoBack": case "BrowserBack": case "XF86Back": return "back";
    }
    switch (e.keyCode) {
      case 23: return "ok";
      case 4: case 461: case 10009: return "back";
    }
    return null;
  };
  /** A Back button (Esc or a remote's Back), not the Backspace key. */
  U.isBack = (e) => e.key !== "Backspace" && U.nav(e) === "back";
  U.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  U.esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ------------------------------------------------------------------ time
  U.floorSlot = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0); return d.getTime(); };
  U.midnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

  const h12 = (d) => ((d.getHours() + 11) % 12) + 1;
  const ap = (d) => (d.getHours() < 12 ? "a" : "p");
  const mm = (d) => String(d.getMinutes()).padStart(2, "0");
  U.fmtClock = (t) => { const d = new Date(t); return `${h12(d)}:${mm(d)}${ap(d)}m`; };
  U.fmtSlot = (t) => { const d = new Date(t); return `${h12(d)}:${mm(d)}${ap(d)}`; };
  const fmtShort = (t) => { const d = new Date(t); return d.getMinutes() ? `${h12(d)}:${mm(d)}` : `${h12(d)}`; };
  U.fmtRange = (s, e) => {
    const a = ap(new Date(s)), b = ap(new Date(e));
    return a === b ? `${fmtShort(s)}-${fmtShort(e)}${b}` : `${fmtShort(s)}${a}-${fmtShort(e)}${b}`;
  };
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  U.dayLabel = (t) => {
    const today = U.midnight(Date.now());
    const day = U.midnight(t);
    if (day === today) return "Today";
    const d = new Date(t);
    return day - today < 6.5 * 24 * 60 * MIN ? DOW[d.getDay()] : `${d.getMonth() + 1}/${d.getDate()}`;
  };
  U.fmtDate = (t) => {
    const d = new Date(t);
    return `${DOW[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()} ${U.fmtSlot(t)}`;
  };
  /** Media position: 0:42, 12:05, 1:02:09 */
  U.fmtDur = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  };
  U.stars = (n) => (n ? "★".repeat(Math.floor(n)) + (n % 1 ? "½" : "") : "");

  // ------------------------------------------------------------------ text
  /** Shorten text word by word (adding "...") until it fits the element's box. */
  U.fitText = (el, text, oneLine) => {
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
  };

  const measureCtx = document.createElement("canvas").getContext("2d");
  U.textW = (txt, size) => {
    measureCtx.font = `400 ${size}px GuideFont`;
    return measureCtx.measureText(txt).width;
  };

  /** "BBC One HD [Geo-blocked] (1080p)" -> "BBC One" */
  U.shortName = (name) => {
    const s = String(name || "")
      .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " ")
      .replace(/\b(F?HD|UHD|SD|4K|8K|HEVC|H\.?265|1080[pi]?|720p|576[pi]?|480p|60fps|50fps)\b/gi, " ")
      .replace(/[|•]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return s || String(name || "").trim();
  };

  // ---------------------------------------------------------------- server
  /*
   * What the server this page came from offers, from its accounts service
   * (/api/me; see auth/server.mjs). Filled in by U.serverReady before boot.
   * Served without it (opened from disk, another web server), all stay off.
   *   auth   sign-in is on        user   who's signed in { username, name, admin }
   *   proxy  MediaFlow Proxy's path ("/proxy/"): streams, playlists and icons
   *          from http:// on an https:// page, and servers that block web
   *          pages (CORS). nginx adds its password.
   *   aiostreams  AIOStreams' media server ("/jellyfin"): Stremio addons and
   *          a debrid service, for On Demand (see jellyfin.js)
   */
  U.server = { known: false, auth: false, user: null, proxy: "", aiostreams: "" };
  U.serverReady = (async () => {
    try {
      const res = await fetch("/api/me", { cache: "no-store", headers: { Accept: "application/json" } });
      if (res.ok) {
        const d = await res.json();
        Object.assign(U.server, { known: true, auth: !!d.auth, user: d.user || null, proxy: d.streamProxy || "", aiostreams: d.aiostreams || "" });
      }
    } catch { /* no accounts service here */ }
    return U.server;
  })();
  /** A session that ended while the app was open (expired, or an admin signed
   *  this person out) goes back to the sign-in page, checked now and then and
   *  whenever the page comes back into view. */
  U.checkSignIn = async () => {
    if (!U.server.auth) return;
    try {
      const res = await fetch("/api/me", { cache: "no-store", headers: { Accept: "application/json" } });
      const d = res.ok ? await res.json() : null;
      if (d && d.auth && !d.user) location.assign("/auth/login?return_to=" + location.pathname + location.search);
    } catch { /* offline: try again later */ }
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) U.checkSignIn(); });
  setInterval(U.checkSignIn, 10 * 60e3);

  /** Browsers block http:// media and downloads on an https:// page. */
  U.mixed = (url) => location.protocol === "https:" && /^http:/i.test(String(url));
  /** `url` through the server's stream proxy. kind: "hls" playlists are
   *  rewritten so their segments come through it too, "dash" becomes HLS,
   *  anything else ("stream") is passed through as is. Absolute: mpegts.js
   *  fetches from a worker (a blob: URL), where a relative one doesn't resolve. */
  U.proxied = (url, kind) =>
    new URL(U.server.proxy + (kind === "hls" ? "hls/manifest.m3u8" : kind === "dash" ? "mpd/manifest.m3u8" : "stream") +
      "?d=" + encodeURIComponent(url), location.href).href;
  /** An image's address: through the proxy where the page can't load it itself. */
  U.mediaUrl = (url) => (url && U.server.proxy && U.mixed(url) ? U.proxied(url) : url);

  // ----------------------------------------------------------------- fetch
  /** Fetch text, transparently gunzipping .gz payloads. `proxy` is an optional
   *  CORS proxy prefix; "{url}" in it is replaced with the encoded URL. Without
   *  one, the server's stream proxy is used where needed: for http:// on an
   *  https:// page, and to retry a download the browser was refused (CORS). */
  U.fetchText = async (url, proxy) => {
    let target = url;
    // files on this server (the zlive guide) never need the proxy
    let local = false;
    try { local = new URL(url, location.href).origin === location.origin; } catch {}
    const ours = !local && !proxy && U.server.proxy;
    if (proxy && !local) target = proxy.includes("{url}") ? proxy.replace("{url}", encodeURIComponent(url)) : proxy + url;
    else if (ours && U.mixed(url)) target = U.proxied(url);
    let res;
    try {
      res = await fetch(target, { cache: "no-cache" });
    } catch (e) {
      if (!ours || target !== url) throw new Error("Couldn't reach the server (offline, bad URL, or blocked by CORS)");
      try {
        res = await fetch(U.proxied(url), { cache: "no-cache" });
      } catch {
        throw new Error("Couldn't reach the server, directly or through this server's proxy");
      }
    }
    if (!res.ok) throw new Error(`The server answered ${res.status} ${res.statusText || ""}`.trim());
    const buf = await res.arrayBuffer();
    const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    if (b[0] === 0x1f && b[1] === 0x8b) {
      if (!("DecompressionStream" in window)) throw new Error("This browser can't unzip .gz files");
      const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      return await new Response(ds).text();
    }
    return new TextDecoder().decode(buf);
  };

  U.readFile = (file) =>
    new Promise((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = () => fail(r.error);
      r.readAsText(file);
    });
})();
