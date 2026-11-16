/*
 * Matches zlive.st channels to guide sources, using iptv-org's own data.
 *
 * Everything comes from the iptv-org/epg image this runs in, which iptv-org
 * rebuilds on every change:
 *   temp/data/channels.json, feeds.json,   the iptv-org channel database
 *   countries.json                          (names, alt names, feeds)
 *   sites/<site>/*.channels.xml             which guide site carries which
 *                                           channel, as mapped by iptv-org
 *   SITES.md                                each site's working status
 *
 * A zlive channel is matched by name to an iptv-org channel, and its guide
 * comes only from site entries iptv-org has mapped to that channel. A site's
 * own channel name is never trusted on its own.
 *
 * match(manifest, overrides) -> [{ zlive, name, stream, why, sources }]
 *   stream   iptv-org channel id (with @feed), or null when unmatched
 *   why      when unmatched, the reason; otherwise "" or "override"
 *   sources  guide site entries for it, best first:
 *            { site, site_id, lang, name, xmltv_id, rank }
 *            rank: [wanted feed, feed for that country, language,
 *                   site from that country, main feed, site status],
 *            each 0 = better
 *
 * Run it directly to print a report (defaults: zlive's live channel list and
 * the overrides.json beside this file):
 *   node match.mjs [manifest.json|URL] [overrides.json]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EPG = process.env.EPG_DIR || "/epg";
const DATA = path.join(EPG, "temp/data");

/** Lowercase letters and digits. fold also counts "sports" as "sport". */
export function norm(s, fold) {
  let t = String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ").replace(/\+/g, " plus ");
  if (fold) t = t.replace(/\bsports\b/g, "sport");
  return t.replace(/[^a-z0-9*]/g, "");
}

// Words in a zlive name that say which country's feed it is. iptv-org writes
// the United Kingdom as UK; "MENA" stands for the Arab world.
const PLACE = {
  usa: "US", us: "US", "united states": "US", america: "US",
  uk: "UK", gb: "UK", "united kingdom": "UK", britain: "UK",
  ca: "CA", canada: "CA", au: "AU", australia: "AU", nz: "NZ",
  it: "IT", italia: "IT", italy: "IT", es: "ES", spain: "ES", espana: "ES", espanol: "ES",
  de: "DE", germany: "DE", deutschland: "DE", pt: "PT", portugal: "PT",
  fr: "FR", france: "FR", francais: "FR", pl: "PL", poland: "PL",
  hr: "HR", croatia: "HR", ie: "IE", ireland: "IE", nl: "NL", netherlands: "NL",
  tr: "TR", turkey: "TR", turkiye: "TR", in: "IN", india: "IN",
  sg: "SG", singapore: "SG", qa: "QA", qatar: "QA", za: "ZA",
  sa: "SA", "saudi arabia": "SA", mx: "MX", mexico: "MX", br: "BR", brazil: "BR",
  mena: "MENA", arabic: "MENA",
};
// Words that say nothing about which channel it is.
const NOISE = /\b((backup|test|testj)( \d+)?|fhd|uhd|hd|sd|4k|2k|8k|\d{3,4}p|h\.?26[45]|hevc|feed|raw)\b/gi;
const MENA = new Set(["AE", "BH", "DZ", "EG", "IQ", "JO", "KW", "LB", "LY", "MA", "OM", "PS", "QA", "SA", "SD", "SY", "TN", "YE"]);

// ISO 639-3 (iptv-org feeds and countries) -> ISO 639-1 (site lang).
const LANG = {
  eng: "en", spa: "es", fra: "fr", ita: "it", deu: "de", por: "pt", pol: "pl", hrv: "hr",
  nld: "nl", ara: "ar", tur: "tr", hin: "hi", srp: "sr", bos: "bs", slv: "sl", ces: "cs",
  slk: "sk", hun: "hu", ron: "ro", bul: "bg", ell: "el", swe: "sv", nor: "no", nob: "nb",
  dan: "da", fin: "fi", est: "et", lav: "lv", lit: "lt", rus: "ru", ukr: "uk", heb: "he",
  fas: "fa", urd: "ur", ben: "bn", tam: "ta", tel: "te", mal: "ml", kan: "kn", mar: "mr",
  tha: "th", vie: "vi", ind: "id", msa: "ms", zho: "zh", jpn: "ja", kor: "ko", fil: "tl",
  cat: "ca", eus: "eu", glg: "gl", gle: "ga", cym: "cy", afr: "af", zul: "zu", sqi: "sq",
  mkd: "mk", kat: "ka", hye: "hy", aze: "az", kaz: "kk",
};

