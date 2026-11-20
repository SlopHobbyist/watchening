/*
 * Channels of our own, for the accounts service (server.mjs): one show from a
 * media server (Plex or Jellyfin), some or all of its seasons, or a YouTube
 * channel's uploads or a playlist, playing around the clock, in order or
 * shuffled. Everyone sees the same schedule, so people watching on different
 * TVs are watching the same episode at the same moment.
 *
 * The TV that makes a Plex or Jellyfin channel sends its episodes (ids,
 * running times, titles, and where the intro and end credits are, when the
 * channel skips them): the server never talks to the media server itself.
 * Each TV plays the episode through its own On Demand connection to that
 * server (see webui/js/channels.js). YouTube is the other way round: the
 * server reads the list from YouTube, and the TVs play each video in
 * YouTube's own player (see "YouTube" below).
 *
 * The schedule is worked out, not stored: an anchor says which episode of the
 * channel's endless run starts when ({ t, pos }), and from there each
 * episode follows the last. pos counts episodes from the channel's start: in
 * order, it's episode pos mod n; shuffled, each pass through the episodes is
 * its own shuffle (made from the channel's seed and the pass's number), so
 * nothing repeats until everything has played. Before the anchor, `lead`
 * lists episodes played outside the run: the one on when the episodes or
 * order last changed (playing to its end before the new run starts), the
 * ones a vote put on (below), and the last few hours before a vote, so the
 * guide's past stays as it was. Each says what came before it (`back`, most
 * recent first), for Previous; one can start partway in (`off`, seconds), or
 * be the picture held still (`pause`). An episode played early that way is
 * left out when the shuffle comes to it later in that pass (`omit`:
 * positions in the run).
 *
 * Times within an episode are the channel's: with Skip Intros on, the intro
 * isn't counted, and with Skip Credits on, the episode ends where its end
 * credits start; a YouTube video's sponsors and the like (`cut`) are never
 * counted (TVs jump over what's left out as they play).
 *
 * Watching: the TVs tuned to a channel say so every few seconds. A TV can ask
 * to start the episode over, go back to the previous one (then this one again
 * from the start), skip it, play the show's next episode after it even when
 * shuffled (for two-parters; the shuffle then carries on where it was), go to
 * another point in it (seek), or pause it for a few minutes. Alone on the
 * channel, that happens at once; with others watching, it waits for more
 * than half of the TVs to agree, or for the others to leave. A vote lapses
 * after a few minutes, or when the episode changes. Seeking and pausing have
 * a value (where to, how long): asking for a different one starts the vote
 * again. A pause ends by itself; the person who asked for it can end it
 * early, anyone else by a vote to resume.
 *
 * Kept in /data/settings/channels.json:
 *   { rev, channels: [{ id, name, src: { type, server, name }, show: { id, title },
 *     seasons: [first, last] | [first, null] (to the latest) | null (all), order: "order" | "shuffle", seed,
 *     skip: { intro, credits },
 *     eps: [{ id, title, season, episode, dur (s), desc, rating, aired,
 *             intro: [start, end] | null, credits: start | null, mk (markers looked for),
 *             cut: [[start, end]] (YouTube: always left out; none: no key) }],
 *     anchor: { t, pos }, lead: [{ i, t, pos, back: [i], off, pause: { by, name } }], omit: [pos],
 *     created, by, yt (YouTube channels: see below) }] }
 * (lead was one { i, t } or null once: load() brings those up to date.)
 * rev goes up with every change to a channel or its schedule, so TVs know to
 * ask again. Who's watching and the votes are only in memory.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as YT from "./youtube.mjs";

const { merge } = YT;

const DIR = process.env.SETTINGS_DIR || "/data/settings";
const FILE = path.join(DIR, "channels.json");
const SEEN_FOR = 20e3;          // a TV that hasn't said it's watching for this long has gone (they say so every 6s)
const VOTE_FOR = 3 * 60e3;      // how long a vote stands
const DONE_FOR = 60e3;          // how long "skipped by vote" is told to TVs
const SLOT = 30 * 60e3;
const KEEP = 3 * 3600e3;        // a vote keeps this much of the schedule's past (the guide shows 3 hours back)
const BACK = 8;                 // how far back Previous can go
const PAUSE_MAX = 5;            // minutes
const ACTIONS = ["restart", "prev", "skip", "next", "seek", "pause", "resume"];
const MAX_CHANNELS = 200, MAX_EPS = 5000, MAX_WINDOW = 12 * 24 * 3600e3, MAX_ENTRIES = 4000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

export class ChannelError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ------------------------------------------------------------------ storage
let doc = null;
function load() {
  if (doc) return doc;
  try {
    doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") log(`couldn't read ${FILE}: ${e.message}`);
    doc = null;
  }
  if (!doc || !Array.isArray(doc.channels)) doc = { rev: 0, channels: [] };
  for (const ch of doc.channels) {
    const L = ch.lead;
    if (!Array.isArray(L)) ch.lead = L && typeof L === "object" ? [{ i: L.i, t: L.t, pos: ch.anchor.pos - 1, back: [] }] : [];
    if (!Array.isArray(ch.omit)) ch.omit = [];
    if (!ch.skip) ch.skip = { intro: false, credits: false };
    if (ch.yt && !Array.isArray(ch.yt.bad)) ch.yt.bad = [];
  }
  return doc;
}
function save() {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, FILE);
}
function changed() {
  doc.rev++;
  save();
}
const find = (id) => load().channels.find((c) => c.id === id) || null;
function must(id) {
  const ch = find(id);
  if (!ch) throw new ChannelError(404, "That channel isn't on the server any more");
  return ch;
}

// ---------------------------------------------------------------- the order
/** A small seeded random number generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => crypto.createHash("sha256").update(s).digest().readUInt32LE(0);

/** Pass `cycle` through a shuffled channel's episodes: their indexes, in play order. */
const passes = new Map(); // `${id}|${seed}|${n}|${cycle}` -> order (a few kept)
function rawPass(ch, cycle) {
  const n = ch.eps.length;
  const key = `${ch.id}|${ch.seed}|${n}|${cycle}`;
  let a = passes.get(key);
  if (a) return a;
  a = Array.from({ length: n }, (_, i) => i);
  const r = rng(hash(`${ch.seed}:${cycle}`));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  if (passes.size > 256) passes.clear();
  passes.set(key, a);
  return a;
}
/** The episode (index into ch.eps) at position `pos` of the channel's run. */
function epAt(ch, pos) {
  const n = ch.eps.length;
  const k = ((pos % n) + n) % n;
  if (ch.order !== "shuffle" || n < 2) return k;
  const cycle = Math.floor(pos / n);
  const a = rawPass(ch, cycle);
  // a pass doesn't start with the episode the last one ended on (swapping
  // its first two leaves its last where it was, so this only looks back once)
  if (n > 2 && a[0] === rawPass(ch, cycle - 1)[n - 1] && (k === 0 || k === 1)) return a[1 - k];
  return a[k];
}

