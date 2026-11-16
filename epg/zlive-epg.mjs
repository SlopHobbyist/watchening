/*
 * Builds the guide for zlive.st's channels, on a schedule.
 *
 * Runs inside iptv-org's EPG image (ghcr.io/iptv-org/epg), which carries
 * their grabber, the scrapers for each guide site and the channel database.
 * Each run:
 *   1. fetches zlive's channel list and matches it to iptv-org channels
 *      (match.mjs, plus the corrections in overrides.json)
 *   2. has iptv-org's grabber download listings from each channel's best site
 *   3. retries channels that came back empty on their next-best site
 *   4. keeps the last run's listings for channels that still failed
 *   5. writes OUT_DIR/zlive.xml.gz (XMLTV, channel ids = zlive ids), which
 *      the web UI's zlive playlist names as its guide, and OUT_DIR/status.json
 *
 * Settings (environment):
 *   EPG_DAYS            days of listings to fetch (default 3)
 *   EPG_EVERY_HOURS     hours between runs (default 12)
 *   EPG_MAX_CONNECTIONS requests at once (default 5)
 *   EPG_TRIES           sites tried per channel per run (default 3)
 *   ZLIVE_MANIFEST      zlive's channel list (a URL, or a file path)
 *   EPG_ONCE            set to run once and exit
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { match } from "./match.mjs";

const EPG = process.env.EPG_DIR || "/epg";
const OUT = process.env.OUT_DIR || "/out";
const WORK = process.env.WORK_DIR || "/work";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const MANIFEST = process.env.ZLIVE_MANIFEST || "https://zlive.st/embed/manifest.json";
const DAYS = num(process.env.EPG_DAYS, 3);
const EVERY = num(process.env.EPG_EVERY_HOURS, 12) * 3600e3;
const CONNECTIONS = num(process.env.EPG_MAX_CONNECTIONS, 5);
const TRIES = num(process.env.EPG_TRIES, 3);
// A site that came back empty for a channel is tried last for this long.
const SHUN = 3 * 24 * 3600e3;
// How full each site's listings are (0-1), until runs here measure it:
// the share of programmes with a real description, categories or episode
// details, from a run over zlive's channels in November 2026. Unknown sites
// count as 0.5.
const QUALITY = {
  "tvguide.com": 0.9, "tvpassport.com": 0.9, "guidatv.sky.it": 0.95, "sky.com": 0.85,
  "freeview.co.uk": 0.75, "movistarplus.es": 0.75, "starhubtvplus.com": 0.9, "canalplus.com": 0.7,
  "meo.pt": 0.7, "airtelxstream.in": 0.7, "programtv.onet.pl": 0.7, "nzxmltv.com": 0.85,
  "sky.co.nz": 0.8, "beinsports.com": 0.7, "tvgids.nl": 0.7, "i.mjh.nz": 0.7,
  "ontvtonight.com": 0.35, "mytelly.co.uk": 0.25, "bein.com": 0.3, "nhl.com": 0.4,
  "gatotv.com": 0.1, "teliatv.ee": 0.05, "tvhebdo.com": 0.05,
};

/** 0-1: how much of a programme listing is filled in */
function richness(progs) {
  if (!progs.length) return 0;
  let n = 0;
  for (const p of progs) {
    const d = (p.descriptions && p.descriptions[0] && p.descriptions[0].value) || "";
    const desc = d.length > 25 && !/^\d{1,2}-\d{1,2}-\d{4}/.test(d);
    const more = (p.categories && p.categories.length) || (p.subTitles && p.subTitles.length) || (p.episodeNumbers && p.episodeNumbers.length);
    n += (desc ? 0.75 : 0) + (more ? 0.25 : 0);
  }
  return n / progs.length;
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...a);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function writeAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
const xmlAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const srcKey = (s) => `${s.site}|${s.site_id}|${s.lang}`;

const { EPGGrabber, Channel, Program } = await import(path.join(EPG, "node_modules/epg-grabber/dist/index.js"));

let child = null;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { if (child) child.kill("SIGTERM"); process.exit(0); });
}