function inArea(feed, cc) {
  if (!feed || !cc) return false;
  return (feed.broadcast_area || []).some((a) =>
    a === "c/" + cc ||
    (cc === "MENA" && (a === "r/MENA" || a === "r/ARAB" || MENA.has(a.slice(2)))) ||
    (cc === "US" && (a.startsWith("s/US-") || a.startsWith("ct/US"))));
}

/** Site status from SITES.md: 2 working, 1 partly working, 0 broken. */
function siteStatus() {
  const out = new Map();
  const text = fs.readFileSync(path.join(EPG, "SITES.md"), "utf8");
  for (const m of text.matchAll(/<a href="sites\/([^"]+)">[\s\S]*?<td align="center">([^<]*)<\/td>/g)) {
    out.set(m[1], m[2].includes("🟢") ? 2 : m[2].includes("🟡") ? 1 : 0);
  }
  return out;
}

const unxml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Every mapped <channel> in sites/*\/*.channels.xml of working sites. */
function siteEntries(status) {
  const out = [];
  const sitesDir = path.join(EPG, "sites");
  for (const site of fs.readdirSync(sitesDir)) {
    const st = status.get(site) ?? 0;
    if (st === 0) continue;
    let files;
    try { files = fs.readdirSync(path.join(sitesDir, site)).filter((f) => f.endsWith(".channels.xml")); } catch { continue; }
    for (const f of files) {
      const text = fs.readFileSync(path.join(sitesDir, site, f), "utf8");
      for (const m of text.matchAll(/<channel\s([^>]*)>([^<]*)<\/channel>/g)) {
        const a = {};
        for (const kv of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[kv[1]] = unxml(kv[2]);
        const name = unxml(m[2]).trim();
        if (!a.xmltv_id || !a.site_id || !name) continue;
        out.push({ site: a.site || site, site_id: a.site_id, lang: a.lang || "", name, xmltv_id: a.xmltv_id, status: st });
      }
    }
  }
  return out;
}

let DB = null;
export function load() {
  if (DB) return DB;
  const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
  const status = siteStatus();
  const entries = siteEntries(status);

  const byId = new Map();
  for (const c of read("channels.json")) if (!c.closed && !c.is_nsfw) byId.set(c.id, c);
  const feedsOf = new Map();
  for (const f of read("feeds.json")) {
    if (!byId.has(f.channel)) continue;
    if (!feedsOf.has(f.channel)) feedsOf.set(f.channel, []);
    feedsOf.get(f.channel).push(f);
  }
  const countryLangs = new Map();
  for (const c of read("countries.json")) countryLangs.set(c.code, (c.languages || []).map((l) => LANG[l]).filter(Boolean));

  // Guide entries per channel; and, per site, how many of its channels are
  // from each country (a UK listings site is the better source for a UK
  // channel than an Indian one that also carries it).
  const guidesOf = new Map();
  const siteCountries = new Map();
  for (const e of entries) {
    const [id, feed = ""] = e.xmltv_id.split("@");
    const ch = byId.get(id);
    if (!ch) continue;
    if (!guidesOf.has(id)) guidesOf.set(id, []);
    guidesOf.get(id).push({ ...e, feed });
    if (!siteCountries.has(e.site)) siteCountries.set(e.site, new Map([["", 0]]));
    const sc = siteCountries.get(e.site);
    sc.set(ch.country, (sc.get(ch.country) || 0) + 1);
    sc.set("", sc.get("") + 1);
  }

  // Name -> channel ids, exact and with "sports"/"sport" folded together.
  // Primary names rank 0, alt names 1, the sites' own names 2.
  const names = [new Map(), new Map()];
  const add = (n, id, rank) => {
    for (const fold of [0, 1]) {
      const k = norm(n, fold);
      if (!k) continue;
      const idx = names[fold];
      if (!idx.has(k)) idx.set(k, new Map());
      const m = idx.get(k);
      if (!m.has(id) || m.get(id) > rank) m.set(id, rank);
    }
  };
  for (const c of byId.values()) {
    add(c.name, c.id, 0);
    for (const a of c.alt_names || []) add(a, c.id, 1);
  }
  for (const e of entries) {
    const id = e.xmltv_id.split("@")[0];
    if (byId.has(id)) add(e.name.replace(NOISE, " "), id, 2);
  }
  DB = { byId, feedsOf, guidesOf, names, countryLangs, siteCountries };
  return DB;
}

/**
 * Split a zlive name into the channel's name and where it's from.
 *   strong  country named in the channel name ("Cartoon Network UK")
 *   soft    country from zlive's flag or region field, which are often wrong
 *   local   bracketed part: "[CLEVELAND]", "(Cricket)"
 */
export function parseName(name, flag, region) {
  let s = String(name || "").replace(/\s+/g, " ").trim();
  let local = "";
  s = s.replace(/\[([^\]]*)\]|\(([^)]*)\)/g, (_, a, b) => { local = (a || b || "").trim(); return " "; });
  s = s.replace(NOISE, " ").replace(/\s+/g, " ").trim();
  const words = s.split(" ");
  const keep = [];
  let strong = null;
  for (let i = 0; i < words.length; i++) {
    const one = norm(words[i]);
    const two = (one + " " + norm(words[i + 1] || "")).trim();
    if (i > 0 && PLACE[two] && two.includes(" ")) { strong = strong || PLACE[two]; i++; continue; }
    // Two-letter codes only count as the last word ("Sky Sport 1 NZ"), so
    // the "US" in "US Open" or a channel called "IT" is left alone.
    if (i > 0 && PLACE[one] && (one.length > 2 || i === words.length - 1)) { strong = strong || PLACE[one]; continue; }
    keep.push(words[i]);
  }
  const base = keep.join(" ").replace(/ Extra$/i, "").trim();
  const f = String(flag || "").toLowerCase(), r = norm(region);
  const soft = PLACE[f] || (f.length === 2 ? f.toUpperCase() : null) || PLACE[r] || null;
  return { base, full: s, strong, soft, local };
}