/**
 * What the channel plays of episode i (seconds): the parts it leaves out
 * (`gaps`, in order: the intro with Skip Intros on, and a YouTube video's
 * sponsors and the like, `cut`), and where it stops (the end credits with
 * Skip Credits on, else the end; a gap that runs to the end ends it there).
 *
 * A YouTube video also has a few seconds before it (`lead`, yt.lead), while
 * the TVs start YouTube's player for it, so it plays from the very start
 * (and the one before it can play to its very end).
 * webui/js/channels.js does the same sums.
 */
function cuts(ch, i) {
  const e = ch.eps[i], s = ch.skip || {};
  const lead = (ch.yt && ch.yt.lead) || 0;
  const brk = (ch.yt && ch.yt.brk) || 0; // (a channel from before lead-ins, only as init() moves it on)
  let end = s.credits && e.credits ? e.credits : e.dur;
  const spans = (e.cut || []).slice();
  if (s.intro && e.intro) spans.push(e.intro);
  const gaps = [];
  for (const [a, b] of merge(spans)) {
    if (a >= end) break;
    if (b >= end - 1) { end = a; break; }
    if (!brk) gaps.push([a, b]);
    else if (b - a > brk + 2) gaps.push([a, b - brk]);
  }
  // (with next to nothing left, play it all)
  if (end - gaps.reduce((t, g) => t + g[1] - g[0], 0) < 5) return { gaps: [], end: e.dur, lead };
  return { gaps, end, lead };
}
/** Episode i's length on the channel (ms). */
function durMs(ch, i) {
  const c = cuts(ch, i);
  return Math.round((c.lead + c.end - c.gaps.reduce((t, g) => t + g[1] - g[0], 0)) * 1000);
}
const passMs = (ch) => ch.eps.reduce((s, e, i) => s + durMs(ch, i), 0);

/**
 * What's on at time T: { pos, i, start, end, off, pause }, or null before the
 * schedule begins. (`lead`: one of the episodes before the anchor, ch.lead[k].)
 */
function at(ch, T) {
  if (!ch.eps.length) return null;
  const A = ch.anchor;
  if (T < A.t) {
    const L = ch.lead;
    for (let k = L.length - 1; k >= 0; k--) {
      const e = L[k];
      if (T < e.t) continue;
      if (e.i >= ch.eps.length) return null;
      return {
        pos: e.pos, i: e.i, start: e.t, end: k + 1 < L.length ? L[k + 1].t : A.t, off: e.off || 0, pause: e.pause || null,
        lead: true, k,
      };
    }
    return null;
  }
  let pos = A.pos, start = A.t;
  const n = ch.eps.length;
  const omit = ch.omit, lastOmit = omit.length ? Math.max(...omit) : -Infinity;
  const step = () => {
    if (omit.includes(pos)) { pos++; return null; }
    const i = epAt(ch, pos), d = durMs(ch, i);
    if (start + d > T) return { pos, i, start, end: start + d, off: 0, pause: null };
    start += d;
    pos++;
    return null;
  };
  let hit;
  // to the end of this pass (and past anything left out), then whole passes
  // at once, then within the last
  while (((pos % n) + n) % n !== 0 || pos <= lastOmit) if ((hit = step())) return hit;
  const L = passMs(ch);
  const k = Math.floor((T - start) / L);
  pos += k * n;
  start += k * L;
  for (;;) if ((hit = step())) return hit;
}

/** The schedule from `from` to `to`: [[start, end, episode index, pos, off, paused (1|0)]]. */
function schedule(ch, from, to) {
  const out = [];
  let e = at(ch, from);
  if (!e) {
    // before it begins: from the lead, or the anchor
    if (ch.lead.length && from < ch.lead[0].t) e = at(ch, ch.lead[0].t);
    if (!e) e = at(ch, ch.anchor.t);
  }
  while (e && e.start < to && out.length < MAX_ENTRIES) {
    out.push([e.start, e.end, e.i, e.pos, e.off, e.pause ? 1 : 0]);
    e = at(ch, e.end);
  }
  return out;
}

/** What came before entry `e` (episode indexes, most recent first): what
 *  Previous goes back to. */
function backOf(ch, e) {
  if (e.lead) return ch.lead[e.k].back || [];
  const out = [];
  let pos = e.pos;
  while (pos > ch.anchor.pos && out.length < BACK) if (!ch.omit.includes(--pos)) out.push(epAt(ch, pos)); // the run, back to the anchor
  const L = ch.lead[ch.lead.length - 1];
  if (L && L.i < ch.eps.length) out.push(L.i, ...(L.back || []));
  else while (out.length < BACK && ch.eps.length > 1) out.push(epAt(ch, --pos)); // before it, the run's own order
  return out.slice(0, BACK);
}

/** The lead's entries after the k'th, as items to play again ({ i, pos, back, off, pause, ms }). */
function leadAfter(ch, k) {
  const L = ch.lead;
  return L.slice(k + 1).map((e, j) => ({
    i: e.i, pos: e.pos, back: e.back || [], off: e.off || 0, pause: e.pause || null,
    ms: (k + 2 + j < L.length ? L[k + 2 + j].t : ch.anchor.t) - e.t,
  }));
}
/** How long an item plays: a pause as long as it was given, an episode from `off` to its end. */
const itemMs = (ch, q) => (q.pause ? q.ms : Math.max(1000, durMs(ch, q.i) - Math.round((q.off || 0) * 1000)));

/**
 * The run starts again from now, with the episode on now playing out first
 * (if it's still one of the channel's), and any a vote put on after it: used
 * after a change of episodes, order or skipping. `before`: a copy of the
 * channel from before the change.
 */
