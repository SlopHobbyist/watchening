/*
 * YouTube channels and playlists, for custom channels (channels.mjs): what's
 * in one, and where SponsorBlock says its sponsors and the like are.
 *
 * No API key: the video lists come from the same requests youtube.com's own
 * pages make (its "innertube" API), which answer any server. A channel's
 * uploads are its "UU" playlist (the channel id with UC changed to UU, newest
 * first); a playlist is read the same way, in its own order. Each video in a
 * list has its id, title, running time ("12:34", on the thumbnail) and a line
 * like "1M views • Streamed 2 years ago" (how old it is, roughly, and whether
 * it was a live stream). Shorts look like any other short video there, so a
 * video of 3 minutes or less is checked: youtube.com/shorts/<id> shows a
 * short, and sends anything else on to /watch (that's one small request
 * each, and remembered).
 *
 * The browser can't ask youtube.com these things itself (it doesn't allow
 * other sites' pages to), which is why the accounts service does. Videos are
 * played in YouTube's own embedded player, on each TV.
 *
 * SponsorBlock (sponsor.ajay.app, crowd-sourced, no key): the parts of a
 * video that are a sponsor's message, self promotion, a reminder to like and
 * subscribe, an intro animation or intermission, or the end cards and
 * credits.
 *
 * If YouTube changes its pages, listing stops working (channels made already
 * keep playing what they have), and this is the file to fix.
 */

const YT = "https://www.youtube.com";
const SB = "https://sponsor.ajay.app";
const CLIENT = { clientName: "WEB", clientVersion: "2.20251101.00.00", hl: "en", gl: "US" };
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_VIDEOS = 20000;  // a list longer than this is read this far
const SHORT_MAX = 180;     // shorts are at most 3 minutes

export class YouTubeError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