function lookup(db, n, fold) {
  const k = norm(n, fold);
  if (!k) return null;
  if (!k.includes("*")) return db.names[fold].get(k) || null;
  // zlive blanks out letters ("S*perSport"): * stands for one letter
  const re = new RegExp("^" + k.replace(/\*/g, "[a-z0-9]") + "$");
  const out = new Map();
  for (const [nk, m] of db.names[fold]) if (re.test(nk)) for (const [id, r] of m) if (!out.has(id) || out.get(id) > r) out.set(id, r);
  return out.size ? out : null;
}

function candidates(db, p) {
  const tries = [p.full, p.base];
  if (p.local) tries.push(`${p.base} ${p.local}`, `${p.base.split(" ")[0]} ${p.local}`);
  tries.push(`The ${p.base}`);
  for (const fold of [0, 1]) {
    for (const n of tries) {
      const m = lookup(db, n, fold);
      if (m) return m;
    }
  }
  return new Map();
}

const PREFERRED = ["US", "UK", "CA", "AU", "IE"];

function servesCountry(db, id, cc) {
  return db.byId.get(id).country === cc || (db.feedsOf.get(id) || []).some((f) => inArea(f, cc));
}

function pickChannel(db, p, found) {
  let ids = [...found.keys()];
  if (!ids.length) return { why: "no channel by that name in the iptv-org database" };
  // A country in the name is a requirement: better no guide than the wrong one.
  if (p.strong) {
    ids = ids.filter((id) => servesCountry(db, id, p.strong));
    if (!ids.length) return { why: `no ${p.strong} channel by that name` };
  }
  const listed = ids.filter((id) => db.guidesOf.has(id));
  if (!listed.length) return { why: "no working guide site carries it", id: ids.length === 1 ? ids[0] : null };
  ids = listed;
  if (ids.length > 1 && p.soft) {
    const here = ids.filter((id) => servesCountry(db, id, p.soft));
    if (here.length) ids = here;
  }
  if (ids.length > 1) {
    const best = Math.min(...ids.map((id) => found.get(id)));
    ids = ids.filter((id) => found.get(id) === best);
  }
  if (ids.length > 1) {
    for (const cc of PREFERRED) {
      const here = ids.filter((id) => db.byId.get(id).country === cc);
      if (here.length === 1) { ids = here; break; }
    }
  }
  if (ids.length > 1) return { why: "ambiguous: " + ids.slice(0, 4).join(", ") };
  return { id: ids[0] };
}