function restartRun(ch, before, now) {
  const cur = at(before, now);
  const map = (j) => {
    const e = before.eps[j];
    return e ? ch.eps.findIndex((x) => x.id === e.id) : -1;
  };
  const backs = (b) => (b || []).map(map).filter((j) => j >= 0);
  const keep = [];
  if (cur && map(cur.i) >= 0) {
    keep.push({ i: map(cur.i), pos: cur.pos, back: backs(backOf(before, cur)), off: cur.off, pause: cur.pause, ms: cur.end - cur.start });
    if (cur.lead) {
      for (const e of leadAfter(before, cur.k)) if (map(e.i) >= 0) keep.push(Object.assign(e, { i: map(e.i), back: backs(e.back) }));
    }
  }
  // the same episodes in the same order (only how long they play changed:
  // skipping turned on or off, SponsorBlock's parts found): the run carries
  // on where it was, so a shuffle doesn't start its pass again
  const sameEps = ch.order === before.order && ch.seed === before.seed && ch.eps.length === before.eps.length &&
    ch.eps.every((e, i) => e.id === before.eps[i].id);
  const next = !sameEps ? null : !cur ? before.anchor.pos : cur.lead ? before.anchor.pos : cur.pos + 1;
  ch.omit = next == null ? [] : before.omit.filter((q) => q >= next); // (else a new run)
  if (!keep.length) {
    ch.lead = [];
    ch.anchor = { t: now, pos: next == null ? 0 : next };
    return;
  }
  let t = cur.start;
  ch.lead = keep.map((q) => {
    const e = { i: q.i, t, pos: q.pos, back: q.back };
    if (q.off) e.off = q.off;
    if (q.pause) e.pause = q.pause;
    t += itemMs(ch, q);
    return e;
  });
  // in order: carry on from the episode after the last of them
  ch.anchor = { t, pos: next != null ? next : ch.order === "shuffle" ? 0 : keep[keep.length - 1].i + 1 };
}

// ---------------------------------------------------------------- checking
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const int = (v) => (Number.isInteger(v) ? v : null);
function cleanName(v) {
  const n = str(v, 200);
  if (!n) throw new ChannelError(400, "Give the channel a name");
  if (n.length > 40) throw new ChannelError(400, "Channel names can be at most 40 characters");
  return n;
}
function cleanOrder(v) {
  if (v !== "order" && v !== "shuffle") throw new ChannelError(400, "Order is \"order\" or \"shuffle\"");
  return v;
}
function cleanSkip(v) {
  if (v == null) return { intro: false, credits: false };
  if (typeof v !== "object") throw new ChannelError(400, "Skip is { intro, credits }");
  return { intro: !!v.intro, credits: !!v.credits };
}
function cleanSeasons(v) {
  if (v == null) return null;
  // (last: null for "to the latest season", so new seasons are taken in when they turn up)
  const ok = (x) => Number.isInteger(x) && x >= 0 && x < 10000;
  if (!Array.isArray(v) || v.length !== 2 || !ok(v[0]) || !(v[1] === null || ok(v[1])) || (v[1] !== null && v[0] > v[1])) {
    throw new ChannelError(400, "Seasons are [first, last], last null for the latest");
  }
  return [v[0], v[1]];
}
const sec = (v) => Math.round(+v * 1000) / 1000;
/** Parts of a video always left out (YouTube's sponsors and the like): [[start, end]], in order. */
function cleanCut(v, dur) {
  if (!Array.isArray(v)) return [];
  const spans = v.slice(0, 100).filter((s) => Array.isArray(s) && s.length === 2)
    .map(([a, b]) => [sec(Math.max(0, +a)), sec(Math.min(dur, +b))])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b - a >= 0.5);
  return merge(spans);
}
/** `min`: the shortest running time that can be scheduled (s). */
function cleanEps(v, min = 30) {
  if (!Array.isArray(v)) throw new ChannelError(400, "Send the channel's episodes");
  if (v.length > MAX_EPS) throw new ChannelError(400, `A channel can have at most ${MAX_EPS} episodes`);
  const out = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const id = str(e.id, 100), dur = +e.dur;
    // (running times under half a minute, or none, can't be scheduled)
    if (!id || !(dur >= min && dur <= 12 * 3600)) continue;
    // markers that make sense: an intro in the first half that isn't most of
    // it, end credits in the second half
    const iv = Array.isArray(e.intro) ? e.intro.map(Number) : null;
    const intro = iv && iv.length === 2 && iv[0] >= 0 && iv[1] > iv[0] + 1 && iv[1] <= dur / 2 ? [sec(iv[0]), sec(iv[1])] : null;
    const credits = +e.credits > dur / 2 && +e.credits < dur - 1 ? sec(e.credits) : null;
    out.push({
      id, dur: sec(dur), title: str(e.title, 200),
      season: int(e.season), episode: int(e.episode),
      desc: str(e.desc, 400), rating: str(e.rating, 20), aired: str(e.aired, 10),
      intro, credits, mk: !!e.mk,
    });
    const cut = cleanCut(e.cut, dur);
    if (cut.length) out[out.length - 1].cut = cut;
  }
  if (!out.length) throw new ChannelError(400, "None of those episodes has a running time, so nothing can be scheduled");
  return out;
}
function cleanSrc(v) {
  if (!v || typeof v !== "object" || (v.type !== "plex" && v.type !== "jellyfin")) throw new ChannelError(400, "Channels play from Plex, Jellyfin or YouTube");
  const server = str(v.server, 200);
  if (!server) throw new ChannelError(400, "Say which server the channel plays from");
  return { type: v.type, server, name: str(v.name, 80) || (v.type === "plex" ? "Plex" : "Jellyfin") };
}
function cleanShow(v) {
  if (!v || typeof v !== "object" || !str(v.id, 100)) throw new ChannelError(400, "Say which show the channel plays");
  return { id: str(v.id, 100), title: str(v.title, 200) };
}

// ---------------------------------------------------------------- channels
/** Every channel, with its schedule from `from` to `to` (ms). */
export function list(from, to) {
  const now = Date.now();
  from = Number.isFinite(from) ? from : now - 3 * 3600e3;
  to = Number.isFinite(to) ? to : now + 9 * 24 * 3600e3;
  if (to < from) to = from;
  if (to - from > MAX_WINDOW) to = from + MAX_WINDOW;
  const d = load();
  return {
    rev: d.rev,
    channels: d.channels.map((ch) => ({
      id: ch.id, name: ch.name, src: ch.src, show: ch.show, seasons: ch.seasons, order: ch.order, skip: ch.skip,
      eps: ch.eps, sched: schedule(ch, from, to),
      yt: ch.yt ? ytInfo(ch) : undefined,
    })),
  };
}

