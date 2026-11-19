/*
 * Accounts service: the small backend between nginx and Ory Kratos.
 *
 *   GET  /check                    nginx asks this before every request to the
 *                                  app (auth_request): 204 signed in, 401 not,
 *                                  403 outside the home network (sign-in off)
 *   GET  /api/me                   who's signed in, and what this server offers
 *   /api/admin/users...            the Users page (admins only):
 *     GET                            list
 *     POST   {username, name, admin, password?}
 *                                    add; without a password the answer has a
 *                                    one-time link for them to choose their own
 *     PATCH  /:id {username, name, admin, active, password}
 *     DELETE /:id
 *     POST   /:id/link               a new set-a-password link (forgotten password)
 *     POST   /:id/signout            end their sessions on every device
 *   /api/admin/groups...           groups whose settings admins keep (see settings.mjs):
 *     GET | POST {name}              list | add
 *     PATCH  /:id {name}  DELETE /:id
 *     GET | PUT /:id/settings        the group's settings (the TV app, editing them)
 *     POST   /:id/copy {from}        take someone's saved settings as the group's
 *   /api/settings...               the caller's own saved settings (webui/js/sync.js):
 *     GET | PUT {cfg, baseRev}       PUT answers 409 with the newer copy if
 *                                    another TV saved first
 *     POST   /group                  take the group's settings again
 *     POST   /files  GET /files/:id  uploaded playlist files (text)
 *   /api/channels...               channels made from a media server's shows
 *                                  (see channels.mjs, webui/js/channels.js):
 *     GET    ?from&to[&rev]          every channel and its schedule ({ same }
 *                                    when rev is still the latest)
 *     POST   {name, src, show, seasons, order, skip, eps}    make one (admins)
 *     POST   {name, src: {type: "youtube"}, order, yt: {url, shorts, live, rev}}
 *                                    make one from a YouTube channel or
 *                                    playlist: 202 {job} (it takes a while)
 *     POST   /youtube {url}          what a YouTube link is: {kind, id, title}
 *     GET    /jobs/:job              how that's going: {done, msg, error, result}
 *     PATCH  /:id {name, seasons, order, skip, eps, yt: {shorts, live, rev}}
 *                                    DELETE /:id   (admins)
 *     POST   /:id/refresh            a YouTube channel's list, read again: 202 {job}
 *     POST   /:id/watch {viewer}     this TV is watching (every few seconds):
 *                                    who else is, and the votes
 *     POST   /:id/leave {viewer}     it's stopped
 *     POST   /:id/vote {viewer, action, start, arg}   action: restart, prev,
 *                                    skip, next (in order, after this one),
 *                                    seek (arg {to}: seconds in), pause
 *                                    (arg {min}), resume
 *     POST   /:id/unvote {viewer}
 *     POST   /:id/unplayable {viewer, start, code}   YouTube won't play the
 *                                    video on now here: everyone skips it
 *
 * On first start (no accounts yet) it makes an admin account with a random
 * password, prints it and writes it to data/admin-login.txt. That file is
 * deleted once the password has been changed.
 *
 * Command line, for an owner who's locked out:
 *   docker compose exec accounts node server.mjs reset-password <username>
 *
 * Node 22, no dependencies. Settings come from the environment (see
 * docker-compose.yaml); Kratos's admin API is reachable only from here.
 */
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import * as Settings from "./settings.mjs";
import * as Channels from "./channels.mjs";

const AUTH = !/^(off|false|no|0)$/i.test((process.env.AUTH || "on").trim());
const PUBLIC_URL = ((process.env.PUBLIC_URL || "").trim() || "http://localhost:8080").replace(/\/+$/, "");
const KRATOS_PUBLIC = process.env.KRATOS_PUBLIC || "http://kratos:4433";
const KRATOS_ADMIN = process.env.KRATOS_ADMIN || "http://kratos:4434";
const PORT = +process.env.PORT || 3000;
const LOGIN_FILE = "/data/admin-login.txt";
const COOKIE = "watchening_session";
const INVITE_FOR = "72h";

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ kratos
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function kratos(method, path, body) {
  const res = await fetch(KRATOS_ADMIN + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const e = new HttpError(res.status, (data && data.error && (data.error.reason || data.error.message)) || `Kratos answered ${res.status}`);
    e.kratos = data;
    throw e;
  }
  return { data, headers: res.headers };
}