async function api(endpoint, body) {
  let res;
  try {
    res = await fetch(`${YT}/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      body: JSON.stringify(Object.assign({ context: { client: CLIENT } }, body)),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(`Couldn't reach YouTube (${e.name === "TimeoutError" ? "no answer" : e.message})`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
  return res.json();
}

/** Every object inside `o` (depth first); `f` returning false skips inside it. */
function walk(o, f) {
  if (!o || typeof o !== "object") return;
  if (f(o) === false) return;
  for (const k in o) walk(o[k], f);
}
/** The text pieces inside a view model, in order. */
function texts(o) {
  const out = [];
  walk(o, (x) => { if (typeof x.content === "string") out.push(x.content); else if (typeof x.simpleText === "string") out.push(x.simpleText); });
  return out;
}
/** What a page says is wrong ("This playlist does not exist."), if anything. */
function alertOf(j) {
  let msg = "";
  walk(j && j.alerts, (x) => { if (!msg && x.alertRenderer) msg = texts(x.alertRenderer.text).join(" ") || ""; if (!msg && x.alertWithButtonRenderer) msg = texts(x.alertWithButtonRenderer.text).join(" ") || ""; });
  return msg;
}

// ------------------------------------------------------------ what was pasted
const VIDEO_ID = /^[\w-]{11}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;
const LIST_ID = /^(PL|UU|FL|OL|LL|WL|RD|UL|OLAK5uy_)[\w-]*$/;

/** A link (or id) -> { kind: "playlist", id } | { kind: "channel", id } | { kind: "channel", url }. */
export function parse(input) {
  let s = String(input || "").trim();
  if (!s) throw new YouTubeError("Paste a link to a YouTube channel or playlist");
  if (CHANNEL_ID.test(s)) return { kind: "channel", id: s };
  if (/^@[\w.-]{2,}$/.test(s)) return { kind: "channel", url: `${YT}/${s}` };
  if (/^(PL|OLAK5uy_)[\w-]{10,}$/.test(s)) return { kind: "playlist", id: s };
  if (!/^[a-z]+:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { throw new YouTubeError("That isn't a YouTube link"); }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  if (host !== "youtube.com" && host !== "youtu.be" && host !== "youtube-nocookie.com") throw new YouTubeError("That isn't a YouTube link");
  const list = u.searchParams.get("list");
  if (list) {
    if (/^(RD|WL|LL)/.test(list)) throw new YouTubeError("That's a mix or one of your own private lists, which can't be read: use a playlist or a channel");
    if (!LIST_ID.test(list)) throw new YouTubeError("That playlist link isn't one YouTube makes");
    if (/^UU/.test(list) && list.length === 24) return { kind: "channel", id: "UC" + list.slice(2) };
    return { kind: "playlist", id: list };
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "youtu.be" || parts[0] === "watch" || parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed") {
    throw new YouTubeError("That's a link to one video: paste its channel, or a playlist, instead");
  }
  if (parts[0] === "channel" && CHANNEL_ID.test(parts[1] || "")) return { kind: "channel", id: parts[1] };
  if (parts[0] && (parts[0].startsWith("@") || parts[0] === "c" || parts[0] === "user")) {
    const path = parts[0].startsWith("@") ? parts[0] : `${parts[0]}/${parts[1] || ""}`;
    return { kind: "channel", url: `${YT}/${path}` };
  }
  throw new YouTubeError("Paste a link to a YouTube channel (youtube.com/@name) or a playlist (youtube.com/playlist?list=...)");
}

/**
 * What a link is: { kind, id (UC... for a channel, the playlist's id), title, logo (a picture url, or "") }.
 * Throws a YouTubeError (with a message to show) when it isn't one.
 */
export async function resolve(input) {
  const p = parse(input);
  if (p.kind === "playlist") {
    const j = await api("browse", { browseId: "VL" + p.id });
    const m = j && j.metadata && j.metadata.playlistMetadataRenderer;
    if (!m) throw new YouTubeError(alertOf(j) || "YouTube couldn't find that playlist (is it private?)");
    // the picture: whoever made the videos (the first one's channel)
    let logo = "";
    walk(j.contents, (x) => {
      if (logo) return false;
      if (x.avatarViewModel && x.avatarViewModel.image) { logo = pickImage(x.avatarViewModel.image.sources); return false; }
    });
    return { kind: "playlist", id: p.id, title: m.title || "Playlist", logo };
  }
  let id = p.id;
  if (!id) {
    const r = await api("navigation/resolve_url", { url: p.url });
    id = r && r.endpoint && r.endpoint.browseEndpoint && r.endpoint.browseEndpoint.browseId;
    if (!id || !CHANNEL_ID.test(id)) throw new YouTubeError("YouTube couldn't find that channel");
  }
  const j = await api("browse", { browseId: id });
  const m = j && j.metadata && j.metadata.channelMetadataRenderer;
  if (!m) throw new YouTubeError(alertOf(j) || "YouTube couldn't find that channel");
  return { kind: "channel", id, title: m.title || "YouTube", logo: m.avatar ? pickImage(m.avatar.thumbnails) : "" };
}
/** The picture closest to 88px wide, from YouTube's list of sizes. */
function pickImage(list) {
  if (!Array.isArray(list) || !list.length) return "";
  const best = list.slice().sort((a, b) => Math.abs((a.width || 0) - 88) - Math.abs((b.width || 0) - 88))[0];
  const url = String(best.url || "");
  return url.startsWith("//") ? "https:" + url : /^https:\/\//.test(url) ? url : "";
}

// ------------------------------------------------------------------ videos
/** "1:02:03" -> 3723; null for "LIVE", "UPCOMING" and such. */
function seconds(t) {
  const m = /^(?:(\d+):)?(\d+):(\d\d)$/.exec(String(t || "").trim());
  return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] : null;
}
const UNITS = { second: 1, minute: 60, hour: 3600, day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 };
/** "3 weeks ago" -> roughly that date ("2026-10-29"), or "". */
function agoDate(s, now) {
  const m = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(s);
  return m ? new Date(now - +m[1] * UNITS[m[2].toLowerCase()] * 1000).toISOString().slice(0, 10) : "";
}

/** The videos in one page of a list. */
function pageItems(j, now) {
  const out = [];
  let token = null;
  walk(j, (o) => {
    const l = o.lockupViewModel;
    if (l) {
      if (l.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" && VIDEO_ID.test(l.contentId || "")) {
        let dur = null;
        walk(l.contentImage, (x) => { if (x.thumbnailBadgeViewModel && dur == null) dur = seconds(x.thumbnailBadgeViewModel.text); });
        const md = l.metadata && l.metadata.lockupMetadataViewModel;
        const title = md && md.title ? texts(md.title).join("") : "";
        const lines = md ? texts(md.metadata) : [];
        const age = lines.find((s) => /\bago\b/i.test(s)) || "";
        out.push({
          id: l.contentId, title, dur,
          aired: agoDate(age, now),
          lv: /^Streamed\b/i.test(age),
          members: lines.some((s) => /^Members only$/i.test(s)),
        });
      }
      return false;
    }
    if (o.continuationCommand && typeof o.continuationCommand.token === "string") token = o.continuationCommand.token;
  });
  return { items: out, token };
}

/**
 * Every video in a channel's uploads (newest first) or a playlist (in its
 * order), that can be played: [{ id, title, dur (s), aired ("2024-03-01",
 * roughly), lv (a live stream's replay) }]. (Live now, upcoming, members-only
 * and private videos are left out: they have no running time, or can't be
 * played.) `progress(n)`: called as pages come in.
 */
export async function videos(kind, id, progress) {
  const list = kind === "channel" ? "UU" + id.slice(2) : id;
  const now = Date.now();
  let j = await api("browse", { browseId: "VL" + list });
  if (!j) throw new Error("YouTube couldn't find the list of videos");
  const out = [], seen = new Set(), tokens = new Set();
  let empty = 0;
  for (;;) {
    const { items, token } = pageItems(j, now);
    let added = 0;
    for (const v of items) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      added++;
      if (v.dur != null && v.dur > 0 && !v.members) out.push({ id: v.id, title: v.title, dur: v.dur, aired: v.aired, lv: v.lv });
    }
    if (progress) progress(seen.size);
    // (a page with nothing new twice running: the list has stopped going anywhere)
    empty = added ? 0 : empty + 1;
    if (!token || tokens.has(token) || empty >= 2 || seen.size >= MAX_VIDEOS) break;
    tokens.add(token);
    j = await api("browse", { continuation: token });
    if (!j) break;
  }
  if (!seen.size) {
    const why = alertOf(j);
    if (why) throw new Error(why);
  }
  return out;
}

/** Whether a video is a short: true, false, or null (couldn't tell). */
export async function isShort(id) {
  try {
    const res = await fetch(`${YT}/shorts/${id}`, {
      method: "HEAD", redirect: "manual", headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000),
    });
    if (res.status === 200) return true;
    if (res.status >= 300 && res.status < 400) return /\/watch\b/.test(res.headers.get("location") || "") ? false : null;
    return null;
  } catch {
    return null;
  }
}
export const mightBeShort = (dur) => dur <= SHORT_MAX;

