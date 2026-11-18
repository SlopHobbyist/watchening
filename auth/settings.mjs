/*
 * Settings saved on the server, for the accounts service (server.mjs).
 *
 * Each person has a copy of their settings (with sign-in off, the home
 * network shares one, "home"), and admins can keep settings for a group:
 * the people in it get the group's settings whenever an admin updates them,
 * and can change things on their own TVs in between.
 *
 * Plain JSON files under /data/settings (./data on the host):
 *   people/<id>.json  { rev, updated, cfg, groupRev, fromGroup }
 *                     groupRev: the group update they last got
 *                     fromGroup: unchanged since then
 *   groups.json       { groups: [{ id, name, rev, updated, by, cfg }] }
 *   files/<sha256>    uploaded playlist files, named by their content, so a
 *                     group and its people share one copy
 *
 * cfg is the app's settings (Store.cfg in webui/js/store.js) without what
 * belongs to one TV; see webui/js/sync.js. Uploaded playlists name their
 * file in pl.file. rev goes up with every save: a save based on an older rev
 * is refused (another TV saved first), and the TV takes the newer copy.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DIR = process.env.SETTINGS_DIR || "/data/settings";
const PEOPLE = path.join(DIR, "people");
const FILES = path.join(DIR, "files");
const GROUPS = path.join(DIR, "groups.json");
const ID = /^([0-9a-f-]{36}|home)$/i;
export const FILE_ID = /^[0-9a-f]{64}$/;

export function init() {
  for (const d of [PEOPLE, FILES]) fs.mkdirSync(d, { recursive: true });
}

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") console.error(new Date().toISOString(), `couldn't read ${file}: ${e.message}`);
    return fallback;
  }
}
/** Write whole or not at all: a crash mid-write leaves the old copy. */
function write(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ people
function personFile(id) {
  if (!ID.test(id)) throw new Error("bad settings id");
  return path.join(PEOPLE, `${id}.json`);
}
const EMPTY = () => ({ rev: 0, updated: null, cfg: null, groupRev: null, fromGroup: false });

export const person = (id) => Object.assign(EMPTY(), read(personFile(id), {}));
export const removePerson = (id) => fs.rmSync(personFile(id), { force: true });

/** Save someone's settings; null if `baseRev` is out of date. */
export function savePerson(id, cfg, baseRev) {
  const doc = person(id);
  if (baseRev !== doc.rev) return null;
  const next = { rev: doc.rev + 1, updated: new Date().toISOString(), cfg, groupRev: doc.groupRev, fromGroup: false };
  write(personFile(id), next);
  return next;
}

/** Someone's settings, after their group's latest update if they haven't had it yet. */
export function forPerson(id, groupId) {
  let doc = person(id);
  const g = groupId ? group(groupId) : null;
  if (g && g.cfg && doc.groupRev !== g.rev) {
    doc = { rev: doc.rev + 1, updated: new Date().toISOString(), cfg: g.cfg, groupRev: g.rev, fromGroup: true };
    write(personFile(id), doc);
  }
  return { doc, group: g };
}

/** "Use the group's settings again": they get its current copy next time they ask. */
export function rejoin(id) {
  const doc = person(id);
  if (doc.groupRev == null) return;
  doc.groupRev = null;
  write(personFile(id), doc);
}

// ------------------------------------------------------------------ groups
export const groups = () => read(GROUPS, { groups: [] }).groups;
export const group = (id) => groups().find((g) => g.id === id) || null;

/** Change one group (or with `fn` returning "remove", remove it). The changed group, or null. */
export function changeGroup(id, fn) {
  const list = groups();
  const i = list.findIndex((g) => g.id === id);
  if (i < 0) return null;
  const g = list[i];
  if (fn(g) === "remove") list.splice(i, 1);
  write(GROUPS, { groups: list });
  return g;
}

export function addGroup(name) {
  const list = groups();
  const g = { id: crypto.randomUUID(), name, rev: 0, updated: null, by: "", cfg: null };
  list.push(g);
  write(GROUPS, { groups: list });
  return g;
}

/** New settings for a group; null if `baseRev` is given and out of date. */
export function setGroupSettings(id, cfg, by, baseRev) {
  let stale = false;
  const g = changeGroup(id, (x) => {
    if (baseRev !== undefined && baseRev !== x.rev) { stale = true; return; }
    Object.assign(x, { cfg, rev: x.rev + 1, updated: new Date().toISOString(), by });
  });
  return g && !stale ? g : null;
}

// ------------------------------------------------------------------- files
export function putFile(buf) {
  const id = crypto.createHash("sha256").update(buf).digest("hex");
  const file = path.join(FILES, id);
  if (!fs.existsSync(file)) write(file, buf);
  else fs.utimesSync(file, new Date(), new Date()); // just uploaded again: not garbage
  return id;
}
export const filePath = (id) => (FILE_ID.test(id) ? path.join(FILES, id) : null);

/** Remove uploaded files that no saved settings name any more (a day after
 *  they were last uploaded, so one in the middle of being saved is safe). */
export function sweepFiles() {
  const used = new Set();
  const note = (cfg) => {
    for (const pl of (cfg && Array.isArray(cfg.playlists) && cfg.playlists) || []) if (pl && pl.file) used.add(pl.file);
  };
  for (const f of fs.readdirSync(PEOPLE)) if (f.endsWith(".json")) note(read(path.join(PEOPLE, f), {}).cfg);
  for (const g of groups()) note(g.cfg);
  let removed = 0;
  for (const f of fs.readdirSync(FILES)) {
    const p = path.join(FILES, f);
    if (used.has(f)) continue;
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600e3) { fs.rmSync(p, { force: true }); removed++; }
    } catch { /* gone already */ }
  }
  return removed;
}