const roleOf = (identity) => (identity.metadata_public && identity.metadata_public.role === "admin" ? "admin" : "user");
function publicUser(i) {
  return {
    id: i.id,
    username: (i.traits && i.traits.username) || "",
    name: (i.traits && i.traits.name) || "",
    admin: roleOf(i) === "admin",
    group: (i.metadata_public && i.metadata_public.group) || "",
    active: i.state !== "inactive",
    created: i.created_at,
  };
}

async function listIdentities() {
  const out = [];
  let token = "";
  for (let page = 0; page < 40; page++) {
    const { data, headers } = await kratos("GET", `/admin/identities?page_size=250${token ? "&page_token=" + encodeURIComponent(token) : ""}`);
    out.push(...(data || []));
    const next = /<[^>]*[?&]page_token=([^&>]+)[^>]*>;\s*rel="next"/.exec(headers.get("link") || "");
    if (!next || !data || data.length < 250) break;
    token = decodeURIComponent(next[1]);
  }
  return out;
}

async function findByUsername(username) {
  const { data } = await kratos("GET", `/admin/identities?credentials_identifier=${encodeURIComponent(username)}`);
  return (data || [])[0] || null;
}

/** A one-time link that signs them in and opens the set-a-password page. */
async function setupLink(id) {
  const { data } = await kratos("POST", "/admin/recovery/link", { identity_id: id, expires_in: INVITE_FOR });
  const u = new URL(data.recovery_link);
  return { link: u.pathname + u.search, expires: data.expires_at };
}

/**
 * A new password. Only a full update (PUT) hashes it: a JSON Patch to
 * /credentials/password/config/password stores it as plain text beside the
 * old hash, which keeps working. PUT replaces everything, so send it all back.
 */
async function setPassword(id, password) {
  const { data: i } = await kratos("GET", `/admin/identities/${id}`);
  const { data } = await kratos("PUT", `/admin/identities/${id}`, {
    schema_id: i.schema_id,
    state: i.state,
    traits: i.traits,
    metadata_public: i.metadata_public,
    metadata_admin: i.metadata_admin,
    credentials: { password: { config: { password } } },
  });
  return data;
}

async function endSessions(id) {
  try { await kratos("DELETE", `/admin/identities/${id}/sessions`); } catch (e) { if (e.status !== 404) throw e; }
  forget(id);
}

// ----------------------------------------------------------------- sessions
/** session cookie -> { user, until }: nginx checks every request, so whoami answers are kept briefly. */
const cache = new Map();
const KEEP_MS = 30e3, KEEP_NO_MS = 3e3;

function cookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

async function sessionUser(req) {
  const tok = cookie(req.headers.cookie, COOKIE);
  if (!tok) return null;
  const now = Date.now();
  const hit = cache.get(tok);
  if (hit && hit.until > now) return hit.user;
  let user = null;
  try {
    const res = await fetch(KRATOS_PUBLIC + "/sessions/whoami", { headers: { cookie: `${COOKIE}=${tok}` } });
    if (res.ok) {
      const s = await res.json();
      if (s.active && s.identity && s.identity.state !== "inactive") user = publicUser(s.identity);
    } else if (res.status >= 500) {
      throw new Error(`whoami answered ${res.status}`);
    }
  } catch (e) {
    log("can't reach Kratos:", e.message);
    throw new HttpError(503, "The sign-in service isn't answering");
  }
  if (cache.size > 5000) for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
  cache.set(tok, { user, until: now + (user ? KEEP_MS : KEEP_NO_MS) });
  return user;
}
/** After an admin changes an account, its cached sessions must not linger. */
function forget(id) {
  for (const [k, v] of cache) if (v.user && v.user.id === id) cache.delete(k);
}

// -------------------------------------------------------------- home network
function ipv4(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? m.slice(1).map(Number) : null;
}
/** Loopback, private, link-local, CGNAT/Tailscale (100.64/10) and IPv6 ULA/link-local. */
function isHomeAddress(ip) {
  ip = String(ip || "").trim().toLowerCase().replace(/^::ffff:/, "");
  const v4 = ipv4(ip);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return ip === "::1" || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}
/** With sign-in off, only the home network gets in. Requests that came
 *  through Cloudflare are from the internet whatever the address says. */
function fromHome(req) {
  if (req.headers["x-cf-connecting-ip"]) return false;
  return isHomeAddress(req.headers["x-real-ip"] || req.socket.remoteAddress);
}