/** Guide site entries for a channel, best first. Entries in languages
 *  viewers there wouldn't read (Russian listings for a Spanish channel)
 *  are left out. */
function sourcesFor(db, id, place, feedWanted) {
  const ch = db.byId.get(id);
  const feeds = new Map((db.feedsOf.get(id) || []).map((f) => [f.id, f]));
  // the country whose feed we want
  const cc = place && servesCountry(db, id, place) ? place : ch.country;
  const langs = new Set(["en", ...(db.countryLangs.get(cc) || []), ...(db.countryLangs.get(ch.country) || [])]);
  for (const f of feeds.values()) for (const l of f.languages || []) if (LANG[l]) langs.add(LANG[l]);

  const main = [...feeds.values()].find((f) => f.is_main);
  const out = [];
  for (const e of db.guidesOf.get(id) || []) {
    if (e.lang && !langs.has(e.lang)) continue;
    const f = feeds.get(e.feed);
    // the channel's own language first, then English
    const own = ((f || main)?.languages || []).map((l) => LANG[l]);
    const sc = db.siteCountries.get(e.site);
    const share = sc ? (sc.get(cc) || 0) / sc.get("") : 0;
    const rank = [
      feedWanted ? (e.feed === feedWanted ? 0 : 1) : 0,
      place && f && !inArea(f, cc) ? 1 : 0,          // a feed for another country
      own.includes(e.lang) ? 0 : e.lang === "en" ? 1 : 2,
      share >= 0.25 ? 0 : share > 0 ? 1 : 2,          // a site from that country
      f && f.is_main ? 0 : 1,
      2 - e.status,
    ];
    out.push({ e, rank });
  }
  out.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
    return a.e.site.localeCompare(b.e.site);
  });
  const seen = new Set();
  const res = [];
  for (const { e, rank } of out) {
    const k = `${e.site}|${e.site_id}|${e.lang}`;
    if (seen.has(k)) continue;
    seen.add(k);
    res.push({ site: e.site, site_id: e.site_id, lang: e.lang, name: e.name, xmltv_id: e.xmltv_id, rank });
  }
  return res;
}

/**
 * overrides: { "<zlive id>": "Channel.cc" | "Channel.cc@Feed" | null }
 * null leaves that channel without a guide.
 */
export function match(manifest, overrides = {}) {
  const db = load();
  const out = [];
  for (const c of manifest.channels || []) {
    if (!c || typeof c.id !== "string" || !c.id) continue;
    const name = String(c.name || c.id).trim();
    const p = parseName(name, c.flag, c.region);
    let id = null, feed = "", why = "";
    if (Object.prototype.hasOwnProperty.call(overrides, c.id)) {
      const o = overrides[c.id];
      if (!o) why = "override: no guide";
      else {
        [id, feed = ""] = String(o).split("@");
        if (db.byId.has(id)) why = "override";
        else { why = `override ${o} isn't in the iptv-org database`; id = null; }
      }
    } else if (/broken/i.test(name) || norm(p.base).length < 2) {
      why = "not a channel name";
    } else {
      const r = pickChannel(db, p, candidates(db, p));
      if (r.why) why = r.why;
      else id = r.id;
    }
    const sources = id ? sourcesFor(db, id, p.strong || p.soft, feed) : [];
    if (id && !sources.length) why = (why ? why + "; " : "") + `${id}: no working guide site carries it`;
    out.push({ zlive: c.id, name, stream: sources.length ? sources[0].xmltv_id : null, why, sources });
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const src = process.argv[2] || "https://zlive.st/embed/manifest.json";
  const manifest = /^https?:/.test(src) ? await (await fetch(src)).json() : JSON.parse(fs.readFileSync(src, "utf8"));
  const ovFile = process.argv[3] || path.join(path.dirname(new URL(import.meta.url).pathname), "overrides.json");
  const overrides = fs.existsSync(ovFile) ? JSON.parse(fs.readFileSync(ovFile, "utf8")) : {};
  const res = match(manifest, overrides);
  for (const r of res) {
    const s = r.sources[0];
    console.log(`${r.stream ? "+" : "-"} ${r.name.slice(0, 32).padEnd(32)} ${(r.stream || r.why).slice(0, 48).padEnd(48)} ${s ? `${s.site} (${s.lang}) +${r.sources.length - 1}` : ""}`);
  }
  console.log(`\n${res.filter((r) => r.stream).length} of ${res.length} matched`);
}