async function manifest() {
  const saved = path.join(WORK, "manifest.json");
  try {
    let text;
    if (MANIFEST.startsWith("/")) text = fs.readFileSync(MANIFEST, "utf8");
    else {
      const res = await fetch(MANIFEST, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`zlive answered ${res.status}`);
      text = await res.text();
    }
    const d = JSON.parse(text);
    if (!Array.isArray(d.channels)) throw new Error("not a zlive channel list");
    writeAtomic(saved, text);
    return d;
  } catch (e) {
    const d = readJson(saved, null);
    if (!d) throw e;
    log(`couldn't fetch zlive's channel list (${e.message}); using the saved copy`);
    return d;
  }
}

/** Run iptv-org's grabber over these site entries; -> Map(xmltv_id -> programs) */
function grab(entries, pass) {
  const channelsFile = path.join(WORK, "channels.xml");
  const json = path.join(WORK, "pass.json");
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n' +
    entries.map((e) =>
      `  <channel site="${xmlAttr(e.site)}" site_id="${xmlAttr(e.site_id)}" lang="${xmlAttr(e.lang)}" xmltv_id="${xmlAttr(e.xmltv_id)}">${xmlAttr(e.name)}</channel>`
    ).join("\n") + "\n</channels>\n";
  fs.writeFileSync(channelsFile, xml);
  try { fs.unlinkSync(json); } catch {}
  const args = [
    "-r", "@swc-node/register", "scripts/commands/epg/grab.ts",
    `--channels=${channelsFile}`, `--output=${path.join(WORK, "pass.xml")}`, `--json=${json}`,
    `--days=${DAYS}`, `--maxConnections=${CONNECTIONS}`,
  ];
  log(`pass ${pass}: grabbing ${entries.length} channel(s) from ${new Set(entries.map((e) => e.site)).size} site(s)`);
  return new Promise((resolve) => {
    child = spawn("node", args, { cwd: EPG, stdio: ["ignore", "pipe", "pipe"] });
    let errors = 0;
    const tail = [];
    const onLine = (line) => {
      if (/ERR:/.test(line)) errors++;
      tail.push(line);
      if (tail.length > 20) tail.shift();
    };
    let buf = "";
    const feed = (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("close", (code) => {
      child = null;
      const out = new Map();
      const d = readJson(json, null);
      if (!d) {
        log(`pass ${pass}: the grabber stopped (exit ${code}) without a guide:\n  ` + tail.slice(-8).join("\n  "));
        return resolve(out);
      }
      for (const p of d.programs || []) {
        if (!out.has(p.channel)) out.set(p.channel, []);
        out.get(p.channel).push(p);
      }
      log(`pass ${pass}: ${(d.programs || []).length} programmes for ${out.size} channel(s), ${errors} failed request(s)`);
      resolve(out);
    });
  });
}

async function run() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const started = Date.now();
  const m = await manifest();
  const overrides = readJson(path.join(HERE, "overrides.json"), {});
  const matched = match(m, overrides);
  const state = readJson(path.join(WORK, "state.json"), {});
  state.shunned = state.shunned || {};
  state.quality = state.quality || {};
  const now = Date.now();
  for (const [k, t] of Object.entries(state.shunned)) if (now - t > SHUN) delete state.shunned[k];
  const quality = (site) => state.quality[site] ?? QUALITY[site] ?? 0.5;

  // Order each channel's sites: the matcher's feed and language preferences
  // first, then sites that worked lately, then sites from the channel's
  // country, then the fullest listings.
  const order = (sources) => sources
    .map((s) => ({ s, k: [...s.rank.slice(0, 3), state.shunned[srcKey(s)] ? 1 : 0, s.rank[3], -quality(s.site), ...s.rank.slice(4)] }))
    .sort((a, b) => { for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i]; return 0; })
    .map((x) => x.s);

  // One grab per iptv-org stream, however many zlive channels show it.
  const streams = new Map();
  for (const r of matched) {
    if (!r.stream) continue;
    if (!streams.has(r.stream)) {
      streams.set(r.stream, { sources: order(r.sources).slice(0, TRIES), next: 0, programs: null, source: null, zlive: [] });
    }
    streams.get(r.stream).zlive.push(r);
  }
  log(`${matched.length} zlive channels, ${[...streams.values()].reduce((n, s) => n + s.zlive.length, 0)} matched to ${streams.size} guide channels`);

  const measured = new Map(); // site -> [programmes, richness sum]
  for (let pass = 1; pass <= TRIES; pass++) {
    const todo = [...streams.entries()].filter(([, s]) => !s.programs && s.next < s.sources.length);
    if (!todo.length) break;
    const entries = todo.map(([id, s]) => {
      const { rank, ...src } = s.sources[s.next++];
      return { ...src, xmltv_id: id };
    });
    const got = await grab(entries, pass);
    for (const [id, s] of todo) {
      const src = s.sources[s.next - 1];
      const progs = got.get(id);
      if (progs && progs.length) {
        s.programs = progs; s.source = src; delete state.shunned[srcKey(src)];
        const m = measured.get(src.site) || [0, 0];
        m[0] += progs.length; m[1] += richness(progs) * progs.length;
        measured.set(src.site, m);
      } else state.shunned[srcKey(src)] = now;
    }
  }
  // Learn how full each site's listings are, slowly, so one odd day doesn't
  // reorder everything.
  for (const [site, [n, sum]] of measured) {
    if (n < 20) continue;
    state.quality[site] = Math.round((0.7 * quality(site) + 0.3 * (sum / n)) * 1000) / 1000;
  }

  // Channels that got nothing this time keep what the last run found.
  const last = readJson(path.join(WORK, "last.json"), {});
  const keep = {};
  let reused = 0;
  for (const [id, s] of streams) {
    if (!s.programs && last[id]) {
      const left = last[id].programs.filter((p) => p.stop > now);
      if (left.length) { s.programs = left; s.source = last[id].source; s.stale = true; reused++; }
    }
    if (s.programs) keep[id] = { source: s.source, programs: s.programs };
  }
  writeAtomic(path.join(WORK, "last.json"), JSON.stringify(keep));
  writeAtomic(path.join(WORK, "state.json"), JSON.stringify(state));

  // The guide, with zlive's ids so the web UI finds each channel directly.
  const channels = [], programs = [];
  for (const [, s] of streams) {
    if (!s.programs) continue;
    for (const r of s.zlive) {
      channels.push(new Channel({ xmltv_id: r.zlive, name: r.name, site: s.source.site, site_id: s.source.site_id, lang: s.source.lang }));
      for (const p of s.programs) {
        try { programs.push(new Program({ ...p, channel: r.zlive })); } catch { /* malformed entry */ }
      }
    }
  }
  programs.sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : a.start - b.start));
  const xmltv = EPGGrabber.generateXMLTV(channels, programs, { "generator-info-name": "watchening zlive-epg (iptv-org/epg)" });
  writeAtomic(path.join(OUT, "zlive.xml.gz"), zlib.gzipSync(xmltv, { level: 9 }));

  const status = {
    generated: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    days: DAYS,
    channels: matched.length,
    withGuide: channels.length,
    reusedFromLastRun: reused,
    programmes: programs.length,
    list: matched.map((r) => {
      const s = r.stream && streams.get(r.stream);
      return {
        zlive: r.zlive, name: r.name, stream: r.stream,
        site: s && s.source ? s.source.site : null,
        programmes: s && s.programs ? s.programs.length : 0,
        ...(s && s.stale ? { stale: true } : {}),
        ...(r.why && r.why !== "override" ? { note: r.why } : {}),
        ...(s && !s.programs ? { note: "no listings from: " + s.sources.map((x) => x.site).join(", ") } : {}),
      };
    }),
  };
  writeAtomic(path.join(OUT, "status.json"), JSON.stringify(status, null, 1));
  log(`guide written: ${channels.length} of ${matched.length} zlive channels, ${programs.length} programmes` +
    (reused ? ` (${reused} kept from the last run)` : "") + ` in ${status.seconds}s`);
}

for (;;) {
  const t = Date.now();
  try { await run(); } catch (e) { log("run failed:", e && e.stack || e); }
  if (process.env.EPG_ONCE) break;
  const wait = Math.max(60e3, EVERY - (Date.now() - t));
  log(`next run in ${Math.round(wait / 60e3)} min`);
  await new Promise((r) => setTimeout(r, wait));
}