/**
 * The channel's episodes are now `eps` (already checked): if that changes
 * what plays when, the run starts again after the episode on now. `before`:
 * a copy of the channel from before this change (which may have changed
 * other things too). true if anything changed.
 */
function setEps(ch, eps, before, now) {
  const was = ch.eps;
  const same = eps.length === was.length && eps.every((e, i) => e.id === was[i].id && e.dur === was[i].dur);
  ch.eps = eps;
  if (!same || ch.eps.some((e, i) => durMs(ch, i) !== durMs(before, i))) {
    restartRun(ch, before, now);
    votes.delete(ch.id);
    return true;
  }
  return JSON.stringify(was) !== JSON.stringify(eps);
}
export const rev = () => load().rev;

export function add(b, by) {
  const d = load();
  if (d.channels.length >= MAX_CHANNELS) throw new ChannelError(400, `There can be at most ${MAX_CHANNELS} channels`);
  const now = Date.now();
  const ch = {
    id: crypto.randomUUID(), name: cleanName(b.name), src: cleanSrc(b.src), show: cleanShow(b.show),
    seasons: cleanSeasons(b.seasons), order: cleanOrder(b.order || "order"), seed: crypto.randomBytes(8).toString("hex"),
    skip: cleanSkip(b.skip), eps: cleanEps(b.eps),
    // from the start of this half hour, the way a channel's day is laid out
    anchor: { t: Math.floor(now / SLOT) * SLOT, pos: 0 }, lead: [], omit: [],
    created: new Date(now).toISOString(), by: str(by, 64),
  };
  d.channels.push(ch);
  changed();
  log(`${by || "someone"} made the channel ${ch.name} (${ch.show.title}, ${ch.eps.length} episodes, ${ch.order})`);
  return ch;
}

export function update(id, b, by) {
  const ch = must(id);
  const now = Date.now();
  const before = Object.assign({}, ch);
  let rerun = false;
  if (ch.yt && (b.eps !== undefined || b.seasons !== undefined)) throw new ChannelError(400, "A YouTube channel's videos come from YouTube");
  // YouTube: shorts, live stream replays, which way round (checked before anything changes)
  let yt = null;
  if (ch.yt && b.yt !== undefined) {
    const o = cleanYtOpts(b.yt, ch.yt);
    if (o.shorts !== ch.yt.shorts || o.live !== ch.yt.live || o.rev !== ch.yt.rev) {
      yt = Object.assign({}, ch.yt, o);
      if (!ytEps(Object.assign({}, ch, { yt })).length) throw new ChannelError(400, ytNone({ yt }));
    }
  }
  if (b.name !== undefined) ch.name = cleanName(b.name);
  if (b.seasons !== undefined) ch.seasons = cleanSeasons(b.seasons);
  // (the same episodes, as long on the channel, from a check for new ones
  // that found none, or two TVs checking at once: any new titles and the
  // like are taken in, but the schedule stays as it is)
  if (b.eps !== undefined) setEps(ch, cleanEps(b.eps), before, now);
  if (b.order !== undefined && cleanOrder(b.order) !== ch.order) {
    ch.order = b.order;
    ch.seed = crypto.randomBytes(8).toString("hex"); // a fresh shuffle
    rerun = true;
  }
  if (b.skip !== undefined) {
    const s = cleanSkip(b.skip);
    if (s.intro !== ch.skip.intro || s.credits !== ch.skip.credits) { ch.skip = s; rerun = true; }
  }
  if (yt) {
    ch.yt = yt;
    setEps(ch, ytEps(ch), before, now);
    queueSB(ch.id);
  }
  if (rerun) { restartRun(ch, before, now); votes.delete(id); }
  changed();
  log(`${by || "someone"} changed the channel ${ch.name}: ${Object.keys(b).join(", ")}`);
  return ch;
}

export function remove(id, by) {
  const d = load();
  const ch = must(id);
  d.channels = d.channels.filter((c) => c !== ch);
  watchers.delete(id);
  votes.delete(id);
  changed();
  log(`${by || "someone"} removed the channel ${ch.name}`);
}

// ----------------------------------------------------------------- YouTube
/*
 * A YouTube channel's uploads or a playlist, played in YouTube's own player
 * on each TV (so the people who made them get the views). The server reads
 * the list from YouTube itself (youtube.mjs; the browser can't), and keeps
 * every video in it (yt.vids, in YouTube's order: a channel's newest first,
 * a playlist's own), whether each is a short or a live stream's replay, and
 * SponsorBlock's parts. The channel's episodes are the ones its settings
 * pick (ytEps), so turning shorts or replays on or off, or playing it the
 * other way round, needs nothing new from YouTube.
 *
 *   yt: { kind: "channel" | "playlist", id, logo, shorts, live, rev (newest
 *         first / the playlist backwards), at (last read), vids: [{ id,
 *         title, dur, aired (rough), lv, sh (a short: true | false | null,
 *         not known), intro, credits, cut, sb (when SponsorBlock was asked) }],
 *         bad: [ids that YouTube won't play outside youtube.com] }
 *
 * Skip Credits (on by default) leaves out end cards and credits; Skip Intros
 * an intro animation or intermission (else the Skip Intro button shows);
 * sponsors, self promotion and reminders to subscribe are always left out.
 * The list is read again every few hours, for new uploads. SponsorBlock is
 * asked about each video once, a little at a time in the background, and
 * again for the first couple of weeks after a video comes out (when most of
 * its parts are added).
 */
const YT_EVERY = 6 * 3600e3;     // read each list again this often
const SB_FRESH = 14 * 86400e3;   // SponsorBlock is asked again about videos this new...
const SB_AGAIN = 12 * 3600e3;    // ...this often
const MIN_YT = 5;                // the shortest video scheduled (s)
const LEAD = 3;                  // before each video, while the TVs start YouTube's player (s): see cuts

