/*
 * Voice search: records what's said into the microphone and has this
 * server's speech service (whisper.cpp with FUTO's voice input models, see
 * speech/start.sh) turn it into text. Used by the on-screen keyboard's Voice
 * key (keyboard.js).
 *
 * Recording starts when asked and ends by itself a moment after the talking
 * stops (or after 10 seconds, or when stop() is called). Only the part with
 * talking in it is sent, as 16 kHz mono WAV, and nothing at all if nobody
 * spoke, so the model isn't asked to make words out of silence. The
 * microphone is let go as soon as the recording ends.
 *
 * Encrypted: recordings are only sent over https://. The one exception is
 * a page opened as http://localhost (or 127.0.0.1) on the server itself,
 * where the recording never leaves the machine. Browsers don't allow the
 * microphone on other http:// pages anyway, but this doesn't rely on that.
 *
 *   Voice.available          a microphone can be used here, encrypted
 *   Voice.listen({ hint, onLevel(0..1), onState("listening" | "working") })
 *                            -> Promise of the words ("" if none were heard).
 *                            hint: names likely to be said (channels, titles),
 *                            which help with spelling them.
 *                            Fails with an Error whose .code is "blocked"
 *                            (microphone not allowed), "nomic", "busy" (in
 *                            use elsewhere), "signin", "server" or "cancel".
 *   Voice.stop()             done talking: send what's been said
 *   Voice.cancel()           drop it (listen fails with "cancel")
 *   Voice.hint(names)        names -> a hint short enough for the model
 */