/** Who's asking: { user } signed in, { user: null } not, or a thrown 403. */
async function caller(req) {
  if (!AUTH) {
    if (!fromHome(req)) throw new HttpError(403, "Sign-in is turned off on this server, so it only answers its home network");
    return { user: null };
  }
  return { user: await sessionUser(req) };
}

// --------------------------------------------------------------------- http
function send(res, status, body, headers = {}) {
  const json = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    ...(json ? { "content-type": "application/json; charset=utf-8" } : {}),
    ...headers,
  });
  res.end(json);
}

async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "Too much data");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJson(req, limit = 16384) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw new HttpError(415, "Send JSON");
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString("utf8") || "{}"); } catch { throw new HttpError(400, "That isn't valid JSON"); }
}
const SETTINGS_MAX = 8 << 20;   // settings JSON: big channel orders are a few MB at most
const FILE_MAX = 64 << 20;      // one uploaded playlist (nginx allows the same: client_max_body_size)

/** Changes must come from this site's own pages (no cross-site form posts). */
function sameSite(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin") return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; }
  }
  return true;
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
function cleanUsername(v) {
  const u = String(v || "").trim().toLowerCase();
  if (!USERNAME.test(u)) throw new HttpError(400, "Usernames are 2-32 lowercase letters or numbers (. _ - allowed after the first)");
  return u;
}
function cleanName(v) {
  const n = String(v == null ? "" : v).trim();
  if (n.length > 64) throw new HttpError(400, "Names can be at most 64 characters");
  return n;
}
function cleanPassword(v) {
  const p = String(v || "");
  if (p.length < 8) throw new HttpError(400, "Passwords need at least 8 characters");
  if (p.length > 256) throw new HttpError(400, "That password is too long");
  return p;
}
function cleanGroupName(v) {
  const n = String(v == null ? "" : v).trim();
  if (!n) throw new HttpError(400, "Give the group a name");
  if (n.length > 40) throw new HttpError(400, "Group names can be at most 40 characters");
  return n;
}
function cleanGroup(v) {
  const id = String(v || "");
  if (id && !Settings.group(id)) throw new HttpError(400, "That group doesn't exist any more");
  return id;
}
function cleanCfg(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "Settings must be an object");
  return v;
}
function friendly(e) {
  if (e.status === 409) return new HttpError(409, "Someone already has that username");
  return e;
}

