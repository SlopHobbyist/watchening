/*
 * Subtitles from the internet, as Plex's "Search for Subtitles" does: when a
 * movie or episode has none (or not in your language), the player asks this
 * server to look the title up on OpenSubtitles, and a subtitle picked from
 * the results is downloaded here and kept with the title. Everyone who plays
 * that title afterwards (anyone on a custom channel playing it, too) finds it
 * in Subtitle Options, as Plex keeps a downloaded subtitle with the video.
 *
 * Where they come from: OpenSubtitles' database, through Stremio's own
 * OpenSubtitles addon (the one Stremio's apps use), which needs no account
 * or API key and sends every file as UTF-8 SRT. It finds titles by IMDb id:
 * the player sends the id the media server has for the title (Plex's and
 * Jellyfin's metadata carry it), else its name and year, which Cinemeta
 * (Stremio's catalog) turns into one. An episode's season and number are
 * checked against IMDb's (see imdbNumbers), which OpenSubtitles goes by.
 *
 * Kept in /data/subtitles: index.json lists each title's downloads
 * ({ titles: { "tt0108778:1:1": [{ id, lang, name, release, at, by }] } }),
 * and files/<id>.srt holds them.
 */
import fs from "node:fs";
import path from "node:path";

const ADDON = (process.env.SUBTITLES_ADDON || "https://opensubtitles-v3.strem.io").replace(/\/+$/, "");
const CINEMETA = "https://v3-cinemeta.strem.io";
const DIR = process.env.SUBTITLES_DIR || "/data/subtitles";
const FILES = path.join(DIR, "files");
const INDEX = path.join(DIR, "index.json");
const UA = "Watchening (subtitle search)";
const FILE_MAX = 4 << 20;         // a subtitle file is ~100 KB; anything this big isn't one
const MAX_FILES = 20000;          // oldest downloads go past this
const FOUND_FOR = 6 * 3600e3;     // a search's results can be downloaded for this long
const SEARCH_FOR = 3600e3;        // the same search within this is answered from memory
const IDS_FOR = 7 * 86400e3;      // a name looked up on Cinemeta

const log = (...a) => console.log(new Date().toISOString(), ...a);

export class SubtitleError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => { throw new SubtitleError(status, msg); };

// ---------------------------------------------------------------- languages
/*
 * OpenSubtitles' codes are ISO 639-2 (eng, fre, ger), which the language
 * names in Node know, plus a few of its own.
 */
const NAMES = new Intl.DisplayNames(["en"], { type: "language" });
const OWN = {
  pob: ["pt-BR", "Portuguese (Brazil)"], pom: ["pt-MZ", "Portuguese (Mozambique)"],
  zht: ["zh-Hant", "Chinese (Traditional)"], zhe: ["zh", "Chinese (bilingual)"], ze: ["zh", "Chinese (bilingual)"],
  chi: ["zh-Hans", "Chinese (Simplified)"], spn: ["es-ES", "Spanish (Spain)"], spl: ["es-419", "Spanish (Latin America)"],
  ea: ["es-419", "Spanish (Latin America)"], mne: ["cnr", "Montenegrin"], sy: ["syr", "Syriac"], ma: ["mni", "Manipuri"],
};
function language(code) {
  const c = String(code || "").toLowerCase();
  if (OWN[c]) return { lang: OWN[c][0], language: OWN[c][1] };
  try {
    const tag = Intl.getCanonicalLocales(c)[0];
    const name = NAMES.of(tag);
    if (name && name !== tag) return { lang: tag, language: name };
  } catch { /* not a language code */ }
  return { lang: c || "und", language: c ? c.toUpperCase() : "Unknown language" };
}

// -------------------------------------------------------------------- store
let store = null;
function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(INDEX, "utf8")); } catch { store = null; }
  if (!store || typeof store.titles !== "object") store = { titles: {} };
  return store;
}
function save() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = INDEX + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, INDEX);
}
const fileOf = (id) => path.join(FILES, id + ".srt");

/** A title's downloads, for the player: numbered within a language. */
function savedOf(key) {
  const list = load().titles[key] || [];
  const seen = {};
  return list.map((x) => {
    const n = (seen[x.language] = (seen[x.language] || 0) + 1);
    return {
      id: x.id, lang: x.lang, language: x.language, name: x.name, release: x.release,
      label: `${x.language} (OpenSubtitles${n > 1 ? " " + n : ""})`,
    };
  });
}