const ytInfo = (ch) => {
  const y = ch.yt;
  return { kind: y.kind, id: y.id, logo: y.logo, shorts: y.shorts, live: y.live, rev: y.rev, at: y.at, vids: y.vids.length, bad: y.bad.length, lead: y.lead || 0 };
};
function cleanYtOpts(v, was) {
  if (!v || typeof v !== "object") throw new ChannelError(400, "YouTube options are { shorts, live, rev }");
  const pick = (k) => (v[k] === undefined ? !!(was && was[k]) : !!v[k]);
  return { shorts: pick("shorts"), live: pick("live"), rev: pick("rev") };
}
/** A short, as far as anyone knows (not known yet: a minute or less). */
const shortish = (v) => (v.sh == null ? v.dur <= 60 : v.sh);
/** The videos a YouTube channel plays, as episodes, in order. */
function ytEps(ch) {
  const y = ch.yt, bad = new Set(y.bad);
  let vids = y.vids.filter((v) => !bad.has(v.id) && v.dur >= MIN_YT && (y.shorts || !shortish(v)) && (y.live || !v.lv));
  // (too many: the newest of a channel, the start of a playlist)
  vids = vids.slice(0, MAX_EPS);
  // a channel's list is newest first; "in order" is oldest first
  if (y.kind === "channel" ? !y.rev : y.rev) vids.reverse();
  return cleanEps(vids.map((v) => ({
    id: v.id, title: v.title, dur: v.dur, aired: v.aired, rating: "", season: null, episode: null,
    desc: [v.lv && "A live stream's replay.", shortish(v) && "A short."].filter(Boolean).join(" "),
    intro: v.intro || null, credits: v.credits || null, cut: v.cut || [], mk: true,
  })), MIN_YT);
}
const ytNone = (ch) => `There are no videos to play${!ch.yt.shorts || !ch.yt.live
  ? ` with ${[!ch.yt.shorts && "shorts", !ch.yt.live && "live stream replays"].filter(Boolean).join(" and ")} left out` : ""}`;

/** Look up which of `vids` (without sh yet) of 3 minutes or less are shorts, a few at a time. */
async function findShorts(vids, progress) {
  const todo = vids.filter((v) => v.sh == null && YT.mightBeShort(v.dur));
  let next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const v = todo[next++];
      v.sh = await YT.isShort(v.id);
      done++;
      if (progress && (done % 10 === 0 || done === todo.length)) progress(`Looking for shorts: ${done} of ${todo.length}...`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, todo.length) }, worker));
  for (const v of vids) if (v.sh == null && !YT.mightBeShort(v.dur)) v.sh = false;
}

/** The list as YouTube has it now, with what's known already of each video kept. */
async function readList(kind, id, old, progress) {
  const got = await YT.videos(kind, id, (n) => progress && progress(`Reading the list of videos: ${n.toLocaleString("en-US")}...`));
  const had = new Map((old || []).map((v) => [v.id, v]));
  const vids = got.map((v) => {
    const o = had.get(v.id);
    // (YouTube says roughly how old a video is, so the first reading is the closest)
    return o ? Object.assign({}, o, { title: v.title || o.title, dur: v.dur, lv: v.lv || o.lv }) : v;
  });
  await findShorts(vids, progress);
  return vids;
}

// jobs: things that take a while (reading a long list), which the TV asks after
const jobs = new Map(); // id -> { at, msg, done, error, result }
function job(fn) {
  const id = crypto.randomUUID();
  const j = { at: Date.now(), msg: "Starting...", done: false, error: "", result: null };
  jobs.set(id, j);
  for (const [k, x] of jobs) if (Date.now() - x.at > 3600e3) jobs.delete(k);
  fn((m) => { j.msg = m; }).then(
    (r) => { j.done = true; j.result = r || null; },
    (e) => { j.done = true; j.error = e.message || String(e); if (!(e instanceof ChannelError || e instanceof YT.YouTubeError)) log(`YouTube: ${j.error}`); },
  );
  return id;
}
/** How a job is going: { done, msg, error, result }. */
export function jobState(id) {
  const j = jobs.get(id);
  if (!j) throw new ChannelError(404, "That's finished with (or the server restarted): look at the channels again");
  return { done: j.done, msg: j.msg, error: j.error, result: j.result };
}

/** What a YouTube link is: { kind, id, title }. */
export async function ytLookup(url) {
  return pickYtError(() => YT.resolve(url)).then((r) => ({ kind: r.kind, id: r.id, title: r.title }));
}
async function pickYtError(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof YT.YouTubeError) throw new ChannelError(400, e.message);
    throw new ChannelError(502, e.message);
  }
}

/** Make a YouTube channel: { name, order, yt: { url, shorts, live, rev } }. A job. */
export function addYoutube(b, by) {
  const d = load();
  if (d.channels.length >= MAX_CHANNELS) throw new ChannelError(400, `There can be at most ${MAX_CHANNELS} channels`);
  if (!b.yt || typeof b.yt !== "object") throw new ChannelError(400, "Paste a link to a YouTube channel or playlist");
  const opts = cleanYtOpts(b.yt, null);
  const order = cleanOrder(b.order || "order");
  const named = str(b.name, 200);
  if (named) cleanName(named);
  try { YT.parse(b.yt.url); } catch (e) { throw new ChannelError(400, e.message); } // (a link that can't be one fails now, not in the job)
  return job(async (say) => {
    say("Finding it on YouTube...");
    const r = await pickYtError(() => YT.resolve(b.yt.url));
    const vids = await pickYtError(() => readList(r.kind, r.id, null, say));
    if (!vids.length) throw new ChannelError(400, "YouTube didn't list any videos there that can be played");
    const now = Date.now();
    const name = cleanName(named || r.title.slice(0, 40));
    const yt = Object.assign({ kind: r.kind, id: r.id, logo: (r.logo || "").replace(/=s\d+-/, "=s88-"), at: now, vids, bad: [], lead: LEAD }, opts);
    const ch = {
      id: crypto.randomUUID(), name,
      src: { type: "youtube", server: "youtube", name: "YouTube" },
      show: { id: r.id, title: r.title }, seasons: null, order, seed: crypto.randomBytes(8).toString("hex"),
      // end cards and credits left out unless asked for
      skip: { intro: false, credits: true }, yt, eps: [],
      anchor: { t: Math.floor(now / SLOT) * SLOT, pos: 0 }, lead: [], omit: [],
      created: new Date(now).toISOString(), by: str(by, 64),
    };
    ch.eps = ytEps(ch);
    if (!ch.eps.length) throw new ChannelError(400, ytNone(ch));
    if (load().channels.length >= MAX_CHANNELS) throw new ChannelError(400, `There can be at most ${MAX_CHANNELS} channels`);
    load().channels.push(ch);
    changed();
    log(`${by || "someone"} made the channel ${ch.name} (YouTube ${r.kind} ${r.title}, ${ch.eps.length} of ${vids.length} videos, ${order})`);
    queueSB(ch.id);
    return { id: ch.id, n: ch.eps.length, of: vids.length };
  });
}