async function adminApi(req, res, me, parts) {
  if (!me) throw new HttpError(401, "Sign in first");
  if (!me.admin) throw new HttpError(403, "Only admins can manage users");
  if (req.method !== "GET" && !sameSite(req)) throw new HttpError(403, "Changes must come from this site");
  if (parts[0] === "groups") return groupsApi(req, res, me, parts);
  const [, id, action] = parts; // users, :id, :action

  if (!id) {
    if (req.method === "GET") {
      const users = (await listIdentities()).map(publicUser).sort((a, b) => a.username.localeCompare(b.username));
      return send(res, 200, { users, me: me.id });
    }
    if (req.method === "POST") {
      const b = await readJson(req);
      const body = {
        schema_id: "user",
        state: "active",
        traits: { username: cleanUsername(b.username), ...(cleanName(b.name) ? { name: cleanName(b.name) } : {}) },
        metadata_public: { role: b.admin ? "admin" : "user", ...(cleanGroup(b.group) ? { group: b.group } : {}) },
      };
      if (b.password) body.credentials = { password: { config: { password: cleanPassword(b.password) } } };
      let created;
      try { created = (await kratos("POST", "/admin/identities", body)).data; } catch (e) { throw friendly(e); }
      log(`${me.username} added ${created.traits.username}${b.admin ? " (admin)" : ""}`);
      const out = { user: publicUser(created) };
      if (!b.password) Object.assign(out, await setupLink(created.id));
      return send(res, 201, out);
    }
    throw new HttpError(405, "Not allowed");
  }

  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "No such user");
  const self = id === me.id;
  const { data: who } = await kratos("GET", `/admin/identities/${id}`);

  if (!action && req.method === "PATCH") {
    const b = await readJson(req);
    const ops = [];
    if (b.username !== undefined) ops.push({ op: "replace", path: "/traits/username", value: cleanUsername(b.username) });
    if (b.name !== undefined) {
      const n = cleanName(b.name);
      if (n) ops.push({ op: "add", path: "/traits/name", value: n });
      else if (who.traits && who.traits.name !== undefined) ops.push({ op: "remove", path: "/traits/name" });
    }
    const meta = { ...(who.metadata_public || {}) };
    if (b.admin !== undefined && !!b.admin !== (roleOf(who) === "admin")) {
      if (self) throw new HttpError(400, "You can't remove your own admin rights. Another admin can.");
      meta.role = b.admin ? "admin" : "user";
    }
    if (b.group !== undefined && cleanGroup(b.group) !== (meta.group || "")) {
      if (b.group) meta.group = b.group; else delete meta.group;
    }
    if (JSON.stringify(meta) !== JSON.stringify(who.metadata_public || {})) ops.push({ op: "replace", path: "/metadata_public", value: meta });
    if (b.active !== undefined && !!b.active !== (who.state !== "inactive")) {
      if (self) throw new HttpError(400, "You can't turn off your own account");
      ops.push({ op: "replace", path: "/state", value: b.active ? "active" : "inactive" });
    }
    const password = b.password ? cleanPassword(b.password) : "";
    if (!ops.length && !password) return send(res, 200, { user: publicUser(who) });
    let updated = who;
    try {
      if (ops.length) updated = (await kratos("PATCH", `/admin/identities/${id}`, ops)).data;
      if (password) updated = await setPassword(id, password);
    } catch (e) { throw friendly(e); }
    // turned off, or a new password set by an admin: sign them out everywhere
    if ((b.active !== undefined && !b.active) || (b.password && !self)) await endSessions(id);
    forget(id);
    log(`${me.username} changed ${updated.traits.username}: ${Object.keys(b).join(", ")}`);
    return send(res, 200, { user: publicUser(updated) });
  }
  if (!action && req.method === "DELETE") {
    if (self) throw new HttpError(400, "You can't remove your own account. Another admin can.");
    await kratos("DELETE", `/admin/identities/${id}`);
    forget(id);
    Settings.removePerson(id);
    log(`${me.username} removed ${who.traits.username}`);
    return send(res, 204);
  }
  if (action === "link" && req.method === "POST") {
    log(`${me.username} made a set-a-password link for ${who.traits.username}`);
    return send(res, 200, await setupLink(id));
  }
  if (action === "signout" && req.method === "POST") {
    await endSessions(id);
    log(`${me.username} signed ${who.traits.username} out everywhere`);
    return send(res, 204);
  }
  throw new HttpError(404, "Not found");
}

// ------------------------------------------------------------------ groups
const groupOut = (g) => ({ id: g.id, name: g.name, rev: g.rev, updated: g.updated, by: g.by, hasSettings: !!g.cfg });