/** Drop the oldest downloads past MAX_FILES (their titles forget them). */
function prune() {
  const all = [];
  for (const [key, list] of Object.entries(store.titles)) for (const x of list) all.push({ key, x });
  if (all.length <= MAX_FILES) return;
  all.sort((a, b) => a.x.at - b.x.at);
  for (const { key, x } of all.slice(0, all.length - MAX_FILES)) {
    store.titles[key] = store.titles[key].filter((y) => y !== x);
    if (!store.titles[key].length) delete store.titles[key];
    if (!inUse(x.id)) fs.rm(fileOf(x.id), { force: true }, () => {});
  }
}
const inUse = (id) => Object.values(store.titles).some((list) => list.some((x) => x.id === id));

// ------------------------------------------------------------------ fetching
async function getJson(href) {
  let res;
  try {
    res = await fetch(href, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  } catch {
    fail(502, "Couldn't reach OpenSubtitles. Try again in a moment");
  }
  if (res.status === 404) return null;
  if (!res.ok) fail(502, `OpenSubtitles answered ${res.status}. Try again in a moment`);
  try { return await res.json(); } catch { fail(502, "OpenSubtitles sent an answer this server doesn't understand"); }
}

const IMDB = /^tt\d{5,10}$/;
const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();

/** A title's IMDb id from its name (and year), through Cinemeta. */
const named = new Map(); // `${type}|${title}|${year}` -> { id, at }
async function imdbFor(type, title, year) {
  const k = `${type}|${norm(title)}|${year || ""}`;
  const hit = named.get(k);
  if (hit && Date.now() - hit.at < IDS_FOR) return hit.id;
  const d = await getJson(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`);
  const metas = ((d && d.metas) || []).filter((m) => IMDB.test(m.imdb_id || m.id || ""));
  const y = (m) => parseInt(String(m.releaseInfo || m.year || ""), 10);
  const same = metas.filter((m) => norm(m.name) === norm(title));
  const pick = (year && same.find((m) => Math.abs(y(m) - year) <= 1)) || same[0] ||
    (year && metas.find((m) => Math.abs(y(m) - year) <= 1)) || null;
  const id = pick ? pick.imdb_id || pick.id : "";
  named.set(k, { id, at: Date.now() });
  if (named.size > 5000) named.delete(named.keys().next().value);
  return id;
}

/*
 * Episode numbers differ between catalogs: Plex and Jellyfin number a show
 * as TheTVDB does, OpenSubtitles as IMDb does, and for some shows they don't
 * agree (Futurama's "A Farewell to Arms" is 7x2 on TheTVDB, 9x2 on IMDb, and
 * IMDb's 7x2 is another episode). So the episode is looked up in Cinemeta's
 * list of the show's episodes (IMDb's numbers) by its title, else by the day
 * it first aired when only one episode did that day; failing both, the
 * numbers stay as they were.
 */
const shows = new Map(); // imdb -> { at, videos: [{ season, episode, t (title, normalized), day }] }
async function episodesOf(imdb) {
  const hit = shows.get(imdb);
  if (hit && Date.now() - hit.at < 86400e3) return hit.videos;
  let videos = [];
  try {
    const d = await getJson(`${CINEMETA}/meta/series/${imdb}.json`);
    videos = (((d && d.meta) || {}).videos || [])
      .filter((v) => Number.isInteger(v.season) && Number.isInteger(v.episode) && v.season > 0)
      .map((v) => ({ season: v.season, episode: v.episode, t: norm(v.name || v.title), day: String(v.released || "").slice(0, 10) }));
  } catch { /* keep the numbers we were given */ }
  shows.set(imdb, { at: Date.now(), videos });
  if (shows.size > 500) shows.delete(shows.keys().next().value);
  return videos;
}
async function imdbNumbers(imdb, season, episode, epTitle, aired) {
  const videos = await episodesOf(imdb);
  if (!videos.length) return { season, episode };
  const t = norm(epTitle);
  const at = videos.find((v) => v.season === season && v.episode === episode);
  if (t && at && at.t === t) return { season, episode };
  const named = t ? videos.filter((v) => v.t === t) : [];
  if (named.length) {
    const v = named.sort((a, b) => Math.abs(a.season - season) - Math.abs(b.season - season))[0];
    return { season: v.season, episode: v.episode };
  }
  const day = /^\d{4}-\d{2}-\d{2}/.test(aired || "") ? aired.slice(0, 10) : "";
  const sameDay = day ? videos.filter((v) => v.day === day) : [];
  if (sameDay.length === 1 && !(at && at.day === day)) return { season: sameDay[0].season, episode: sameDay[0].episode };
  return { season, episode };
}

/**
 * What the player sent -> the title OpenSubtitles knows it as:
 * { key ("tt0108778:1:1" for an episode, "tt0111161" for a movie), type, imdb, season, episode }
 * q: { type, imdb, title, year, season, episode, eptitle (the episode's), aired ("2012-06-20") }
 */
async function titleOf(q) {
  const type = q.type === "series" ? "series" : "movie";
  const int = (v) => (/^\d{1,4}$/.test(String(v ?? "")) ? +v : null);
  let season = int(q.season), episode = int(q.episode);
  const year = int(q.year);
  if (type === "series" && (season == null || episode == null)) fail(400, "Which season and episode is it?");
  let imdb = IMDB.test(q.imdb || "") ? q.imdb : "";
  const title = String(q.title || "").trim().slice(0, 200);
  if (!imdb && title) imdb = await imdbFor(type, title, year);
  if (!imdb) fail(404, `OpenSubtitles doesn't know ${title ? `"${title}"` : "this title"}`);
  if (type === "series") ({ season, episode } = await imdbNumbers(imdb, season, episode, String(q.eptitle || "").slice(0, 200), String(q.aired || "")));
  return { key: type === "series" ? `${imdb}:${season}:${episode}` : imdb, type, imdb, season, episode };
}

// ------------------------------------------------------------------ ranking
/*
 * The results that best fit the video playing come first: ones made for the
 * same release (its group, source and resolution, from the file names).
 */
const NOISE = new Set(["srt", "sub", "subs", "eng", "english", "the", "and", "of", "a", "x264", "h264", "x265", "aac", "ac3"]);
const words = (s) => norm(String(s || "").replace(/\.(srt|sub|vtt|ass|mkv|mp4|avi|m4v)$/i, "")).split(" ").filter((w) => w.length > 1 && !NOISE.has(w));
function fitScore(file, x, title) {
  if (!file) return 0;
  const mine = new Set(words(file));
  const skip = new Set(words(title));
  let n = 0;
  for (const w of new Set([...words(x.subtitleFileName), ...words(x.movieReleaseName)])) {
    if (mine.has(w) && !skip.has(w) && !/^s\d+e\d+$|^\d{4}$/.test(w)) n += x.releaseGroup && norm(x.releaseGroup) === w ? 3 : 1;
  }
  return n;
}

// ------------------------------------------------------------------- search
const found = new Map();    // download id -> { url, key, lang, language, name, release, at }
const searches = new Map(); // key -> { at, list }

function remember(id, x) {
  found.set(id, x);
  if (found.size > 20000) {
    const old = Date.now() - FOUND_FOR;
    for (const [k, v] of found) if (v.at < old || found.size > 20000) found.delete(k); else break;
  }
}

/**
 * A title's subtitles on OpenSubtitles, every language:
 * { key, saved, results: [{ id, lang, language, name, release, fps, fit }] }
 * q: { type: movie | series, imdb, title, year, season, episode, eptitle, aired, file }
 */
export async function search(q) {
  const t = await titleOf(q);
  let s = searches.get(t.key);
  if (!s || Date.now() - s.at > SEARCH_FOR) {
    const d = await getJson(`${ADDON}/subtitles/${t.type}/${t.type === "series" ? t.key : t.imdb}.json`);
    const list = [];
    const ids = new Set();
    for (const x of (d && d.subtitles) || []) {
      const m = /\/file\/(\d{1,15})(?:$|[/?])/.exec(x.url || "");
      let url;
      try { url = new URL(x.url); } catch { continue; }
      if (!m || url.protocol !== "https:" || !/(^|\.)strem\.io$/.test(url.hostname)) continue;
      const id = "os" + m[1];
      if (ids.has(id)) continue;
      // a whole season's pack is listed under each episode: only this one's
      if (t.type === "series" && x.season && x.episode && (+x.season !== t.season || +x.episode !== t.episode)) continue;
      ids.add(id);
      const l = language(x.lang);
      list.push({
        id, ...l, url: url.href, x,
        name: String(x.subtitleFileName || "").slice(0, 300),
        release: String(x.movieReleaseName || "").slice(0, 300),
        fps: x.fpsMilli ? Math.round(x.fpsMilli / 10) / 100 : null,
      });
    }
    s = { at: Date.now(), list };
    searches.set(t.key, s);
    if (searches.size > 2000) searches.delete(searches.keys().next().value);
  }
  const now = Date.now();
  const results = s.list.map((r) => {
    remember(r.id, { url: r.url, key: t.key, lang: r.lang, language: r.language, name: r.name, release: r.release, at: now });
    return { id: r.id, lang: r.lang, language: r.language, name: r.name, release: r.release, fps: r.fps, fit: fitScore(q.file, r.x, q.title) };
  });
  // best fit first; otherwise OpenSubtitles' own order (most downloaded first)
  results.forEach((r, i) => { r.i = i; });
  results.sort((a, b) => b.fit - a.fit || a.i - b.i);
  for (const r of results) delete r.i;
  return { key: t.key, saved: savedOf(t.key), results };
}

/** A title's downloads, without searching: { key, saved }. */
export async function saved(q) {
  const t = await titleOf(q);
  return { key: t.key, saved: savedOf(t.key) };
}

const KEY = /^tt\d{5,10}(:\d{1,4}:\d{1,4})?$/;
const ID = /^os\d{1,15}$/;

/** Download a search result and keep it with its title: { saved, sub }. */
export async function keep(key, id, by) {
  if (!KEY.test(String(key)) || !ID.test(String(id))) fail(400, "Which subtitle?");
  load();
  const list = store.titles[key] || [];
  let x = list.find((y) => y.id === id);
  if (!x) {
    const f = found.get(id);
    if (!f || f.key !== key) fail(404, "That search has expired. Search again");
    if (!fs.existsSync(fileOf(id))) {
      let res;
      try {
        res = await fetch(f.url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
      } catch {
        fail(502, "Couldn't download it from OpenSubtitles. Try again, or pick another");
      }
      if (!res.ok) fail(502, `OpenSubtitles answered ${res.status}. Try again, or pick another`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > FILE_MAX) fail(502, "That file is too big to be a subtitle. Pick another");
      const text = buf.toString("utf8").replace(/^\uFEFF/, "");
      if (!text.includes("-->")) fail(502, "That download isn't a subtitle file. Pick another");
      fs.mkdirSync(FILES, { recursive: true });
      fs.writeFileSync(fileOf(id), text);
    }
    x = { id, lang: f.lang, language: f.language, name: f.name, release: f.release, at: Date.now(), by: String(by || "").slice(0, 64) };
    store.titles[key] = list.concat(x);
    prune();
    save();
    log(`subtitles: ${x.language} ${id} kept for ${key}${by ? ` (${by})` : ""}`);
  }
  const all = savedOf(key);
  return { saved: all, sub: all.find((y) => y.id === id) };
}

/** Forget a download for a title (its file goes when no title has it). */
export function drop(key, id) {
  if (!KEY.test(String(key)) || !ID.test(String(id))) fail(400, "Which subtitle?");
  load();
  const list = store.titles[key] || [];
  if (list.some((x) => x.id === id)) {
    const rest = list.filter((x) => x.id !== id);
    if (rest.length) store.titles[key] = rest; else delete store.titles[key];
    save();
    if (!inUse(id)) fs.rm(fileOf(id), { force: true }, () => {});
  }
  return { saved: savedOf(key) };
}

/** A kept subtitle file's text (SRT). */
export function file(id) {
  if (!ID.test(String(id))) fail(404, "No such subtitle");
  try { return fs.readFileSync(fileOf(id), "utf8"); } catch { fail(404, "No such subtitle"); }
}
