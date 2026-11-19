/*
 * Channels of our own, for the accounts service (server.mjs): one show from a
 * media server (Plex or Jellyfin), some or all of its seasons, playing around
 * the clock, in order or shuffled. Everyone sees the same schedule, so people
 * watching on different TVs are watching the same episode at the same moment.
 *
 * The TV that makes a channel sends its episodes (ids, running times, titles):
 * the server never talks to the media server itself. Each TV plays the
 * episode through its own On Demand connection to that server (see
 * webui/js/channels.js).
 *
 * The schedule is worked out, not stored: an anchor says which episode of the
 * channel's endless run starts when ({ t, pos }), and from there each
 * episode follows the last. pos counts episodes from the channel's start: in
 * order, it's episode pos mod n; shuffled, each pass through the episodes is
 * its own shuffle (made from the channel's seed and the pass's number), so
 * nothing repeats until everything has played. A change of episodes or order
 * keeps the episode on now playing to its end (`lead`), then starts the new
 * run. Starting over and skipping (below) move the anchor.
 *
 * Watching: the TVs tuned to a channel say so every few seconds. A TV can ask
 * to start the episode over or to skip it: alone on the channel, that happens
 * at once; with others watching, it waits for more than half of the TVs to
 * agree, or for the others to leave. A vote lapses after a few minutes, or
 * when the episode changes.
 *
 * Kept in /data/settings/channels.json:
 *   { rev, channels: [{ id, name, src: { type, server, name }, show: { id, title },
 *     seasons: [first, last] | null, order: "order" | "shuffle", seed,
 *     eps: [{ id, title, season, episode, dur (s), desc, rating, aired }],
 *     anchor: { t, pos }, lead: { i, t } | null, created, by }] }
 * rev goes up with every change to a channel or its schedule, so TVs know to
 * ask again. Who's watching and the votes are only in memory.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DIR = process.env.SETTINGS_DIR || "/data/settings";
const FILE = path.join(DIR, "channels.json");
const SEEN_FOR = 20e3;          // a TV that hasn't said it's watching for this long has gone (they say so every 6s)
const VOTE_FOR = 3 * 60e3;      // how long a vote stands
const DONE_FOR = 60e3;          // how long "skipped by vote" is told to TVs
const SLOT = 30 * 60e3;
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
const durMs = (ch, i) => Math.round(ch.eps[i].dur * 1000);
const passMs = (ch) => ch.eps.reduce((s, e) => s + Math.round(e.dur * 1000), 0);

/**
 * What's on at time T: { pos, i, start, end }, or null before the schedule
 * begins. (`lead`: the episode that was on when the channel last changed,
 * playing out before the anchor.)
 */
function at(ch, T) {
  if (!ch.eps.length) return null;
  const A = ch.anchor;
  if (T < A.t) {
    const L = ch.lead;
    if (L && L.i < ch.eps.length && T >= L.t) return { pos: A.pos - 1, i: L.i, start: L.t, end: A.t, lead: true };
    return null;
  }
  let pos = A.pos, start = A.t;
  const n = ch.eps.length;
  const step = () => {
    const i = epAt(ch, pos), d = durMs(ch, i);
    if (start + d > T) return { pos, i, start, end: start + d };
    start += d;
    pos++;
    return null;
  };
  let hit;
  // to the end of this pass, then whole passes at once, then within the last
  while (((pos % n) + n) % n !== 0) if ((hit = step())) return hit;
  const L = passMs(ch);
  const k = Math.floor((T - start) / L);
  pos += k * n;
  start += k * L;
  for (;;) if ((hit = step())) return hit;
}

/** The schedule from `from` to `to`: [[start, end, episode index, pos]]. */
function schedule(ch, from, to) {
  const out = [];
  let e = at(ch, from);
  if (!e) {
    // before it begins: from the lead, or the anchor
    if (ch.lead && from < ch.lead.t) e = at(ch, ch.lead.t);
    if (!e) e = at(ch, ch.anchor.t);
  }
  while (e && e.start < to && out.length < MAX_ENTRIES) {
    out.push([e.start, e.end, e.i, e.pos]);
    e = at(ch, e.end);
  }
  return out;
}

/**
 * The run starts again from now, with the episode on now playing out first
 * (if it's still one of the channel's): used after a change of episodes or
 * order. `before`: a copy of the channel from before the change.
 */
function restartRun(ch, before, now) {
  const cur = at(before, now);
  const id = cur && before.eps[cur.i].id;
  const i = id != null ? ch.eps.findIndex((e) => e.id === id) : -1;
  if (i >= 0 && cur.end > now) {
    // in order: carry on from the episode after it
    const pos = ch.order === "shuffle" ? 0 : i + 1;
    ch.lead = { i, t: cur.start };
    ch.anchor = { t: cur.start + durMs(ch, i), pos };
  } else {
    ch.lead = null;
    ch.anchor = { t: now, pos: 0 };
  }
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
function cleanSeasons(v) {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => Number.isInteger(x) && x >= 0 && x < 10000) || v[0] > v[1]) {
    throw new ChannelError(400, "Seasons are [first, last]");
  }
  return v;
}
function cleanEps(v) {
  if (!Array.isArray(v)) throw new ChannelError(400, "Send the channel's episodes");
  if (v.length > MAX_EPS) throw new ChannelError(400, `A channel can have at most ${MAX_EPS} episodes`);
  const out = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const id = str(e.id, 100), dur = +e.dur;
    // (running times under half a minute, or none, can't be scheduled)
    if (!id || !(dur >= 30 && dur <= 6 * 3600)) continue;
    out.push({
      id, dur: Math.round(dur * 1000) / 1000, title: str(e.title, 200),
      season: int(e.season), episode: int(e.episode),
      desc: str(e.desc, 400), rating: str(e.rating, 20), aired: str(e.aired, 10),
    });
  }
  if (!out.length) throw new ChannelError(400, "None of those episodes has a running time, so nothing can be scheduled");
  return out;
}
function cleanSrc(v) {
  if (!v || typeof v !== "object" || (v.type !== "plex" && v.type !== "jellyfin")) throw new ChannelError(400, "Channels play from Plex or Jellyfin");
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
      id: ch.id, name: ch.name, src: ch.src, show: ch.show, seasons: ch.seasons, order: ch.order,
      eps: ch.eps, sched: schedule(ch, from, to),
    })),
  };
}
export const rev = () => load().rev;