async function groupsApi(req, res, me, parts) {
  const [, id, action] = parts; // groups, :id, :action
  const taken = (name, except) => Settings.groups().some((g) => g.id !== except && g.name.toLowerCase() === name.toLowerCase());
  if (!id) {
    if (req.method === "GET") return send(res, 200, { groups: Settings.groups().map(groupOut).sort((a, b) => a.name.localeCompare(b.name)) });
    if (req.method === "POST") {
      const name = cleanGroupName((await readJson(req)).name);
      if (taken(name)) throw new HttpError(409, "There's already a group called that");
      const g = Settings.addGroup(name);
      log(`${me.username} added the group ${name}`);
      return send(res, 201, { group: groupOut(g) });
    }
    throw new HttpError(405, "Not allowed");
  }
  const g = Settings.group(id);
  if (!g) throw new HttpError(404, "That group doesn't exist any more");

  if (!action && req.method === "PATCH") {
    const name = cleanGroupName((await readJson(req)).name);
    if (taken(name, id)) throw new HttpError(409, "There's already a group called that");
    return send(res, 200, { group: groupOut(Settings.changeGroup(id, (x) => { x.name = name; })) });
  }
  if (!action && req.method === "DELETE") {
    // its people keep the settings they have now
    for (const i of await listIdentities()) {
      if (!i.metadata_public || i.metadata_public.group !== id) continue;
      const meta = { ...i.metadata_public };
      delete meta.group;
      await kratos("PATCH", `/admin/identities/${i.id}`, [{ op: "replace", path: "/metadata_public", value: meta }]);
      forget(i.id);
    }
    Settings.changeGroup(id, () => "remove");
    log(`${me.username} removed the group ${g.name}`);
    return send(res, 204);
  }
  if (action === "settings" && req.method === "GET") {
    return send(res, 200, { ...groupOut(g), cfg: g.cfg });
  }
  if (action === "settings" && req.method === "PUT") {
    const b = await readJson(req, SETTINGS_MAX);
    const saved = Settings.setGroupSettings(id, cleanCfg(b.cfg), me.username, b.baseRev);
    if (!saved) {
      const now = Settings.group(id);
      return send(res, 409, { error: "Someone else changed this group's settings first", ...groupOut(now), cfg: now.cfg });
    }
    return send(res, 200, { rev: saved.rev });
  }
  if (action === "copy" && req.method === "POST") {
    const from = String((await readJson(req)).from || "");
    if (!/^[0-9a-f-]{36}$/i.test(from)) throw new HttpError(400, "Choose whose settings to copy");
    const src = Settings.person(from);
    if (!src.cfg) {
      throw new HttpError(400, from === me.id
        ? "Your settings aren't saved on the server yet. Open the TV once, with Settings > Account > Save Settings on Server on, then try again."
        : "Their settings aren't saved on the server yet: they haven't opened the TV since saving on the server began");
    }
    const saved = Settings.setGroupSettings(id, src.cfg, me.username);
    log(`${me.username} copied settings to the group ${g.name}`);
    return send(res, 200, { group: groupOut(saved) });
  }
  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------- settings
async function settingsApi(req, res, rest) {
  const { user } = await caller(req);
  if (AUTH && !user) throw new HttpError(401, "Sign in first");
  if (req.method !== "GET" && !sameSite(req)) throw new HttpError(403, "Changes must come from this site");
  const id = user ? user.id : "home";
  const current = () => {
    const { doc, group } = Settings.forPerson(id, user && user.group);
    return {
      rev: doc.rev, updated: doc.updated, cfg: doc.cfg,
      group: group ? { id: group.id, name: group.name, hasSettings: !!group.cfg } : null,
      fromGroup: !!(group && doc.fromGroup && doc.groupRev === group.rev),
    };
  };

  if (rest === "" && req.method === "GET") return send(res, 200, current());
  if (rest === "" && req.method === "PUT") {
    const b = await readJson(req, SETTINGS_MAX);
    const saved = Settings.savePerson(id, cleanCfg(b.cfg), b.baseRev);
    if (!saved) return send(res, 409, { error: "Another TV saved first", ...current() });
    return send(res, 200, { rev: saved.rev });
  }
  if (rest === "/group" && req.method === "POST") {
    Settings.rejoin(id);
    return send(res, 200, current());
  }
  if (rest === "/files" && req.method === "POST") {
    const buf = await readBody(req, FILE_MAX);
    if (!buf.length) throw new HttpError(400, "That file is empty");
    return send(res, 201, { id: Settings.putFile(buf) });
  }
  const f = /^\/files\/([^/]+)$/.exec(rest);
  if (f && req.method === "GET") {
    const p = Settings.filePath(f[1]);
    if (!p || !fs.existsSync(p)) throw new HttpError(404, "That file isn't on the server");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=31536000, immutable" });
    fs.createReadStream(p).pipe(res);
    return;
  }
  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------- channels
const VIEWER = /^[a-z0-9-]{8,64}$/i;
async function channelsApi(req, res, rest) {
  const { user } = await caller(req);
  if (AUTH && !user) throw new HttpError(401, "Sign in first");
  if (req.method !== "GET" && !sameSite(req)) throw new HttpError(403, "Changes must come from this site");
  const who = user ? user.username : "home";
  // (with sign-in off, the home network is trusted with everything)
  const editor = () => {
    if (AUTH && !user.admin) throw new HttpError(403, "Only admins can make and change channels");
  };
  const viewer = (b) => {
    const v = String(b.viewer || "");
    if (!VIEWER.test(v)) throw new HttpError(400, "Say which TV this is");
    return `${user ? user.id : "home"}:${v}`;
  };
  const name = user ? user.name || user.username : "";
  try {
    if (rest === "" && req.method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      const rev = q.get("rev");
      if (rev != null && +rev === Channels.rev()) return send(res, 200, { rev: Channels.rev(), same: true });
      const num = (k) => (q.get(k) == null || q.get(k) === "" ? undefined : +q.get(k));
      return send(res, 200, Object.assign(Channels.list(num("from"), num("to")), { edit: !AUTH || !!user.admin, youtube: true }));
    }
    if (rest === "" && req.method === "POST") {
      editor();
      const b = await readJson(req, SETTINGS_MAX);
      if (b && b.src && b.src.type === "youtube") return send(res, 202, { job: Channels.addYoutube(b, who) });
      const ch = Channels.add(b, who);
      return send(res, 201, { id: ch.id, rev: Channels.rev() });
    }
    if (rest === "/youtube" && req.method === "POST") {
      editor();
      return send(res, 200, await Channels.ytLookup((await readJson(req)).url));
    }
    const j = /^\/jobs\/([0-9a-f-]{36})$/i.exec(rest);
    if (j && req.method === "GET") return send(res, 200, Channels.jobState(j[1]));
    const m = /^\/([0-9a-f-]{36})(?:\/(watch|leave|vote|unvote|unplayable|refresh))?$/i.exec(rest);
    if (!m) throw new HttpError(404, "Not found");
    const [, id, action] = m;
    if (!action && req.method === "PATCH") {
      editor();
      Channels.update(id, await readJson(req, SETTINGS_MAX), who);
      return send(res, 200, { rev: Channels.rev() });
    }
    if (!action && req.method === "DELETE") {
      editor();
      Channels.remove(id, who);
      return send(res, 204);
    }
    if (action === "refresh" && req.method === "POST") {
      editor();
      return send(res, 202, { job: Channels.ytRefreshJob(id) });
    }
    if (action && req.method === "POST") {
      const b = await readJson(req);
      const v = viewer(b);
      if (action === "watch") return send(res, 200, Channels.watch(id, v, name));
      if (action === "leave") { Channels.leave(id, v); return send(res, 204); }
      if (action === "unvote") return send(res, 200, Channels.unvote(id, v));
      if (action === "unplayable") return send(res, 200, Channels.unplayable(id, v, name, Number.isFinite(b.start) ? b.start : null, Number.isInteger(b.code) ? b.code : null));
      return send(res, 200, Channels.vote(id, v, name, b.action, Number.isInteger(b.pos) ? b.pos : null, Number.isFinite(b.start) ? b.start : null, b.arg));
    }
    throw new HttpError(405, "Not allowed");
  } catch (e) {
    if (e instanceof Channels.ChannelError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

let warnedProto = false;
let lastFileCheck = 0; // an admin's page loads also check data/admin-login.txt (see checkLoginFile)
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    if (path === "/healthz") return send(res, 200, { ok: true });

    if (path === "/check") {
      if (!warnedProto && PUBLIC_URL.startsWith("http:") && req.headers["x-forwarded-proto"] === "https") {
        warnedProto = true;
        log(`warning: the site is being opened over https, but PUBLIC_URL in .env is ${PUBLIC_URL}. Set it to the https address so sign-in cookies are marked https-only.`);
      }
      const { user } = await caller(req);
      if (AUTH && !user) return send(res, 401);
      return send(res, 204, undefined, user ? { "x-user": user.username } : {});
    }

    if (path === "/api/me") {
      const { user } = await caller(req);
      if (user && user.admin && Date.now() - lastFileCheck > 20e3 && fs.existsSync(LOGIN_FILE)) {
        lastFileCheck = Date.now();
        checkLoginFile();
      }
      // aiostreams: its media server for On Demand (docker-compose.yaml, nginx)
      return send(res, 200, { auth: AUTH, user, streamProxy: "/proxy/", aiostreams: "/jellyfin" });
    }

    if (path === "/api/settings" || path.startsWith("/api/settings/")) return await settingsApi(req, res, path.slice("/api/settings".length));
    if (path === "/api/channels" || path.startsWith("/api/channels/")) return await channelsApi(req, res, path.slice("/api/channels".length));

    const m = /^\/api\/admin\/((?:users|groups)(?:\/[^/]+(?:\/[^/]+)?)?)$/.exec(path);
    if (m) {
      if (!AUTH) throw new HttpError(404, "Sign-in is turned off on this server");
      const { user } = await caller(req);
      return await adminApi(req, res, user, m[1].split("/"));
    }
    throw new HttpError(404, "Not found");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) log(`${req.method} ${path}:`, e.stack || e.message);
    if (!res.headersSent) send(res, status, { error: status >= 500 && !(e instanceof HttpError) ? "Something went wrong" : e.message });
    else res.end();
  }
});

// --------------------------------------------------------------- first start
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // nothing that looks alike on a TV
function password() {
  const bytes = crypto.randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += (i && i % 4 === 0 ? "-" : "") + ALPHABET[bytes[i] % ALPHABET.length];
  return s; // 16 of 31 symbols: ~79 bits
}

function banner(lines) {
  const w = Math.max(...lines.map((l) => l.length));
  const bar = "=".repeat(w + 4);
  console.log(["", bar, ...lines.map((l) => `| ${l.padEnd(w)} |`), bar, ""].join("\n"));
}

async function waitForKratos() {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(KRATOS_ADMIN + "/health/ready");
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (i === 30) log("still waiting for Kratos...");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function firstStart() {
  const { data } = await kratos("GET", "/admin/identities?page_size=1");
  if (data && data.length) return checkLoginFile();
  const pw = password();
  const { data: admin } = await kratos("POST", "/admin/identities", {
    schema_id: "user",
    state: "active",
    traits: { username: "admin", name: "Admin" },
    metadata_public: { role: "admin" },
    credentials: { password: { config: { password: pw } } },
  });
  const text = [
    "Watchening: first sign-in",
    "",
    `Address:   ${PUBLIC_URL}`,
    "Username:  admin",
    `Password:  ${pw}`,
    "",
    "After signing in, change this password: Settings > Account > Change Password.",
    "data/admin-login.txt deletes itself once you have.",
    "",
    "Add everyone else from Settings > Account > Manage Users.",
  ];
  let saved = false;
  try {
    fs.writeFileSync(LOGIN_FILE, text.join("\n") + "\n", { mode: 0o600 });
    saved = true;
  } catch (e) {
    log(`couldn't write ${LOGIN_FILE}: ${e.message}`);
  }
  banner([...text, ...(saved ? ["", "(Also saved in data/admin-login.txt.)"] : [])]);
  log(`made the first admin account (${admin.id})`);
}

/** Deletes data/admin-login.txt once the admin has changed that password. */
async function checkLoginFile() {
  if (!fs.existsSync(LOGIN_FILE)) return;
  try {
    // (renamed, or removed by another admin: the file's password is no use either way)
    const admin = await findByUsername("admin");
    let changed = !admin;
    if (admin) {
      const { data: full } = await kratos("GET", `/admin/identities/${admin.id}?include_credential=password`);
      const c = full.credentials && full.credentials.password;
      changed = !!(c && c.updated_at && Date.parse(c.updated_at) - Date.parse(c.created_at) > 1000);
    }
    if (changed) {
      fs.rmSync(LOGIN_FILE, { force: true });
      log("the first admin password was changed: deleted data/admin-login.txt");
    } else if (!lastFileCheck) {
      log("reminder: data/admin-login.txt still holds the first admin password. Sign in and change it.");
    }
  } catch (e) {
    log("couldn't check data/admin-login.txt:", e.message);
  }
}

// ------------------------------------------------------------- command line
async function cli(args) {
  const [cmd, name] = args;
  if (cmd !== "reset-password" || !name) {
    console.log("Usage: node server.mjs reset-password <username>");
    process.exit(cmd ? 1 : 0);
  }
  const who = await findByUsername(name.toLowerCase());
  if (!who) { console.error(`No account is called "${name}".`); process.exit(1); }
  const pw = password();
  if (who.state !== "active") await kratos("PATCH", `/admin/identities/${who.id}`, [{ op: "replace", path: "/state", value: "active" }]);
  await setPassword(who.id, pw);
  try { await kratos("DELETE", `/admin/identities/${who.id}/sessions`); } catch { /* none */ }
  banner([`New password for ${who.traits.username}:  ${pw}`, "", "They've been signed out everywhere. Change it after signing in."]);
}

if (process.argv.length > 2) {
  await cli(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
} else {
  Settings.init();
  Channels.init();
  const sweep = () => {
    try {
      const n = Settings.sweepFiles();
      if (n) log(`removed ${n} saved playlist file(s) that no settings use any more`);
    } catch (e) { log("couldn't tidy saved playlist files:", e.message); }
  };
  sweep();
  setInterval(sweep, 6 * 3600e3).unref();
  server.listen(PORT, () => log(`accounts: listening on ${PORT}; sign-in ${AUTH ? "on" : "OFF (home network only)"}; site ${PUBLIC_URL}`));
  await waitForKratos();
  try { await firstStart(); } catch (e) { log("first-start setup failed:", e.message); }
  setInterval(checkLoginFile, 3600e3).unref();
}