/** Read a YouTube channel's list again (new uploads). { fresh, gone }. */
const reading = new Set();
async function ytRefresh(id, say, quiet) {
  if (reading.has(id)) throw new ChannelError(409, "It's being looked at already");
  reading.add(id);
  try {
    let ch = must(id);
    const vids = await pickYtError(() => readList(ch.yt.kind, ch.yt.id, ch.yt.vids, say));
    ch = must(id); // (still there?)
    const old = ch.yt.vids;
    // far fewer than before: more likely YouTube having a bad moment than
    // the videos deleted (left for an admin to look at)
    if (old.length >= 10 && vids.length < old.length / 2) {
      throw new ChannelError(502, `YouTube listed ${vids.length} videos where there were ${old.length}, so the channel was left as it was`);
    }
    const before = Object.assign({}, ch);
    const ids = new Set(vids.map((v) => v.id)), was = new Set(old.map((v) => v.id));
    ch.yt = Object.assign({}, ch.yt, { vids, at: Date.now() });
    ch.yt.bad = ch.yt.bad.filter((x) => ids.has(x));
    const eps = ytEps(ch);
    // (only what's kept about the videos changed: saved, but the TVs needn't look again)
    if (eps.length && setEps(ch, eps, before, Date.now())) changed(); else save();
    const fresh = vids.filter((v) => !was.has(v.id)).length, gone = old.filter((v) => !ids.has(v.id)).length;
    if (fresh || gone || !quiet) log(`channel ${ch.name}: ${fresh} new video(s) on YouTube, ${gone} gone`);
    queueSB(id);
    return { fresh, gone, n: ch.eps.length };
  } finally {
    reading.delete(id);
  }
}
/** Look for new videos now: a job. */
export function ytRefreshJob(id) {
  const ch = must(id);
  if (!ch.yt) throw new ChannelError(400, "That isn't a YouTube channel");
  return job((say) => ytRefresh(id, say, false));
}

// SponsorBlock, in the background: one channel at a time, a few videos at once
const sbWant = new Set();
let sbBusy = false;
function queueSB(id) {
  sbWant.add(id);
  if (!sbBusy) runSB();
}
async function runSB() {
  sbBusy = true;
  try {
    while (sbWant.size) {
      const id = sbWant.values().next().value;
      sbWant.delete(id);
      try { await fillSB(id); } catch (e) { log(`SponsorBlock: ${e.message}`); }
    }
  } finally {
    sbBusy = false;
  }
}
const needsSB = (v, now) => !v.sb || (now - v.sb > SB_AGAIN && v.aired && now - Date.parse(v.aired) < SB_FRESH);
async function fillSB(id) {
  let ch = find(id);
  if (!ch || !ch.yt) return;
  const now = Date.now();
  const playing = new Set(ch.eps.map((e) => e.id));
  // the next ones to play first, so they're the first to be right
  const upNext = new Map(schedule(ch, now, now + 2 * 86400e3).map(([, , i], k) => [ch.eps[i] && ch.eps[i].id, k]));
  const todo = ch.yt.vids.filter((v) => playing.has(v.id) && needsSB(v, now))
    .map((v) => ({ id: v.id, dur: v.dur }))
    .sort((a, b) => (upNext.has(a.id) ? upNext.get(a.id) : 1e9) - (upNext.has(b.id) ? upNext.get(b.id) : 1e9));
  if (!todo.length) return;
  const found = new Map();
  let next = 0, failed = 0, done = 0, stop = false;
  /** What's been found so far, onto the channel (as it is now) */
  const keep = () => {
    const c = find(id);
    if (!c || !c.yt || !found.size) return;
    const before = Object.assign({}, c);
    c.yt = Object.assign({}, c.yt, {
      vids: c.yt.vids.map((v) => (found.has(v.id) ? Object.assign({}, v, found.get(v.id)) : v)),
    });
    found.clear();
    const eps = ytEps(c);
    if (eps.length && setEps(c, eps, before, Date.now())) changed(); else save();
  };
  const worker = async () => {
    while (!stop && next < todo.length) {
      if (!find(id)) { stop = true; break; } // (the channel was removed)
      const v = todo[next++];
      try {
        const s = await YT.segments(v.id, v.dur);
        found.set(v.id, { intro: s.intro, credits: s.credits, cut: s.cut, sb: Date.now() });
      } catch (e) {
        // SponsorBlock down: try again with the next look at the list
        if (++failed >= 10 && failed > done) { stop = true; log(`SponsorBlock: ${e.message}; trying again later`); }
      }
      done++;
      if (found.size >= 200) keep();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, todo.length) }, worker));
  keep();
  ch = find(id);
  if (ch) log(`channel ${ch.name}: SponsorBlock asked about ${done} video(s)`);
}

/** Every so often: lists that haven't been read for a while are read again. */
async function ytTick() {
  for (const ch of load().channels.slice()) {
    if (!ch.yt || Date.now() - ch.yt.at < YT_EVERY || reading.has(ch.id)) continue;
    try { await ytRefresh(ch.id, null, true); } catch (e) {
      log(`channel ${ch.name}: couldn't read its list from YouTube (${e.message}); trying again later`);
      const c = find(ch.id);
      if (c) c.yt.at = Date.now() - YT_EVERY + 3600e3; // in an hour
    }
  }
}

// ---------------------------------------------------------- watching, votes
/** channel id -> Map(viewer -> { at, name }) */
const watchers = new Map();
/** channel id -> { start (of the episode voted on), [action]: Map(viewer -> at),
 *  arg: { seek: { to }, pause: { min, by, name } } (what's being voted for) } */
const votes = new Map();
/** channel id -> { action, at, pos }: the last vote that passed */
const done = new Map();

/** The person behind a viewer ("user id:tv"), or "home" with sign-in off. */
const personOf = (viewer) => String(viewer).split(":")[0];

function viewersOf(id, now) {
  const m = watchers.get(id);
  if (!m) return new Map();
  for (const [v, w] of m) if (now - w.at > SEEN_FOR) m.delete(v);
  if (!m.size) watchers.delete(id);
  return m;
}
/** More than half of the TVs watching (one alone decides for itself). */
const need = (n) => (n <= 1 ? 1 : Math.floor(n / 2) + 1);

