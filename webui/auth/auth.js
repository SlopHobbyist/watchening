/*
 * Sign-in, account and Users pages. Plain script, no build; talks to Ory
 * Kratos's browser API at /kratos/ (same address, so its cookies are ours) and
 * to the accounts service at /api/.
 *
 *   /auth/login      sign in (?refresh=true: confirm it's you; ?return_to=<path>
 *                    must be last: everything after it is the path, as nginx
 *                    passes it unencoded)
 *   /auth/account    your account: change your password, sign out
 *   /auth/users      admins: add people, links to set a password, edit, remove;
 *                    groups, whose settings their people get (/?group=<id>
 *                    opens the TV to set them up; see ../js/sync.js)
 *   /auth/recovery   where a used or expired set-a-password link lands
 *   /auth/error      Kratos's error page
 *   /auth/logout     signs out, then back to sign-in
 *
 * Kratos flows are fetched and submitted as JSON and drawn from their "nodes"
 * (fields, buttons, messages). Arrow keys move between fields and buttons, so
 * a TV remote works, and a small TV-shaped screen gets the page scaled to fit
 * like the guide (see fit() below).
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const box = $("box"), titleEl = $("title"), bodyEl = $("body");
  const K = "/kratos";

  // ------------------------------------------------------------------ dom
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k in e && typeof v !== "string") e[k] = v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
    return e;
  }
  function page(title, ...kids) {
    document.title = `${title} · TV Listings`;
    titleEl.textContent = title;
    bodyEl.replaceChildren(...kids.flat().filter(Boolean));
    const first = [...bodyEl.querySelectorAll("input:not([type=hidden]):not([hidden]):not(:disabled), button:not(:disabled), a.btn")][0];
    if (first) first.focus({ preventScroll: true });
  }
  const p = (text, cls) => el("p", { class: cls, text });
  const msg = (text, type) => el("div", { class: "msg " + (type || "info"), text, role: type === "error" ? "alert" : null });
  const button = (label, onclick, cls) => el("button", { type: "button", class: cls, text: label, onclick });
  const linkBtn = (label, href, cls) => el("a", { class: "btn" + (cls ? " " + cls : ""), href, text: label });
  const buttons = (...kids) => el("div", { class: "buttons" }, ...kids);
  const go = (path) => location.assign(path);

  // ------------------------------------------------------------------ http
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: Object.assign({ Accept: "application/json" }, body ? { "Content-Type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      return { status: 0, data: { error: "Couldn't reach the server" } };
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data: data || {} };
  }
  const errText = (r) => (r.data && (typeof r.data.error === "string" ? r.data.error : r.data.error && (r.data.error.reason || r.data.error.message))) ||
    (r.status === 429 ? "Too many tries. Wait a minute, then try again." : `Something went wrong (${r.status})`);

  /** A path on this site, from a Kratos URL (which names the address in .env). */
  function rel(u) {
    try {
      const x = new URL(u, location.href);
      return x.pathname + x.search + x.hash;
    } catch { return "/"; }
  }
  /** Where to go after signing in: return_to (a path on this site) or the guide. */
  function returnTo(flow) {
    let r = "";
    if (flow && flow.return_to) r = rel(flow.return_to);
    else {
      const s = location.search, i = s.indexOf("return_to=");
      if (i >= 0) r = s.slice(i + 10);
    }
    if (!/^\/(?![\/\\])/.test(r) || /^\/auth\/(login|logout)/.test(r)) r = "/";
    return r;
  }
  const here = () => location.pathname + location.search;

  // --------------------------------------------------------------- kratos
  const TEXT = {
    4000006: "That username and password don't match.",
    1010003: "Enter your password again to continue.",
    1060001: "Choose a password to finish.",
    1050001: "Your new password is saved.",
  };
  function text(m) {
    if (TEXT[m.id]) return TEXT[m.id];
    if (/recovery|token|link/i.test(m.text) && /invalid|used|expired/i.test(m.text)) {
      return "This link has expired or was already used. Ask an admin for a new one.";
    }
    return m.text;
  }
  const messages = (list) => (list || []).map((m) => msg(text(m), m.type));

  /** Handles a Kratos answer that isn't a flow to draw. True if it navigated. */
  function follow(r) {
    const d = r.data || {};
    const to = d.redirect_browser_to || (d.error && d.error.details && d.error.details.redirect_to);
    if (to) { go(rel(to)); return true; }
    const id = (d.error && d.error.id) || "";
    if (id === "session_already_available") { go(returnTo()); return true; }
    if (id === "session_inactive" || (r.status === 401 && location.pathname !== "/auth/login")) {
      go("/auth/login?return_to=" + here());
      return true;
    }
    if (id === "self_service_flow_expired" || id === "security_csrf_violation" || r.status === 410) {
      // start this page over with a new flow
      const q = new URLSearchParams(location.search);
      if (q.has("flow")) {
        q.delete("flow");
        go(location.pathname + (q.toString() ? "?" + q : ""));
        return true;
      }
    }
    return false;
  }

  /** The flow in ?flow=, or a new one. Null if it navigated somewhere instead. */
  async function getFlow(kind, params) {
    const id = new URLSearchParams(location.search).get("flow");
    if (id) {
      const r = await api("GET", `${K}/self-service/${kind}/flows?id=${encodeURIComponent(id)}`);
      if (r.status === 200) return r.data;
      if (follow(r)) return null;
    }
    const r = await api("GET", `${K}/self-service/${kind}/browser${params ? "?" + params : ""}`);
    if (r.status === 200) return r.data;
    if (follow(r)) return null;
    throw new Error(errText(r));
  }

  /**
   * A flow's fields and messages as a form. opts: { groups, submit (label),
   * kind ("login" | "settings"), done(data, form) on success }.
   */
  function flowForm(flow, opts) {
    const form = el("form", { novalidate: true });
    const hidden = {}, inputs = [];
    let method = "";
    form.append(...messages(flow.ui.messages));
    // lets a password manager file the new password under the right account
    if (opts.username) form.append(el("input", { type: "text", autocomplete: "username", value: opts.username, hidden: true, readonly: true, tabindex: "-1" }));
    for (const n of flow.ui.nodes) {
      if (n.type !== "input" || !opts.groups.includes(n.group)) continue;
      const a = n.attributes;
      if (a.type === "hidden") { hidden[a.name] = a.value; continue; }
      if (a.type === "submit" || a.type === "button") { if (a.name === "method") method = a.value; continue; }
      const isId = a.name === "identifier";
      const input = el("input", {
        name: a.name,
        type: a.type === "password" ? "password" : "text",
        value: a.value || "",
        required: !!a.required,
        autocomplete: isId ? "username" : a.type === "password" ? (opts.kind === "login" ? "current-password" : "new-password") : "off",
        autocapitalize: "none", autocorrect: "off", spellcheck: "false",
      });
      inputs.push(input);
      const label = (n.meta && n.meta.label && n.meta.label.text) || a.name;
      form.append(el("label", {},
        el("span", { text: a.name === "password" && opts.kind === "settings" ? "New password" : label }),
        input,
        ...(n.messages || []).map((m) => el("span", { class: "field-msg", text: text(m) }))));
    }
    const submit = el("button", { type: "submit", class: "main", text: opts.submit });
    form.append(buttons(submit, ...(opts.extra || [])));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = Object.assign({}, hidden, method ? { method } : {});
      for (const i of inputs) body[i.name] = i.name === "identifier" ? i.value.trim().toLowerCase() : i.value;
      submit.disabled = true;
      const r = await api("POST", rel(flow.ui.action), body);
      submit.disabled = false;
      if (r.status === 200) return opts.done(r.data, form);
      if (r.status === 400 && r.data && r.data.ui) return form.replaceWith(flowForm(r.data, opts));
      if (follow(r)) return;
      form.querySelectorAll(".msg").forEach((m) => m.remove());
      form.prepend(msg(errText(r), "error"));
    });
    return form;
  }

  // ---------------------------------------------------------------- pages
  async function me() {
    const r = await api("GET", "/api/me");
    if (r.status === 403) throw new Error(errText(r));
    return r.data || {};
  }

  function authOff() {
    page("Sign-In Is Off",
      p("Sign-in is turned off on this server, so there are no accounts. Anyone on your home network can use it."),
      buttons(linkBtn("Go to TV", "/")));
  }

  async function login() {
    const m = await me();
    if (m.auth === false) return authOff();
    const refresh = new URLSearchParams(location.search).get("refresh") === "true";
    if (m.user && !refresh) return go(returnTo());
    const flow = await getFlow("login", refresh ? "refresh=true" : "");
    if (!flow) return;
    const again = refresh || flow.refresh;
    page(again ? "Confirm It's You" : "Sign In",
      flowForm(flow, {
        groups: ["default", "password"], kind: "login", submit: again ? "Continue" : "Sign In",
        done: () => go(returnTo(flow)),
      }),
      p(again ? "" : "Forgot your password? An admin can send you a link to set a new one.", "note"));
  }

  async function account() {
    const m = await me();
    if (m.auth === false) return authOff();
    if (!m.user) return go("/auth/login?return_to=/auth/account");
    const flow = await getFlow("settings");
    if (!flow) return;
    const u = m.user;
    const welcome = (flow.ui.messages || []).some((x) => x.id === 1060001);
    const nav = buttons(
      linkBtn("Go to TV", "/"),
      u.admin && linkBtn("Manage Users", "/auth/users"),
      linkBtn("Sign Out", "/auth/logout"));
    // saved: Kratos answers with the flow again, now carrying "saved"
    const opts = {
      groups: ["default", "password"], kind: "settings", submit: "Save Password", username: u.username,
      done: (data, f) => {
        f.replaceWith(flowForm(data, opts));
        nav.querySelector("a").focus();
      },
    };
    page(welcome ? "Welcome" : "Your Account",
      el("p", {}, "Signed in as ", el("strong", { text: u.name || u.username }), u.name ? ` (${u.username})` : "", u.admin ? el("span", { class: "tag", text: "Admin" }) : null),
      el("h2", { text: welcome ? "Choose a Password" : "Change Password" }),
      flowForm(flow, opts),
      el("div", { style: "height:18px" }),
      nav);
  }

  async function recovery() {
    let flow = null;
    const id = new URLSearchParams(location.search).get("flow");
    if (id) {
      const r = await api("GET", `${K}/self-service/recovery/flows?id=${encodeURIComponent(id)}`);
      if (r.status === 200) flow = r.data;
    }
    const msgs = flow ? messages(flow.ui.messages) : [];
    page("Set a Password",
      msgs.length ? msgs : msg("This link has expired or was already used. Ask an admin for a new one.", "error"),
      p("Set-a-password links work once, for a few days. An admin can make a new one on the Users page.", "note"),
      buttons(linkBtn("Sign In", "/auth/login")));
  }

  async function error() {
    const id = new URLSearchParams(location.search).get("id");
    let t = "Something went wrong while signing in.";
    if (id) {
      const r = await api("GET", `${K}/self-service/errors?id=${encodeURIComponent(id)}`);
      const e = r.data && r.data.error;
      if (e) t = e.reason || e.message || t;
    }
    page("Problem Signing In", msg(t, "error"), buttons(linkBtn("Try Again", "/auth/login"), linkBtn("Go to TV", "/")));
  }

  async function logout() {
    page("Signing Out", p("Signing out...", "note"));
    const r = await api("GET", `${K}/self-service/logout/browser`);
    if (r.status === 200 && r.data.logout_token) {
      await api("GET", `${K}/self-service/logout?token=${encodeURIComponent(r.data.logout_token)}`);
    }
    go("/auth/login");
  }

  // ---------------------------------------------------------------- users
  async function users() {
    const m = await me();
    if (m.auth === false) return authOff();
    if (!m.user) return go("/auth/login?return_to=/auth/users");
    if (!m.user.admin) {
      return page("Users", p("Only admins can manage users."), buttons(linkBtn("Your Account", "/auth/account"), linkBtn("Go to TV", "/")));
    }
    box.classList.add("wide");
    const myId = m.user.id;
    let list = [], groups = [];
    const top = el("div");       // messages and the add/edit/link panels
    const people = el("div"), groupsEl = el("div");

    async function load(note) {
      const [r, g] = await Promise.all([api("GET", "/api/admin/users"), api("GET", "/api/admin/groups")]);
      if (r.status !== 200 || g.status !== 200) { top.replaceChildren(msg(errText(r.status !== 200 ? r : g), "error")); return; }
      list = r.data.users;
      groups = g.data.groups;
      draw();
      if (note) top.replaceChildren(note);
    }
    const name = (u) => u.name || u.username;
    const groupName = (id) => (groups.find((g) => g.id === id) || {}).name || "";
    const membersOf = (g) => list.filter((u) => u.group === g.id);
    const fmtDate = (s) => new Date(s).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const fmtDay = (s) => new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });

    function draw() {
      people.replaceChildren(el("table", { class: "users" },
        el("tbody", {}, list.map((u) => el("tr", {},
          el("td", {},
            el("div", { text: name(u) }, u.id === myId ? el("span", { class: "tag", text: "You" }) : null, !u.active ? el("span", { class: "tag off", text: "Off" }) : null),
            el("div", { class: "who", text: [u.username, u.admin ? "Admin" : "Viewer", groupName(u.group)].filter(Boolean).join(" · ") })),
          el("td", { class: "acts" }, buttons(button("Edit", () => editPanel(u), "small"))))))));
      groupsEl.replaceChildren(groups.length
        ? el("table", { class: "users" }, el("tbody", {}, groups.map((g) => {
          const n = membersOf(g).length;
          return el("tr", {},
            el("td", {},
              el("div", { text: g.name }, !g.hasSettings ? el("span", { class: "tag off", text: "Not Set Up" }) : null),
              el("div", { class: "who", text: [`${n} ${n === 1 ? "person" : "people"}`, g.hasSettings && g.updated ? `updated ${fmtDay(g.updated)}${g.by ? " by " + g.by : ""}` : ""].filter(Boolean).join(" · ") })),
            el("td", { class: "acts" }, buttons(
              linkBtn("Set Up on TV", "/?group=" + encodeURIComponent(g.id), "small"),
              button("Edit", () => groupPanel(g), "small"))));
        })))
        : p("No groups yet.", "note"));
    }

    function panel(title, ...kids) {
      const pnl = el("div", { class: "panel" }, el("h2", { text: title }), ...kids);
      top.replaceChildren(pnl);
      const f = pnl.querySelector("input:not([type=hidden]):not(:disabled), button");
      if (f) f.focus();
      pnl.scrollIntoView({ block: "nearest" });
      return pnl;
    }
    const done = () => { top.replaceChildren(); };
    const field = (label, attrs) => {
      const input = el("input", Object.assign({ type: "text", autocapitalize: "none", autocorrect: "off", spellcheck: "false", autocomplete: "off" }, attrs));
      return { input, label: el("label", {}, el("span", { text: label }), input) };
    };
    const check = (label, checked, disabled) => {
      const input = el("input", { type: "checkbox", checked, disabled });
      return { input, label: el("label", { class: "check" }, input, el("span", { text: label })) };
    };
    /** One of several, as buttons (a remote can't work a drop-down list well). */
    function pick(label, options, value) {
      let cur = value;
      const btns = options.map((o) => {
        const b = button(o.label, () => { cur = o.value; mark(); }, "small pick");
        b.dataset.v = o.value;
        return b;
      });
      const mark = () => btns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === cur)));
      mark();
      return { get value() { return cur; }, el: el("div", { class: "field" }, el("span", { class: "lbl", text: label }), el("div", { class: "buttons picks" }, btns)) };
    }
    const groupPick = (value) => pick("Group", [{ value: "", label: "None" }].concat(groups.map((g) => ({ value: g.id, label: g.name }))), value || "");

    function showLink(u, data, lead) {
      const url = location.origin + data.link;
      const out = el("input", { type: "text", class: "link", value: url, readonly: true });
      panel(`Sign-In Link for ${name(u)}`,
        p(lead || `Send ${name(u)} this link. It signs them in once so they can choose a new password.`),
        out,
        p(`It works once, until ${fmtDate(data.expires)}. Anyone with it can sign in as ${u.username}, so send it privately.`, "note"),
        buttons(button("Copy Link", async (e) => {
          out.select();
          let ok = false;
          try { await navigator.clipboard.writeText(url); ok = true; } catch { try { ok = document.execCommand("copy"); } catch { /* */ } }
          e.target.textContent = ok ? "Copied" : "Select and copy it";
        }, "main"), button("Done", done)));
    }

    function addPanel() {
      const user = field("Username", { maxlength: 32, placeholder: "e.g. sam" });
      const nm = field("Name (optional)", { maxlength: 64, placeholder: "e.g. Sam" });
      const admin = check("Admin: can manage users", false);
      const grp = groups.length ? groupPick("") : null;
      const viaLink = el("input", { type: "radio", name: "how", checked: true });
      const viaPw = el("input", { type: "radio", name: "how" });
      const pw = field("Password", { type: "text", minlength: 8, autocomplete: "new-password" });
      pw.label.hidden = true;
      const how = () => { pw.label.hidden = !viaPw.checked; };
      viaLink.addEventListener("change", how);
      viaPw.addEventListener("change", how);
      const note = el("div");
      const save = button("Add User", async () => {
        const body = { username: user.input.value.trim().toLowerCase(), name: nm.input.value.trim(), admin: admin.input.checked };
        if (grp) body.group = grp.value;
        if (viaPw.checked) body.password = pw.input.value;
        save.disabled = true;
        const r = await api("POST", "/api/admin/users", body);
        save.disabled = false;
        if (r.status !== 201) return note.replaceChildren(msg(errText(r), "error"));
        await load();
        if (r.data.link) showLink(r.data.user, r.data, `Added ${r.data.user.username}. Send them this link to choose their password.`);
        else top.replaceChildren(msg(`Added ${r.data.user.username}. They can sign in with the password you chose.`, "success"));
      }, "main");
      panel("Add User", note, user.label, nm.label, admin.label, grp && grp.el,
        el("div", { class: "choice" },
          el("label", { class: "check" }, viaLink, el("span", { text: "Send them a link to choose their own password" })),
          el("label", { class: "check" }, viaPw, el("span", { text: "Choose a password for them now" }))),
        pw.label,
        buttons(save, button("Cancel", done)));
    }

    function editPanel(u) {
      const self = u.id === myId;
      const user = field("Username", { value: u.username, maxlength: 32 });
      const nm = field("Name", { value: u.name, maxlength: 64 });
      const admin = check(self ? "Admin (another admin can change this)" : "Admin: can manage users", u.admin, self);
      const active = check(self ? "Account on" : "Account on (off: can't sign in)", u.active, self);
      const grp = groups.length ? groupPick(u.group) : null;
      const pw = field(self ? "New password (or use Your Account)" : "New password (leave empty to keep it)", { autocomplete: "new-password" });
      const note = el("div");
      const save = button("Save", async () => {
        const body = {};
        if (user.input.value.trim().toLowerCase() !== u.username) body.username = user.input.value.trim().toLowerCase();
        if (nm.input.value.trim() !== u.name) body.name = nm.input.value.trim();
        if (!self && admin.input.checked !== u.admin) body.admin = admin.input.checked;
        if (!self && active.input.checked !== u.active) body.active = active.input.checked;
        if (grp && grp.value !== (u.group || "")) body.group = grp.value;
        if (pw.input.value) body.password = pw.input.value;
        if (!Object.keys(body).length) return done();
        save.disabled = true;
        const r = await api("PATCH", `/api/admin/users/${u.id}`, body);
        save.disabled = false;
        if (r.status !== 200) return note.replaceChildren(msg(errText(r), "error"));
        load(msg(`Saved ${r.data.user.username}.` +
          (body.password && !self ? " They've been signed out, and can sign in with the new password." : "") +
          (body.group ? ` Their TVs get ${groupName(body.group)}'s settings within a few minutes.` : ""), "success"));
      }, "main");
      panel(`Edit ${name(u)}`, note, user.label, nm.label, admin.label, active.label, grp && grp.el, pw.label,
        buttons(save, button("Cancel", done)),
        el("h2", { text: "More" }),
        buttons(
          button("Sign-In Link", () => makeLink(u), "small"),
          !self && button("Sign Out Everywhere", () => signOut(u), "small"),
          !self && button("Remove", () => remove(u), "small danger")));
    }

    async function makeLink(u) {
      const r = await api("POST", `/api/admin/users/${u.id}/link`, {});
      if (r.status !== 200) return top.replaceChildren(msg(errText(r), "error"));
      showLink(u, r.data);
    }
    async function signOut(u) {
      if (!confirm(`Sign ${name(u)} out on every TV, phone and computer?`)) return;
      const r = await api("POST", `/api/admin/users/${u.id}/signout`, {});
      top.replaceChildren(r.status === 204 ? msg(`${name(u)} is signed out everywhere.`, "success") : msg(errText(r), "error"));
    }
    async function remove(u) {
      if (!confirm(`Remove ${name(u)} (${u.username})? They won't be able to sign in again.`)) return;
      const r = await api("DELETE", `/api/admin/users/${u.id}`);
      if (r.status !== 204) return top.replaceChildren(msg(errText(r), "error"));
      load(msg(`Removed ${u.username}.`, "success"));
    }

    // ------------------------------------------------------------ groups
    /** Checkboxes for who's in group `g` (null: a new group). */
    function memberChecks(g) {
      return list.map((u) => {
        const other = u.group && (!g || u.group !== g.id) ? groupName(u.group) : "";
        const c = check(name(u) + (other ? ` (now in ${other})` : ""), !!g && u.group === g.id);
        c.user = u;
        return c;
      });
    }
    /** Put the checked people in group `id`, and take the unchecked ones out. */
    async function saveMembers(id, checks) {
      for (const c of checks) {
        const inIt = c.user.group === id;
        if (c.input.checked === inIt) continue;
        const r = await api("PATCH", `/api/admin/users/${c.user.id}`, { group: c.input.checked ? id : "" });
        if (r.status !== 200) throw new Error(`${name(c.user)}: ${errText(r)}`);
      }
    }

    function addGroupPanel() {
      const nm = field("Group name", { maxlength: 40, placeholder: "e.g. Family" });
      const checks = memberChecks(null);
      const note = el("div");
      const save = button("Add Group", async () => {
        save.disabled = true;
        const r = await api("POST", "/api/admin/groups", { name: nm.input.value.trim() });
        if (r.status !== 201) { save.disabled = false; return note.replaceChildren(msg(errText(r), "error")); }
        try { await saveMembers(r.data.group.id, checks); } catch (e) { note.replaceChildren(msg(e.message, "error")); }
        save.disabled = false;
        await load();
        groupPanel(groups.find((x) => x.id === r.data.group.id) || r.data.group,
          msg(`Added ${r.data.group.name}. Now give it settings: set them up on the TV, or copy someone's.`, "success"));
      }, "main");
      panel("Add Group", note,
        p("A group's people get the settings you choose for it: playlists, channel order, On Demand servers and options. They can still change things on their own TVs; your next update replaces their changes. A Plex or Jellyfin sign-in in the group's settings goes to everyone in it.", "note"),
        nm.label,
        list.length ? el("div", { class: "field" }, el("span", { class: "lbl", text: "People in it" }), ...checks.map((c) => c.label)) : null,
        buttons(save, button("Cancel", done)));
    }

    function groupPanel(g, lead) {
      const nm = field("Group name", { value: g.name, maxlength: 40 });
      const checks = memberChecks(g);
      const note = el("div");
      if (lead) note.append(lead);
      const save = button("Save", async () => {
        save.disabled = true;
        try {
          if (nm.input.value.trim() !== g.name) {
            const r = await api("PATCH", `/api/admin/groups/${g.id}`, { name: nm.input.value.trim() });
            if (r.status !== 200) throw new Error(errText(r));
          }
          await saveMembers(g.id, checks);
        } catch (e) {
          save.disabled = false;
          return note.replaceChildren(msg(e.message, "error"));
        }
        load(msg(`Saved ${nm.input.value.trim()}.`, "success"));
      }, "main");
      const from = pick("Copy whose settings", list.map((u) => ({ value: u.id, label: u.id === myId ? `${name(u)} (you)` : name(u) })), myId);
      const copy = button("Copy Settings", async () => {
        const who = list.find((u) => u.id === from.value);
        if (g.hasSettings && !confirm(`Replace ${g.name}'s settings with ${who ? name(who) : "their"}'s?`)) return;
        copy.disabled = true;
        const r = await api("POST", `/api/admin/groups/${g.id}/copy`, { from: from.value });
        copy.disabled = false;
        if (r.status !== 200) return note.replaceChildren(msg(errText(r), "error"));
        load(msg(`${g.name} now has ${who ? name(who) : "their"}'s settings. Its people's TVs get them within a few minutes.`, "success"));
      });
      panel(`Group: ${g.name}`, note,
        nm.label,
        list.length ? el("div", { class: "field" }, el("span", { class: "lbl", text: "People in it" }), ...checks.map((c) => c.label)) : null,
        buttons(save, button("Cancel", done)),
        el("h2", { text: "Settings" }),
        p(g.hasSettings
          ? `Set up${g.updated ? ` ${fmtDate(g.updated)}` : ""}${g.by ? ` by ${g.by}` : ""}. Change them on the TV (they're saved as you go), or copy someone's settings over them.`
          : "Not set up yet. Set them up on the TV, as you would your own, or copy someone's.", "note"),
        p("A Plex or Jellyfin sign-in in these settings goes to everyone in the group: they can watch from that account's servers.", "note"),
        buttons(linkBtn("Set Up on TV", "/?group=" + encodeURIComponent(g.id))),
        list.length ? from.el : null,
        list.length ? buttons(copy) : null,
        el("h2", { text: "Remove" }),
        p("Its people keep the settings they have now.", "note"),
        buttons(button("Remove Group", async () => {
          if (!confirm(`Remove the group ${g.name}?`)) return;
          const r = await api("DELETE", `/api/admin/groups/${g.id}`);
          if (r.status !== 204) return note.replaceChildren(msg(errText(r), "error"));
          load(msg(`Removed ${g.name}.`, "success"));
        }, "small danger")));
    }

    page("Users",
      p("Everyone who can sign in. Each person's settings are saved on the server; put people in a group to set up their TVs for them.", "note"),
      buttons(button("Add User", addPanel, "main"), button("Add Group", addGroupPanel), linkBtn("Your Account", "/auth/account"), linkBtn("Go to TV", "/")),
      el("div", { style: "height:16px" }),
      top,
      el("h2", { text: "People" }), people,
      el("h2", { id: "groups", text: "Groups" }), groupsEl);
    await load();
    if (location.hash === "#groups") {
      const first = groupsEl.querySelector("a.btn, button");
      $("groups").scrollIntoView({ block: "start" });
      if (first) first.focus({ preventScroll: true });
    }
  }

  // -------------------------------------------------------- remote control
  /** ▲▼ move between fields and buttons (◀▶ too, outside text fields). */
  document.addEventListener("keydown", (e) => {
    const k = e.key;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(k)) return;
    const t = document.activeElement;
    const typing = t && t.tagName === "INPUT" && /^(text|password)$/.test(t.type);
    if (typing && (k === "ArrowLeft" || k === "ArrowRight")) return;
    const all = [...bodyEl.querySelectorAll("input:not([type=hidden]):not(:disabled), button:not(:disabled), a.btn")]
      .filter((x) => x.offsetParent !== null);
    if (!all.length) return;
    const i = all.indexOf(t);
    const d = k === "ArrowDown" || k === "ArrowRight" ? 1 : -1;
    const next = all[i < 0 ? 0 : Math.max(0, Math.min(all.length - 1, i + d))];
    if (next !== t) {
      e.preventDefault();
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    }
  });

  // ------------------------------------------------------------ screen fit
  /*
   * Like the guide (fit() in ../js/main.js): a TV-shaped screen smaller than
   * the guide's 800x600 (a 4:3 TV at 640x480, say) gets the page laid out at
   * that size and scaled down to fit, instead of the phone layout. In squish
   * mode (a 16:9 picture squeezed onto a 4:3 TV: Settings > Options, kept in
   * this browser) the page is drawn wider to match. Phones and bigger screens
   * lay it out as it is; "narrow" switches to the one-column layout.
   */
  const wrap = $("wrap");
  let scale = 1;
  function fit() {
    let squish = false;
    try { squish = !!((JSON.parse(localStorage.getItem("iptv.config.v1") || "null") || {}).prefs || {}).squish; } catch { /* */ }
    const k = squish ? 3 / 4 : 1;
    const w = window.innerWidth * k, h = window.innerHeight;
    scale = w >= h ? Math.min(1, w / 800, h / 600) : 1;
    const lw = w / scale;
    wrap.style.width = lw + "px";
    wrap.style.minHeight = h / scale + "px";
    wrap.style.transform = scale === 1 && k === 1 ? "" : `scale(${scale / k}, ${scale})`;
    document.documentElement.classList.toggle("narrow", lw < 700);
    height();
  }
  // the scaled page is out of the flow: the body takes its scaled height, for scrolling
  const height = () => { document.body.style.height = Math.ceil(wrap.offsetHeight * scale) + "px"; };
  window.addEventListener("resize", fit);
  if (window.ResizeObserver) new ResizeObserver(height).observe(wrap);
  fit();

  // ----------------------------------------------------------------- route
  const ROUTES = { login, account, users, recovery, error, logout };
  const route = ROUTES[location.pathname.replace(/^\/auth\/?/, "").replace(/\/.*$/, "")] || login;
  route().catch((e) => page("Problem", msg(e.message || String(e), "error"), buttons(linkBtn("Try Again", here()), linkBtn("Go to TV", "/"))));
})();