(function () {
  "use strict";
  const RATE = 16000;        // what the model hears
  const FRAME_S = 0.02;      // talking is detected in 20 ms frames
  const MAX_S = 10;          // longest recording
  const WAIT_S = 6;          // give up if nobody starts talking by then
  const QUIET_S = 0.9;       // this much quiet after talking ends it
  const PRE = 15, POST = 15;  // frames kept before and after the talking (0.3 s)
  const HINT_MAX = 600;      // characters (the model takes about 220 tokens)

  const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
  const encrypted = location.protocol === "https:" ||
    (location.protocol === "http:" && LOOPBACK.test(location.hostname));
  const AC = window.AudioContext || window.webkitAudioContext;
  const available = encrypted && !!AC && typeof AudioWorkletNode !== "undefined" &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  // Hands the microphone's samples to the page in blocks of 2048.
  const TAP = `registerProcessor("voice-tap", class extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(2048); this.n = 0; }
      }
      return true;
    }
  });`;
  let tapUrl = "";

  const fail = (code, msg) => Object.assign(new Error(msg || code), { code });

  let run = null; // the recording or request under way

  function listen(o) {
    o = o || {};
    if (run) cancel();
    if (!available) return Promise.reject(fail("server", encrypted ? "No microphone support" : "Needs https://"));
    const r = (run = { stopped: false, cancelled: false, ctrl: new AbortController() });
    return record(r, o).then(
      (pcm) => (r.cancelled ? Promise.reject(fail("cancel")) : pcm ? transcribe(r, pcm, o) : ""),
    ).finally(() => { if (run === r) run = null; });
  }

  function stop() { if (run) { run.stopped = true; if (run.finish) run.finish(); } }
  function cancel() {
    if (!run) return;
    run.cancelled = true;
    run.ctrl.abort();
    if (run.finish) run.finish();
    run = null;
  }

  // ------------------------------------------------------------- recording
  /** Records until the talking stops: the talking, at 16 kHz, or null if none. */
  async function record(r, o) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const n = e && e.name;
      throw fail(n === "NotAllowedError" || n === "SecurityError" ? "blocked"
        : n === "NotFoundError" || n === "OverconstrainedError" ? "nomic" : "busy", e && e.message);
    }
    const ctx = new AC();
    const release = () => {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    };
    if (r.cancelled) { release(); return null; }
    try {
      if (!tapUrl) tapUrl = URL.createObjectURL(new Blob([TAP], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(tapUrl);
      await ctx.resume();
    } catch (e) {
      release();
      throw fail("nomic", e && e.message);
    }
    const rate = ctx.sampleRate, frame = Math.round(rate * FRAME_S);
    const src = ctx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(ctx, "voice-tap");
    src.connect(tap);

    const chunks = [];          // everything heard, at the microphone's rate
    let total = 0;              // samples in chunks
    let acc = 0, accN = 0;      // the frame being measured
    let frames = 0, floor = -1; // frames measured; the room's quiet level
    const recent = [];          // last 10 frames: talking or not
    let first = -1, last = -1;  // first and last frame with talking

    if (o.onState) o.onState("listening");
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => finish(), (MAX_S + 1) * 1000); // if the microphone goes quiet altogether
      const finish = (r.finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        tap.port.onmessage = null;
        src.disconnect();
        release();
        if (r.cancelled || first < 0) return resolve(null);
        const a = Math.max(0, (first - PRE) * frame);
        const b = Math.min(total, (last + 1 + POST) * frame);
        resolve(resample(join(chunks, total), rate, a, b));
      });
      tap.port.onmessage = (ev) => {
        const buf = ev.data;
        chunks.push(buf);
        total += buf.length;
        for (let i = 0; i < buf.length; i++) {
          acc += buf[i] * buf[i];
          if (++accN < frame) continue;
          const rms = Math.sqrt(acc / accN);
          acc = accN = 0;
          // the quiet level: follows the room down at once, up slowly
          floor = floor < 0 || rms < floor ? rms : floor + (rms - floor) * 0.01;
          const talk = rms > Math.max(0.012, floor * 3);
          recent.push(talk);
          if (recent.length > 10) recent.shift();
          if (talk && (first >= 0 || recent.filter(Boolean).length >= 4)) {
            if (first < 0) first = frames - recent.filter(Boolean).length;
            last = frames;
          }
          frames++;
          if (o.onLevel) o.onLevel(Math.min(1, Math.sqrt(rms / 0.2)));
        }
        const s = frames * FRAME_S;
        if (r.stopped || s >= MAX_S || (first < 0 && s >= WAIT_S) ||
            (first >= 0 && (frames - 1 - last) * FRAME_S >= QUIET_S)) finish();
      };
    });
  }

  function join(chunks, n) {
    const out = new Float32Array(n);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
  /** x[a..b) at `rate` -> 16 kHz, averaging (a plain low-pass for speech). */
  function resample(x, rate, a, b) {
    const step = rate / RATE, n = Math.floor((b - a) / step);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = a + i * step, e = Math.min(b, s + step);
      let sum = 0, k = 0;
      for (let j = Math.floor(s); j < e; j++, k++) sum += x[j];
      out[i] = k ? sum / k : 0;
    }
    return out;
  }
  function wav(pcm) {
    const v = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const str = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVEfmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([v.buffer], { type: "audio/wav" });
  }

  // ---------------------------------------------------------- the server
  async function transcribe(r, pcm, o) {
    if (o.onState) o.onState("working");
    const secs = pcm.length / RATE;
    const fd = new FormData();
    fd.append("file", wav(pcm), "voice.wav");
    fd.append("response_format", "json");
    // FUTO's models only need as much audio context as the clip is long
    // (50 per second, and a little to spare): much faster than Whisper's 30 s.
    fd.append("audio_ctx", String(Math.min(1500, Math.ceil(secs * 50) + 64)));
    if (o.hint) fd.append("prompt", o.hint);
    let res;
    try {
      res = await fetch("/stt", { method: "POST", body: fd, signal: r.ctrl.signal, cache: "no-store" });
    } catch (e) {
      throw fail(r.cancelled ? "cancel" : "server", e && e.message);
    }
    if (r.cancelled) throw fail("cancel");
    if (res.status === 401) throw fail("signin");
    let j = null;
    try { j = await res.json(); } catch (e) { /* not JSON: nginx's error page */ }
    if (!res.ok || !j || typeof j.text !== "string") throw fail("server", (j && j.error) || `HTTP ${res.status}`);
    return clean(j.text);
  }

  /** The words, as a search: no sound labels, no full stop at the end. */
  function clean(t) {
    t = t.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪/g, " ").replace(/\s+/g, " ").trim()
      .replace(/^["'“]+|["'”]+$/g, "").replace(/[.!?,;:…]+$/u, "").trim();
    // what Whisper says when it hears no words
    if (/^(thank you|thanks for watching|thank you for watching)$/i.test(t)) return "";
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /** Names -> a hint: each once, as many as fit. */
  function hint(names) {
    const seen = new Set();
    let out = "";
    for (const raw of names) {
      const s = String(raw || "").replace(/\s+/g, " ").trim();
      const k = s.toLowerCase();
      if (!s || seen.has(k)) continue;
      if (out.length + s.length + 2 > HINT_MAX) break;
      seen.add(k);
      out += (out ? ", " : "") + s;
    }
    return out;
  }

  window.Voice = { available, listen, stop, cancel, hint };
})();