/** A viewer is on one channel at a time. */
function seen(id, viewer, name, now) {
  for (const [cid, m] of watchers) if (cid !== id) m.delete(viewer);
  if (!watchers.has(id)) watchers.set(id, new Map());
  watchers.get(id).set(viewer, { at: now, name: str(name, 64) });
}

/** How far into its episode `cur` is at `now` (the channel's seconds). */
const elapsed = (cur, now) => (cur.pause ? cur.off : cur.off + (now - cur.start) / 1000);

/**
 * What an action would do to the episode on now (`cur`): the items to play
 * (from now, or from when this one ends: `whole`), then the run from `pos`.
 * { why } when it can't be done. `arg`: seek { to }, pause { min, by, name }.
 */
function plan(ch, action, cur, now, arg) {
  // what was coming up after this one, outside the run (Play Next in
  // Order; while paused, first the rest of this episode)
  let after = cur.lead ? leadAfter(ch, cur.k) : [];
  const rest = cur.pause ? after[0] : null;
  if (rest) after = after.slice(1);
  const pos = cur.lead ? ch.anchor.pos : cur.pos + 1;
  const back = backOf(ch, cur);
  const me = { i: cur.i, pos: cur.pos, back };
  switch (action) {
    case "restart": return { queue: [me, ...after], pos };
    case "skip": return { queue: after, pos };
    case "prev": {
      const p = back[0];
      if (ch.eps.length < 2 || p == null || p === cur.i) return { why: "Nothing came before this episode" };
      // that one, then this one again from the start
      return { queue: [{ i: p, pos: cur.pos - 1, back: back.slice(1) }, me, ...after], pos };
    }
    case "resume":
      if (!rest) return { why: "It isn't paused" };
      return { queue: [rest, ...after], pos };
  }
  if (cur.pause) return { why: action === "pause" ? "It's paused already" : "Resume it first" };
  if (action === "seek") {
    const max = durMs(ch, cur.i) / 1000 - 5;
    const to = arg && Number.isFinite(arg.to) ? Math.max(0, Math.min(max, arg.to)) : null;
    if (to == null) return { why: "Say where to go" };
    return { queue: [Object.assign({ off: to }, me), ...after], pos };
  }
  if (action === "pause") {
    const min = arg && Number.isInteger(arg.min) ? arg.min : 0;
    if (min < 1 || min > PAUSE_MAX) return { why: `Pause for 1 to ${PAUSE_MAX} minutes` };
    const off = Math.round(elapsed(cur, now) * 1000) / 1000;
    return {
      queue: [Object.assign({ off, pause: { by: arg.by, name: arg.name || "" }, ms: min * 60e3 }, me), Object.assign({ off }, me), ...after],
      pos,
    };
  }
  // next: the show's next episode, after this one
  const n = cur.i + 1;
  if (n >= ch.eps.length) return { why: "This is the channel's last episode" };
  const up = at(ch, cur.end);
  if (up && up.i === n) return { why: "It's on next already" };
  // shuffled: leave it out when the shuffle comes to it in this pass
  let omit = null;
  const N = ch.eps.length, end = (Math.floor(pos / N) + 1) * N;
  if (ch.order === "shuffle") for (let q = pos; q < end; q++) if (!ch.omit.includes(q) && epAt(ch, q) === n) { omit = q; break; }
  return {
    whole: true, omit, pos,
    queue: [{ i: n, pos: cur.pos, back: [cur.i, ...back] }, ...after.map((e) => Object.assign(e, { back: [n, ...e.back] }))],
  };
}

/** Lay out the schedule from the episode on now as `plan` says: the past few
 *  hours and this episode (to now, or its end) kept, then the plan's items,
 *  then the run. */
function replan(ch, cur, now, p) {
  const lead = [];
  const entry = (i, t, pos, back, off, pause) => {
    const e = { i, t, pos };
    if (back) e.back = back.slice(0, BACK);
    if (off) e.off = off;
    if (pause) e.pause = pause;
    return e;
  };
  for (const [t, , i, pos, off] of schedule(ch, now - KEEP, cur.start)) lead.push(entry(i, t, pos, null, off));
  let t = p.whole ? cur.end : now;
  if (t > cur.start) lead.push(entry(cur.i, cur.start, cur.pos, backOf(ch, cur), cur.off, cur.pause));
  for (const q of p.queue) {
    lead.push(entry(q.i, t, q.pos, q.back, q.off, q.pause));
    t += itemMs(ch, q);
  }
  ch.lead = lead;
  ch.anchor = { t, pos: p.pos };
  ch.omit = ch.omit.filter((q) => q >= p.pos).concat(p.omit != null ? [p.omit] : []);
}

const DID = {
  restart: "started over", prev: "went back from", skip: "skipped", next: "put the next episode after",
  seek: "moved around in", pause: "paused", resume: "resumed",
};
/** Carry out an action that has passed. false if it no longer can be. */
function apply(ch, action, cur, now, arg) {
  votes.delete(ch.id);
  const p = plan(ch, action, cur, now, arg);
  if (p.why) return false;
  replan(ch, cur, now, p);
  done.set(ch.id, { action, at: now, pos: cur.pos });
  changed();
  log(`channel ${ch.name}: ${DID[action]} ${ch.eps[cur.i].title || "an episode"}${action === "pause" ? ` for ${arg.min} min` : ""}`);
  return true;
}

/** Count the votes on a channel; carry one out if it has passed. The action
 *  done, or "". */
function settle(ch, now) {
  const v = votes.get(ch.id);
  if (!v) return "";
  const cur = at(ch, now);
  if (!cur || cur.start !== v.start) { votes.delete(ch.id); return ""; }
  const viewers = viewersOf(ch.id, now);
  for (const action of ACTIONS) {
    const m = v[action];
    for (const [who, t] of m) if (now - t > VOTE_FOR || !viewers.has(who)) m.delete(who);
    if (m.size && m.size >= need(viewers.size)) return apply(ch, action, cur, now, v.arg[action]) ? action : "";
  }
  if (ACTIONS.every((a) => !v[a].size)) votes.delete(ch.id);
  return "";
}

/** What a watching TV is told: the schedule's version, who's watching, the
 *  votes (seek and pause with what they're for), what Previous and Play Next
 *  in Order would play ({ i }, or { why } not), and a pause on now. */