// ------------------------------------------------------------- SponsorBlock
const CUT = ["sponsor", "selfpromo", "interaction"];
const CATEGORIES = [...CUT, "intro", "outro"];

/**
 * Where SponsorBlock says a video's parts are (seconds), from a video `dur`
 * seconds long: { intro: [start, end] | null (an intro animation or
 * intermission, in the first half), credits: start | null (end cards and
 * credits, to the end), cut: [[start, end]] (sponsors, self promotion,
 * reminders to like and subscribe: always left out) }. Throws when
 * SponsorBlock can't be reached (try again later).
 */
export async function segments(id, dur) {
  const q = new URLSearchParams({ videoID: id, categories: JSON.stringify(CATEGORIES), actionTypes: JSON.stringify(["skip"]) });
  let res;
  try {
    res = await fetch(`${SB}/api/skipSegments?${q}`, { headers: { "user-agent": "Watchening (custom channels)" }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error(`Couldn't reach SponsorBlock (${e.message})`);
  }
  const none = { intro: null, credits: null, cut: [] };
  if (res.status === 404) return none;
  if (!res.ok) throw new Error(`SponsorBlock answered ${res.status}`);
  let segs;
  try { segs = await res.json(); } catch { return none; }
  if (!Array.isArray(segs)) return none;
  // segments made against a different cut of the video (its length then
  // was quite different) are for a video that isn't this one any more
  segs = segs.filter((s) => Array.isArray(s.segment) && !(s.videoDuration > 0 && Math.abs(s.videoDuration - dur) > 4));
  const r = (x) => Math.round(Math.max(0, Math.min(dur, +x)) * 1000) / 1000;
  let intro = null, credits = null;
  const cut = [];
  for (const s of segs.slice().sort((a, b) => a.segment[0] - b.segment[0])) {
    const a = r(s.segment[0]), b = r(s.segment[1]);
    if (!(b - a >= 1)) continue;
    if (s.category === "intro") { if (!intro && a < dur / 2) intro = [a, Math.min(b, Math.floor(dur / 2))]; }
    else if (s.category === "outro") { if (credits == null && a > dur / 2 && b >= dur - 4) credits = a; }
    else if (CUT.includes(s.category)) cut.push([a, b]);
  }
  return { intro: intro && intro[1] - intro[0] >= 1 ? intro : null, credits, cut: merge(cut) };
}
/** Overlapping (or touching) spans made one: sorted, none overlapping. */
export function merge(spans) {
  const out = [];
  for (const s of spans.slice().sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 0.5) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}
