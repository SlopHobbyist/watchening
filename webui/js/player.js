/*
 * Video playback for IPTV streams.
 *
 *   HLS (.m3u8)      hls.js (loaded on demand) or the browser's own HLS support
 *   MPEG-TS / FLV    mpegts.js (loaded on demand)
 *   MP4/WebM/MP3...  the <video> element directly
 *   unknown          tries native, then HLS, then MPEG-TS
 *
 * The two playback libraries are fetched only when a stream needs them, from
 * jsDelivr, or from js/vendor/ if that fails (drop copies there for offline use).
 *
 * Subtitles are drawn by us (into #cc), not by the browser, so one offset
 * applies to every source: HLS subtitle renditions, embedded 608/708
 * captions, native text tracks and .srt/.vtt files loaded from disk.
 */
(function () {
  "use strict";
  const { $ } = U;
  const tv = $("tv"), video = $("tv-video"), canvas = $("tv-canvas"), ccEl = $("cc");

  const LIBS = {
    Hls: ["https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js", "js/vendor/hls.min.js"],
    mpegts: ["https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js", "js/vendor/mpegts.js"],
  };
  const pending = {};
  function script(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = ok;
      s.onerror = () => { s.remove(); fail(); };
      document.head.appendChild(s);
    });
  }
  function lib(name) {
    if (window[name]) return Promise.resolve(window[name]);
    if (!pending[name]) {
      pending[name] = (async () => {
        for (const src of LIBS[name]) {
          try { await script(src); } catch { continue; }
          if (window[name]) return window[name];
        }
        delete pending[name];
        throw new Error(`Couldn't load the ${name === "Hls" ? "HLS" : "MPEG-TS"} player (are you offline?)`);
      })();
    }
    return pending[name];
  }

  const EXT = { ext: true }; // pseudo-track: subtitles loaded from a file

  const P = (window.Player = {
    ch: null,
    how: "",          // native | hls | ts | flv
    live: false,
    loading: false,
    error: "",
    autoMuted: false,
    cc: null,         // selected TextTrack, EXT, or null (off)
    ccWanted: false,  // turn captions on as soon as a track shows up
    ccDefault: false,
    ccOffset: 0,      // seconds; positive shows subtitles later
    extCues: null, extName: "",
    hls: null, ts: null, token: 0,
    reloads: 0,       // automatic reloads after stalls, this tune
  });

  const listeners = [];
  P.on = (fn) => listeners.push(fn);
  const emit = (type, data) => listeners.forEach((fn) => fn(type, data));

  // ------------------------------------------------------------ stream type
  function kind(url) {
    const s = String(url);
    const path = s.split(/[?#]/)[0].toLowerCase();
    if (/\.m3u8?$/.test(path) || /[?&](type|format|output|extension)=(m3u8|hls)\b/i.test(s)) return "hls";
    if (/\.(ts|mts|m2ts|trp)$/.test(path) || /[?&](output|extension)=(ts|mpegts)\b/i.test(s)) return "ts";
    if (/\.flv$/.test(path)) return "flv";
    if (/\.mpd$/.test(path)) return "dash";
    if (/\.(mp4|m4v|mov|webm|mkv|ogv|ogg|oga|mp3|aac|m4a|opus|wav|flac)$/.test(path)) return "file";
    return "unknown";
  }
  const CHAINS = { hls: ["hls"], ts: ["ts"], flv: ["flv"], file: ["native"], dash: [], unknown: ["native", "hls", "ts"] };

  /*
   * Pluto TV links from iptv-org playlists (https://jmp2.uk/plu-<channel id>.m3u8)
   * redirect to Pluto's stream servers, but the redirect itself has no CORS
   * header, so a web page may not follow it (VLC doesn't care). Pluto's own
   * session API does allow web pages, so ask it directly for the same stream.
   */
  function plutoClientId() {
    let id = "";
    try { id = localStorage.getItem("iptv.plutoClientId") || ""; } catch { /* */ }
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : U.uid();
      try { localStorage.setItem("iptv.plutoClientId", id); } catch { /* */ }
    }
    return id;
  }
  async function resolveUrl(url) {
    const m = /^https?:\/\/jmp2\.uk\/plu-([0-9a-f]{24})\.m3u8/i.exec(url);
    if (!m) return url;
    try {
      const q = new URLSearchParams({
        appName: "web", appVersion: "9.20.0", deviceVersion: "140.0.0", deviceModel: "web",
        deviceMake: "chrome", deviceType: "web", clientID: plutoClientId(), clientModelNumber: "1.0.0",
        channelID: m[1], serverSideAds: "false",
      });
      const res = await fetch("https://boot.pluto.tv/v4/start?" + q);
      const d = await res.json();
      const base = d.servers && d.servers.stitcher;
      if (!base || !d.sessionToken || !d.stitcherParams) return url;
      return `${base}/v2/stitch/hls/channel/${m[1]}/master.m3u8?${d.stitcherParams}` +
        `&jwt=${encodeURIComponent(d.sessionToken)}&masterJWTPassthrough=true&includeExtendedEvents=true`;
    } catch {
      return url;
    }
  }

  function mediaError() {
    const e = video.error;
    const msg = {
      1: "Playback was aborted",
      2: "A network error interrupted the stream",
      3: "The stream couldn't be decoded",
      4: "The browser can't play this stream's format",
    };
    return (e && msg[e.code]) || "Playback error";
  }
  function hlsError(d) {
    const code = d.response && d.response.code;
    if (code) return `The stream server answered ${code}`;
    if (d.details === "manifestParsingError") return "The stream's playlist is invalid";
    if (/manifest|level/i.test(d.details || "")) return "Couldn't reach the stream (offline, or blocked by CORS)";
    return `Stream error (${d.details || d.type})`;
  }

  // --------------------------------------------------------------- loading
  function play() {
    const p = video.play();
    if (p && p.catch) {
      p.catch((e) => {
        // Autoplay with sound needs a user gesture; start muted until one comes.
        if (e && e.name === "NotAllowedError" && !video.muted) {
          video.muted = true;
          P.autoMuted = true;
          emit("muted");
          video.play().catch(() => {});
        }
      });
    }
  }
  /** Call from a user gesture: lifts the autoplay mute. */
  P.unlock = () => {
    if (!P.autoMuted) return;
    P.autoMuted = false;
    video.muted = false;
    if (P.ch && !P.error) video.play().catch(() => {});
    emit("unmuted");
  };

  function teardown() {
    if (P.hls) { try { P.hls.destroy(); } catch { /* */ } P.hls = null; }
    if (P.ts) {
      const p = P.ts;
      P.ts = null;
      try { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } catch { /* */ }
    }
    if (video.hasAttribute("src")) {
      video.removeAttribute("src");
      try { video.load(); } catch { /* */ }
    }
    P.live = false;
    P.how = "";
  }

  /** One way of playing `url`; resolves once the first frame is decoded. */
  function attempt(how, url, my) {
    return new Promise((resolve, reject) => {
      const ctx = { done: false, finish };
      const timer = setTimeout(() => finish(new Error("The stream didn't respond")), 30000);
      function finish(err) {
        if (ctx.done) return;
        ctx.done = true;
        clearTimeout(timer);
        video.removeEventListener("loadeddata", onOk);
        video.removeEventListener("error", onErr);
        if (err) reject(err); else resolve();
      }
      const onOk = () => finish();
      const onErr = () => video.error && finish(new Error(mediaError()));
      video.addEventListener("loadeddata", onOk);
      video.addEventListener("error", onErr);
      P.how = how;
      start(how, url, my, ctx).catch((e) => finish(e));
    });
  }

  async function start(how, url, my, ctx) {
    if (how === "hls") {
      const native = !!video.canPlayType("application/vnd.apple.mpegurl");
      let Hls = null;
      try { Hls = await lib("Hls"); } catch (e) { if (!native) throw e; }
      if (my !== P.token) return;
      if (Hls && Hls.isSupported()) {
        const hls = (P.hls = new Hls({ liveDurationInfinity: true, enableWorker: true, renderTextTracksNatively: true }));
        hls.subtitleDisplay = false; // we render cues ourselves
        let retries = 0, audioSwitched = false;
        hls.on(Hls.Events.LEVEL_LOADED, (_, d) => { if (P.hls === hls) P.live = !!(d.details && d.details.live); });
        // Audio muxed into the main rendition that hls.js had to drop (AC-3 /
        // E-AC-3, which browsers don't decode): use an alternate audio
        // rendition instead, same language first. Without this the picture
        // never starts, since playback waits for audio that never arrives.
        hls.on(Hls.Events.BUFFER_CODECS, (_, d) => {
          if (d.audio || d.audiovideo || audioSwitched || P.hls !== hls) return;
          const tracks = hls.audioTracks || [];
          const cur = tracks[hls.audioTrack];
          if (!cur || cur.url) return;
          const alts = tracks.map((t, i) => ({ t, i })).filter((x) => x.t.url);
          const pick = alts.find((x) => x.t.lang && x.t.lang === cur.lang) || alts[0];
          if (!pick) return;
          audioSwitched = true;
          hls.audioTrack = pick.i;
        });
        hls.on(Hls.Events.FRAG_BUFFERED, () => (retries = 0));
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (!d.fatal || P.hls !== hls) return;
          const msg = hlsError(d);
          // a bad segment or key while starting is often a CDN hiccup: worth one retry
          if (!ctx.done) return ctx.finish(Object.assign(new Error(msg), { transient: /^(frag|key)/.test(d.details || "") }));
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR && retries++ < 3) hls.recoverMediaError();
          else if (d.type === Hls.ErrorTypes.NETWORK_ERROR && retries++ < 3) setTimeout(() => P.hls === hls && hls.startLoad(), 1500);
          else fail(msg);
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else {
        video.src = url;
      }
    } else if (how === "ts" || how === "flv") {
      const mpegts = await lib("mpegts");
      if (my !== P.token) return;
      if (!mpegts.isSupported()) throw new Error("This browser can't play MPEG-TS streams");
      const p = (P.ts = mpegts.createPlayer(
        { type: how === "flv" ? "flv" : "mpegts", isLive: true, url },
        { enableWorker: true, liveBufferLatencyChasing: true, lazyLoad: false },
      ));
      p.on(mpegts.Events.ERROR, (type, detail) => {
        if (P.ts !== p) return;
        const msg = `Stream error (${detail || type})`;
        if (!ctx.done) ctx.finish(new Error(msg)); else fail(msg);
      });
      p.attachMediaElement(video);
      p.load();
      P.live = true;
    } else {
      video.src = url;
    }
    play();
  }

  /** Tune `ch`. `isReload` re-opens the same channel after a stall, keeping
   *  its subtitle choice and offset. */
  P.load = async (ch, isReload) => {
    const my = ++P.token;
    teardown();
    if (!isReload) { P.reloads = 0; resetCC(); }
    P.ch = ch;
    P.error = "";
    tv.classList.remove("nosignal");
    if (!ch) {
      P.loading = false;
      drawCard(null);
      tv.classList.add("nosignal");
      emit("state");
      return;
    }
    P.loading = true;
    emit("state");
    const url = await resolveUrl(ch.url);
    if (my !== P.token) return;
    const k = kind(url);
    let chain = CHAINS[k];
    // The <video> element isn't subject to CORS, so where the browser plays HLS
    // itself it rescues streams hls.js can't fetch: servers without CORS
    // headers, or that redirect without them (jmp2.uk, many ad-stitched feeds).
    if (k === "hls" && video.canPlayType("application/vnd.apple.mpegurl")) chain = ["hls", "native"];
    const errs = [];
    let retried = false;
    for (let i = 0; i < chain.length; i++) {
      const how = chain[i];
      const t0 = Date.now();
      try {
        await attempt(how, url, my);
        if (my === P.token) { P.loading = false; emit("state"); }
        return;
      } catch (e) {
        if (my !== P.token) return;
        errs.push({ how, msg: (e && e.message) || "" });
        teardown();
        if (e && e.transient && !retried) { retried = true; i--; continue; }
        // a server that never answered won't answer the next engine either
        if (Date.now() - t0 > 15000) {
          errs.unshift({ how, msg: "The stream's server isn't answering (it may be down, or blocked on your network)" });
          break;
        }
      }
    }
    if (my !== P.token) return;
    // native playback only ever says "can't play this format"; the
    // libraries' reasons are more useful
    const best = errs.find((e) => e.how !== "native" && e.msg) || errs.find((e) => e.msg);
    let err = k === "dash" ? "MPEG-DASH (.mpd) streams aren't supported" : best ? best.msg : "This stream can't be played";
    if (location.protocol === "https:" && /^http:/i.test(ch.url)) {
      err = "This channel uses http:// and the viewer was opened over https://, which browsers block. Open the viewer over http:// instead.";
    }
    fail(err);
  };
  P.retry = () => P.ch && P.load(P.ch);
  P.stop = () => P.load(null);

  function fail(msg) {
    teardown();
    P.loading = false;
    P.error = msg;
    drawCard(P.ch);
    tv.classList.add("nosignal");
    emit("error", msg);
    emit("state");
  }

  /*
   * Gap jumping. Live streams often begin with the first decodable frame a
   * moment after the playhead (audio starting before video, or a stream that
   * starts mid-GOP), or have small holes later. VLC plays straight through;
   * the browser waits forever. If we're stuck just before buffered data, skip
   * to it. Likewise, the browser's own HLS player sometimes sits frozen on
   * frames it has already buffered; a tiny seek gets it going.
   */
  let stuckSince = 0, frozenSince = 0, lastT = -1, stallT = -1, stallSince = 0;
  setInterval(() => {
    // (a seek into the hole stays "seeking" forever, so that doesn't exempt us)
    if (!P.ch || P.error || P.loading || video.paused) {
      stuckSince = frozenSince = stallSince = 0;
      lastT = stallT = -1;
      return;
    }
    const t = video.currentTime, b = video.buffered;

    // Last resort, as VLC does: a picture that hasn't moved in 10s gets the
    // stream reloaded (twice at most per tune).
    if (t !== stallT) { stallT = t; stallSince = Date.now(); }
    else if (Date.now() - stallSince > 10000 && P.reloads < 2) {
      P.reloads++;
      stallSince = Date.now();
      P.load(P.ch, true);
      return;
    }

    if (t !== lastT) { lastT = t; frozenSince = 0; } else if (!frozenSince) frozenSince = Date.now();
    let next = null;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.05 && t < b.end(i) - 0.2) {
        // playable data under the playhead: fine, unless the clock is frozen
        stuckSince = 0;
        if (frozenSince && Date.now() - frozenSince > 3000 && video.readyState >= 3 && !video.seeking) {
          frozenSince = 0;
          video.currentTime = t + 0.1;
        }
        return;
      }
      if (next == null && b.start(i) > t && b.start(i) - t < 10) next = b.start(i);
    }
    if (next == null || video.readyState >= 3) { stuckSince = 0; return; }
    if (!stuckSince) { stuckSince = Date.now(); return; }
    if (Date.now() - stuckSince > 800) {
      stuckSince = 0;
      video.currentTime = next + 0.1;
    }
  }, 400);

  // errors after a native stream started (hls.js / mpegts.js report their own)
  video.addEventListener("error", () => {
    if (P.how === "native" && !P.loading && P.ch && !P.error && video.error) fail(mediaError());
  });
  for (const ev of ["play", "pause", "playing", "waiting", "seeked", "ended"]) video.addEventListener(ev, () => emit("state"));

  /** SMPTE color bars with the channel name: shown for "no signal". */
  function drawCard(ch) {
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
    g.fillStyle = "rgba(0,0,0,.72)";
    g.fillRect(W * 0.2, H * 0.24, W * 0.6, H * 0.22);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    let name = ch ? ch.call : "NO CHANNEL";
    let size = Math.round(H * 0.09);
    g.font = `bold ${size}px Arial, sans-serif`;
    while (size > 10 && g.measureText(name).width > W * 0.56) { size--; g.font = `bold ${size}px Arial, sans-serif`; }
    g.fillText(name, W / 2, H * 0.31);
    g.font = `bold ${Math.round(H * 0.055)}px Arial, sans-serif`;
    g.fillText(ch ? "NO SIGNAL" : "ADD A PLAYLIST IN SETTINGS", W / 2, H * 0.4);
  }
  P.drawCard = drawCard;

  // -------------------------------------------------------------- transport
  /** Seekable span, or null for live streams we can't move around in. */
  P.range = () => {
    if (!P.ch || P.error || P.loading) return null;
    const d = video.duration;
    const s = video.seekable;
    // files served without HTTP range support report a duration but can't seek
    if (!P.live && Number.isFinite(d) && d > 0) return s.length && s.end(s.length - 1) > 1 ? { vod: true, start: 0, end: d } : null;
    if (P.how === "ts" || P.how === "flv") return null;
    if (s.length) {
      const st = s.start(0), en = s.end(s.length - 1);
      if (en - st >= 60) return { vod: false, start: st, end: en };
    }
    return null;
  };
  P.time = () => video.currentTime;
  P.paused = () => video.paused;
  P.canPause = () => !!(P.ch && !P.error && !P.loading);
  P.togglePause = () => {
    if (!P.canPause()) return null;
    if (video.paused) { play(); return "play"; }
    video.pause();
    return "pause";
  };
  P.skip = (sec) => {
    const r = P.range();
    if (!r) return false;
    const max = r.vod ? r.end - 0.25 : r.end - 2;
    video.currentTime = U.clamp(video.currentTime + sec, r.start, max);
    return true;
  };
  P.seekFrac = (f) => {
    const r = P.range();
    if (!r) return false;
    video.currentTime = U.clamp(r.start + f * (r.end - r.start), r.start, r.vod ? r.end - 0.25 : r.end - 2);
    return true;
  };
  P.toggleMute = () => {
    P.autoMuted = false;
    video.muted = !video.muted;
    return video.muted;
  };

  // -------------------------------------------------------------- subtitles
  const langNames = (() => { try { return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }); } catch { return null; } })();
  function trackLabel(t) {
    if (t.label) return t.label;
    if (t.language && langNames) { try { return langNames.of(t.language); } catch { /* bad code */ } }
    return t.kind === "captions" ? "Captions" : "Subtitles";
  }
  const textTracks = () => Array.from(video.textTracks).filter((t) => t.kind === "subtitles" || t.kind === "captions");

  P.ccTracks = () => {
    const list = textTracks().map((t) => ({ t, label: trackLabel(t) }));
    if (P.extCues) list.push({ t: EXT, label: P.extName || "Subtitle file" });
    return list;
  };
  P.ccLabel = () => {
    const x = P.ccTracks().find((x) => x.t === P.cc);
    return x ? x.label : "";
  };

  // Our pick is "hidden" (cues load, the browser draws nothing); all else off.
  function applyModes() {
    for (const t of textTracks()) {
      const want = t === P.cc ? "hidden" : "disabled";
      if (t.mode !== want) t.mode = want;
    }
  }
  function setCC(t) {
    P.cc = t;
    applyModes();
    lastHtml = null;
    kickCC();
    emit("cc");
  }
  function resetCC() {
    P.extCues = null;
    P.extName = "";
    P.ccOffset = 0;
    P.ccWanted = P.ccDefault;
    setCC(null);
  }

  video.textTracks.addEventListener("addtrack", () => {
    if (!P.cc && P.ccWanted) {
      const first = textTracks()[0];
      if (first) { setCC(first); return; }
    }
    applyModes();
    emit("tracks");
  });
  video.textTracks.addEventListener("removetrack", () => {
    if (P.cc && P.cc !== EXT && !textTracks().includes(P.cc)) setCC(null);
  });
  video.textTracks.addEventListener("change", applyModes);

  /** Off -> track 1 -> track 2 -> ... -> Off. Returns the new label, or null if none exist. */
  P.cycleCC = () => {
    const list = P.ccTracks();
    if (!list.length) return null;
    const i = list.findIndex((x) => x.t === P.cc);
    const next = i + 1 < list.length ? list[i + 1] : null;
    P.ccWanted = !!next;
    setCC(next ? next.t : null);
    return next ? next.label : "Off";
  };
  P.nudgeOffset = (d) => {
    P.ccOffset = d === 0 ? 0 : Math.round((P.ccOffset + d) * 10) / 10;
    kickCC();
    return P.ccOffset;
  };
  P.loadSubs = (name, text) => {
    const cues = Subs.parse(text);
    if (!cues.length) throw new Error("No subtitles were found in that file");
    P.extCues = cues;
    P.extName = name.replace(/\.(srt|vtt)$/i, "");
    P.ccWanted = true;
    setCC(EXT);
    return cues.length;
  };
  P.setCCSize = (n) => {
    tv.classList.remove("cc-s0", "cc-s1", "cc-s2");
    tv.classList.add("cc-s" + U.clamp(n | 0, 0, 2));
  };

  let raf = 0, lastHtml = "";
  function renderCC() {
    raf = 0;
    let html = "";
    if (P.cc) {
      const t = video.currentTime - P.ccOffset;
      const out = [];
      if (P.cc === EXT) {
        for (const c of P.extCues) { if (c.start > t) break; if (t < c.end) out.push(c.text); }
      } else if (P.cc.cues) {
        const cues = P.cc.cues;
        for (let i = 0; i < cues.length; i++) {
          const c = cues[i];
          if (c.startTime <= t && t < c.endTime && c.text) out.push(c.text);
        }
      }
      html = out.map(Subs.html).filter(Boolean).join("<br>");
      raf = requestAnimationFrame(renderCC);
    }
    if (html !== lastHtml) {
      ccEl.innerHTML = html;
      lastHtml = html;
    }
  }
  function kickCC() { if (!raf) raf = requestAnimationFrame(renderCC); }
})();