function state(ch, viewer, now) {
  const viewers = viewersOf(ch.id, now);
  const v = votes.get(ch.id);
  const cur = at(ch, now);
  const tally = (action) => {
    const m = v ? v[action] : null;
    const out = { n: m ? m.size : 0, need: need(viewers.size), mine: !!(m && m.has(viewer)) };
    if (m && m.size && v.arg[action]) {
      const a = v.arg[action];
      if (action === "seek") out.to = a.to;
      if (action === "pause") { out.min = a.min; out.name = a.name; }
    }
    return out;
  };
  const can = (action) => {
    const p = cur ? plan(ch, action, cur, now, null) : { why: "Nothing is on this channel right now" };
    return p.why ? { why: p.why } : { i: p.queue[0].i };
  };
  const last = done.get(ch.id);
  return {
    rev: doc.rev, viewers: viewers.size, pos: cur ? cur.pos : null, start: cur ? cur.start : null,
    votes: Object.fromEntries(ACTIONS.map((a) => [a, tally(a)])),
    can: { prev: can("prev"), next: can("next") },
    pause: cur && cur.pause ? { until: cur.end, name: cur.pause.name, mine: cur.pause.by === personOf(viewer) } : null,
    done: last && now - last.at < DONE_FOR ? { action: last.action, at: last.at } : null,
  };
}

/** A TV is watching channel `id` (said every few seconds). */
export function watch(id, viewer, name) {
  const ch = must(id);
  const now = Date.now();
  seen(id, viewer, name, now);
  settle(ch, now);
  return state(ch, viewer, now);
}

/** A TV has stopped watching: votes waiting on it may pass now. */
export function leave(id, viewer) {
  const m = watchers.get(id);
  if (m) m.delete(viewer);
  const ch = find(id);
  if (ch) settle(ch, Date.now());
}

/**
 * A vote: restart, prev, skip, next, seek (arg { to }: seconds into the
 * episode), pause (arg { min }) or resume. `start` (or, from older pages,
 * `pos`): the episode the TV is showing (the vote is refused if it has
 * changed since).
 */
export function vote(id, viewer, name, action, pos, start, arg) {
  if (!ACTIONS.includes(action)) throw new ChannelError(400, `Vote to ${ACTIONS.join(", ")}`);
  const ch = must(id);
  const now = Date.now();
  const cur = at(ch, now);
  if (!cur) throw new ChannelError(409, "Nothing is on this channel right now");
  if (start != null ? start !== cur.start : pos != null && pos !== cur.pos) throw new ChannelError(409, "The episode has already changed");
  arg = arg && typeof arg === "object" ? arg : {};
  const a = action === "seek" ? { to: +arg.to }
    : action === "pause" ? { min: Number.isInteger(arg.min) ? arg.min : 0, by: personOf(viewer), name: str(name, 64) }
      : null;
  const p = plan(ch, action, cur, now, a);
  if (p.why) throw new ChannelError(409, p.why);
  seen(id, viewer, name, now);
  // whoever paused it can end the pause without asking
  if (action === "resume" && cur.pause.by === personOf(viewer)) {
    apply(ch, action, cur, now, null);
    return Object.assign(state(ch, viewer, now), { applied: action });
  }
  let v = votes.get(id);
  if (!v || v.start !== cur.start) {
    votes.set(id, (v = { start: cur.start, arg: {} }));
    for (const x of ACTIONS) v[x] = new Map();
  }
  // asking for somewhere else to go, or another length of pause, starts that vote again
  const old = v.arg[action];
  if (a && v[action].size && old && (action === "seek" ? Math.abs(old.to - a.to) > 1 : old.min !== a.min)) v[action].clear();
  if (a && !v[action].size) v.arg[action] = a;
  // one vote each: asking for something else takes back the first
  for (const x of ACTIONS) v[x].delete(viewer);
  v[action].set(viewer, now);
  const applied = settle(ch, now);
  return Object.assign(state(ch, viewer, now), { applied });
}

/** Take back a vote. */
export function unvote(id, viewer) {
  const v = votes.get(id);
  if (v) for (const a of ACTIONS) v[a].delete(viewer);
  const ch = must(id);
  return state(ch, viewer, Date.now());
}

/**
 * A TV says YouTube won't play the video on now outside youtube.com (its
 * owner turned embedding off; private, gone, or age-restricted). Everyone
 * goes on to the next one at once, and it's left off the channel from the
 * next look at the list (so a shuffle isn't started again for it now).
 * `code`: YouTube's error (100: not found, 101 and 150: not allowed).
 */
const UNPLAYABLE = [100, 101, 150];
export function unplayable(id, viewer, name, start, code) {
  const ch = must(id);
  if (!ch.yt) throw new ChannelError(400, "That isn't a YouTube channel");
  if (!UNPLAYABLE.includes(code)) throw new ChannelError(400, "That isn't a reason to skip a video");
  const now = Date.now();
  const cur = at(ch, now);
  if (!cur) throw new ChannelError(409, "Nothing is on this channel right now");
  if (start !== cur.start) throw new ChannelError(409, "The video has already changed");
  seen(id, viewer, name, now);
  const vid = ch.eps[cur.i].id;
  if (!ch.yt.bad.includes(vid)) ch.yt.bad = ch.yt.bad.concat(vid).slice(-MAX_EPS);
  log(`channel ${ch.name}: YouTube won't play "${ch.eps[cur.i].title}" (${vid}) here (error ${code}), skipped`);
  if (!apply(ch, "skip", cur, now, null)) changed();
  done.set(ch.id, { action: "unplayable", at: now, pos: cur.pos });
  return state(ch, viewer, now);
}

export function init() {
  load();
  // YouTube: SponsorBlock where it was left off, and lists read again as they come due
  for (const ch of doc.channels) if (ch.yt) queueSB(ch.id);
  // channels made before videos had a lead-in (or with another): the video
  // on now plays out as it was, then the run carries on with them
  const now = Date.now();
  let moved = false;
  for (const ch of doc.channels) {
    if (!ch.yt || (ch.yt.lead === LEAD && !("brk" in ch.yt))) continue;
    const before = Object.assign({}, ch);
    ch.yt = Object.assign({}, ch.yt, { lead: LEAD });
    delete ch.yt.brk;
    restartRun(ch, before, now);
    moved = true;
  }
  if (moved) changed();
  setTimeout(ytTick, 60e3);
  setInterval(ytTick, 10 * 60e3);
}