export function add(b, by) {
  const d = load();
  if (d.channels.length >= MAX_CHANNELS) throw new ChannelError(400, `There can be at most ${MAX_CHANNELS} channels`);
  const now = Date.now();
  const ch = {
    id: crypto.randomUUID(), name: cleanName(b.name), src: cleanSrc(b.src), show: cleanShow(b.show),
    seasons: cleanSeasons(b.seasons), order: cleanOrder(b.order || "order"), seed: crypto.randomBytes(8).toString("hex"),
    eps: cleanEps(b.eps),
    // from the start of this half hour, the way a channel's day is laid out
    anchor: { t: Math.floor(now / SLOT) * SLOT, pos: 0 }, lead: null,
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
  if (b.name !== undefined) ch.name = cleanName(b.name);
  if (b.seasons !== undefined) ch.seasons = cleanSeasons(b.seasons);
  if (b.eps !== undefined) { ch.eps = cleanEps(b.eps); rerun = true; }
  if (b.order !== undefined && cleanOrder(b.order) !== ch.order) {
    ch.order = b.order;
    ch.seed = crypto.randomBytes(8).toString("hex"); // a fresh shuffle
    rerun = true;
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

// ---------------------------------------------------------- watching, votes
/** channel id -> Map(viewer -> { at, name }) */
const watchers = new Map();
/** channel id -> { pos, restart: Map(viewer -> at), skip: Map(viewer -> at) } */
const votes = new Map();
/** channel id -> { action, at, pos }: the last vote that passed */
const done = new Map();

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

function apply(ch, action, cur, now) {
  if (action === "restart") {
    if (cur.lead) { ch.lead = { i: cur.i, t: now }; ch.anchor = { t: now + durMs(ch, cur.i), pos: ch.anchor.pos }; }
    else { ch.lead = null; ch.anchor = { t: now, pos: cur.pos }; }
  } else {
    ch.lead = null;
    ch.anchor = cur.lead ? { t: now, pos: ch.anchor.pos } : { t: now, pos: cur.pos + 1 };
  }
  votes.delete(ch.id);
  done.set(ch.id, { action, at: now, pos: cur.pos });
  changed();
  log(`channel ${ch.name}: ${action === "skip" ? "skipped" : "started over"} ${ch.eps[cur.i].title || "an episode"} by vote`);
}

/** Count the votes on a channel; carry one out if it has passed. The action
 *  done, or "". */
function settle(ch, now) {
  const v = votes.get(ch.id);
  if (!v) return "";
  const cur = at(ch, now);
  if (!cur || cur.pos !== v.pos) { votes.delete(ch.id); return ""; }
  const viewers = viewersOf(ch.id, now);
  for (const action of ["skip", "restart"]) {
    const m = v[action];
    for (const [who, t] of m) if (now - t > VOTE_FOR || !viewers.has(who)) m.delete(who);
    if (m.size && m.size >= need(viewers.size)) { apply(ch, action, cur, now); return action; }
  }
  if (!v.skip.size && !v.restart.size) votes.delete(ch.id);
  return "";
}

/** What a watching TV is told: the schedule's version, who's watching, the votes. */
function state(ch, viewer, now) {
  const viewers = viewersOf(ch.id, now);
  const v = votes.get(ch.id);
  const cur = at(ch, now);
  const tally = (action) => {
    const m = v ? v[action] : null;
    return { n: m ? m.size : 0, need: need(viewers.size), mine: !!(m && m.has(viewer)) };
  };
  const last = done.get(ch.id);
  return {
    rev: doc.rev, viewers: viewers.size, pos: cur ? cur.pos : null,
    votes: { restart: tally("restart"), skip: tally("skip") },
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

/** A vote to start the episode over or to skip it. `pos`: the episode the TV
 *  is showing (the vote is refused if it has changed since). */
export function vote(id, viewer, name, action, pos) {
  if (action !== "restart" && action !== "skip") throw new ChannelError(400, "Vote to restart or skip");
  const ch = must(id);
  const now = Date.now();
  const cur = at(ch, now);
  if (!cur) throw new ChannelError(409, "Nothing is on this channel right now");
  if (pos != null && pos !== cur.pos) throw new ChannelError(409, "The episode has already changed");
  seen(id, viewer, name, now);
  let v = votes.get(id);
  if (!v || v.pos !== cur.pos) votes.set(id, (v = { pos: cur.pos, restart: new Map(), skip: new Map() }));
  // one vote each: asking for the other thing takes back the first
  v[action === "skip" ? "restart" : "skip"].delete(viewer);
  v[action].set(viewer, now);
  const applied = settle(ch, now);
  return Object.assign(state(ch, viewer, now), { applied });
}

/** Take back a vote. */
export function unvote(id, viewer) {
  const v = votes.get(id);
  if (v) { v.restart.delete(viewer); v.skip.delete(viewer); }
  const ch = must(id);
  return state(ch, viewer, Date.now());
}

export function init() {
  load();
}
