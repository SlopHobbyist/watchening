/*
 * Runs before everything else on each `docker compose up` and exits.
 *
 * First start: makes the random secrets (Kratos's cookie and encryption keys,
 * MediaFlow's API password) and keeps them in the auth-secrets volume, so no
 * one has to invent or copy keys by hand. Every start: writes the config files
 * that depend on .env (the site's address) for the services that read them:
 *
 *   /secrets/secrets.json          the secrets (made once, never rewritten)
 *   /secrets/kratos.yml            Kratos: addresses, secrets
 *   /secrets/kratos-flags          Kratos: --dev for a plain-http site
 *   /secrets/mediaflow.env         MediaFlow: API_PASSWORD
 *   /secrets/nginx-mediaflow.conf  nginx: hands MediaFlow its password
 *
 * Files are rewritten in place (not replaced), since the services mount
 * single files out of the volume and a replaced file wouldn't show up there.
 */
import fs from "node:fs";
import crypto from "node:crypto";

const DIR = "/secrets";
const DATA = "/data";

function fail(msg) {
  console.error(`\n  setup: ${msg}\n`);
  process.exit(1);
}

// ----------------------------------------------------------------- address
let raw = (process.env.PUBLIC_URL || "").trim() || "http://localhost:8080";
let site;
try {
  site = new URL(raw);
} catch {
  fail(`PUBLIC_URL in .env isn't a web address: "${raw}". Use something like https://tv.example.com`);
}
if (!/^https?:$/.test(site.protocol)) fail(`PUBLIC_URL must start with http:// or https:// (it is "${raw}")`);
if (site.pathname !== "/" || site.search || site.hash) {
  fail(`PUBLIC_URL must be just the address, without a path: "${site.origin}", not "${raw}"`);
}
const ORIGIN = site.origin;
const HTTPS = site.protocol === "https:";

// ----------------------------------------------------------------- secrets
const token = (n) => crypto.randomBytes(n).toString("base64url").slice(0, n);
const secretsFile = `${DIR}/secrets.json`;
let secrets = {};
try { secrets = JSON.parse(fs.readFileSync(secretsFile, "utf8")); } catch { /* first start */ }
let made = false;
for (const [k, n] of [["kratosCookie", 48], ["kratosCipher", 32], ["mediaflowPassword", 40]]) {
  if (typeof secrets[k] !== "string" || secrets[k].length < n) {
    secrets[k] = token(n);
    made = true;
  }
}
if (secrets.kratosCipher.length !== 32) fail("secrets.json: kratosCipher must be exactly 32 characters");

/** Write in place: keeps the file's inode, so single-file mounts see it. */
function write(path, text, mode = 0o644) {
  const fd = fs.openSync(path, "w", mode);
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
  fs.chmodSync(path, mode);
}

fs.mkdirSync(DIR, { recursive: true });
if (made) write(secretsFile, JSON.stringify(secrets, null, 2) + "\n", 0o600);

// ----------------------------------------------------------------- configs
const y = JSON.stringify; // JSON strings are valid YAML strings
write(`${DIR}/kratos.yml`, `# Written by auth/setup.mjs from .env on every start. Don't edit; it's replaced.

serve:
  public:
    base_url: ${y(ORIGIN + "/kratos/")}
  admin:
    base_url: "http://kratos:4434/"

selfservice:
  default_browser_return_url: ${y(ORIGIN + "/")}
  allowed_return_urls:
    - ${y(ORIGIN + "/")}
  flows:
    login:
      ui_url: ${y(ORIGIN + "/auth/login")}
    registration:
      ui_url: ${y(ORIGIN + "/auth/login")}
    recovery:
      ui_url: ${y(ORIGIN + "/auth/recovery")}
    settings:
      ui_url: ${y(ORIGIN + "/auth/account")}
    error:
      ui_url: ${y(ORIGIN + "/auth/error")}
    logout:
      after:
        default_browser_return_url: ${y(ORIGIN + "/auth/login")}

secrets:
  cookie:
    - ${y(secrets.kratosCookie)}
  cipher:
    - ${y(secrets.kratosCipher)}
`);
// A plain-http site can't have https-only cookies: browsers would drop them
// (except on localhost). Kratos's dev mode turns that off, and it's honored
// only as a command-line flag or env var, not as a key in the config file.
write(`${DIR}/kratos-flags`, HTTPS ? "" : "--dev\n");
// readable by the MediaFlow and nginx users inside their containers
write(`${DIR}/mediaflow.env`, `API_PASSWORD=${secrets.mediaflowPassword}\n`);
write(`${DIR}/nginx-mediaflow.conf`, `proxy_set_header api_password "${secrets.mediaflowPassword}";\n`);

// the accounts service runs as the "node" user and writes the first sign-in file here
try {
  fs.mkdirSync(DATA, { recursive: true });
  fs.chownSync(DATA, 1000, 1000);
} catch (e) {
  console.warn(`setup: couldn't prepare ./data (${e.message}); the first sign-in will only be shown in the logs`);
}

console.log(`setup: ${made ? "made new secrets; " : ""}configured for ${ORIGIN}${HTTPS ? "" : " (plain http)"}`);
