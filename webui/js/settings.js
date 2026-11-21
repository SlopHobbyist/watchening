/*
 * Settings: a full-screen menu in the guide's style. A category column on the
 * left (like the guide's channel column) beside that category's rows, an
 * info panel describing the selection, and key hints.
 *
 *   Playlists  add by URL / upload file, zlive channels on/off, refresh,
 *              turn off, rename, remove, guide data (XMLTV) address
 *   Channels   reorder (Move, Move to Number), hide/show
 *   Custom Channels  channels that play a show from Plex or Jellyfin around
 *              the clock (channels.js): make, rename, reorder, remove (admins)
 *   On Demand  sign in to Plex (or add a server by address) or Jellyfin, servers (and their
 *              libraries, shown or hidden), picture quality
 *   Options    subtitle defaults, channel icons, 16:9 mode, squish mode, CORS proxy, erase everything
 *   Account    who's signed in; saving settings on the server (sync.js) and the
 *              person's group; change password, manage users (admins), sign out:
 *              these open the account pages (webui/auth/), leaving the guide.
 *              Editing a group's settings: which group, and Done
 *
 * Keys: Up/Down (W/S) select · Right (D) / OK into a category's rows ·
 *       Left (A) / Back / Esc / Backspace back out · Back in the categories (or F1) closes
 */
(function () {
  "use strict";
  const { $ } = U;
  const PAGES = [
    { name: "Playlists", desc: "Add, refresh, rename and remove channel lists (M3U playlists), and choose where guide listings come from." },
    { name: "Channels", desc: "Change the channel order, and hide channels you don't watch from the guide." },
    { name: "Custom Channels", desc: "Channels that play a show from your Plex or Jellyfin server around the clock, in order or shuffled, the same for everyone watching. Admins make and change them." },
    { name: "On Demand", desc: "Sign in to Plex or Jellyfin to watch the movies and shows on your media server, show or hide its libraries, and choose the picture quality." },
    { name: "Options", desc: "Subtitles, channel icons, 16:9 mode for widescreen TVs, squish mode for 4:3 TVs, the playlist proxy, the remote control keys, and erasing everything." },
    { name: "Account", desc: "Who's signed in, and saving your settings on the server for every TV you use. Change your password, sign out, and (for admins) manage people and groups." },
  ];
  const VIS = 7;          // visible rows
  const PITCH = 44;       // row height + gap
  // col: 0 = category column has focus, 1 = the rows
  const M = { page: 0, col: 0, sel: PAGES.map(() => 0), top: PAGES.map(() => 0), moving: null, entry: "", entryTimer: 0 };
  const rowsEl = $("m-rows"), catsEl = $("m-cats");

  // -------------------------------------------------------------------- rows
  /** Playlists the user added (zlive has a row of its own). */
  const userPlaylists = () => Store.cfg.playlists.filter((p) => p.type !== "zlive");
  const ZLIVE_ROW = 2; // its place in playlistRows; the user's playlists follow

  function zliveRow() {
    const pl = App.zlive();
    const on = !!(pl && pl.enabled);
    return {
      text: "zlive Channels",
      tag: !on ? "Off" : pl.error ? "Problem" : `${pl.count || 0} ch · On`,
      cls: (on ? "" : "off") + (on && pl.error ? " warn" : ""),
      info: {
        title: "zlive Channels",
        chan: on ? `${pl.count || 0} channels` : "Off",
        desc: [
          on ? `Live TV and sports channels from ${zliveSite(pl)}, added to your guide. They play in the site's own player, so pause, rewind and subtitles aren't available on them`
            : "Live TV and sports channels from a site whose address you enter, added to your guide. They play in the site's own player, so pause, rewind and subtitles aren't available on them",
          on && pl.updated ? "Updated " + U.fmtDate(pl.updated) : "",
          on && pl.error ? `Problem: ${pl.error}` : "",
        ].filter(Boolean).join(". ") + ".",
      },
      act: zliveDialog,
    };
  }

  function playlistRows() {
    const cfg = Store.cfg;
    const out = [
      {
        text: "Add Playlist from URL",
        info: { title: "Add Playlist from URL", desc: "Enter the web address of an M3U or M3U8 playlist. Web playlists are downloaded again when they are more than an hour old." },
        act: addUrlDialog,
      },
      {
        text: "Upload Playlist File",
        info: { title: "Upload Playlist File", desc: "Choose .m3u or .m3u8 files on this computer. You can also drag playlist files onto this window." },
        act: () => $("file-m3u").click(),
      },
      zliveRow(),
    ];
    for (const pl of userPlaylists()) {
      out.push({
        text: pl.name,
        tag: pl.error ? "Problem" : !pl.enabled ? "Off" : `${pl.count || 0} ch · ${pl.type === "url" ? "Web" : "File"}`,
        cls: (pl.enabled ? "" : "off") + (pl.error ? " warn" : ""),
        info: {
          title: pl.name,
          chan: pl.enabled ? `${pl.count || 0} channels` : "Turned off",
          desc: [
            pl.type === "url" ? (pl.updated ? "Updated " + U.fmtDate(pl.updated) : "Not downloaded") : "Uploaded file",
            pl.error ? `Problem: ${pl.error}` : "",
            pl.url,
          ].filter(Boolean).join(". "),
        },
        act: () => playlistDialog(pl),
      });
    }
    const srcs = App.epgSources();
    out.push({
      text: "Guide Data (XMLTV)", tag: App.epgBusy ? "Loading" : cfg.prefs.epgUrl ? "Custom" : "Auto",
      info: {
        title: "Guide Data (XMLTV)",
        chan: srcs.length ? `${srcs.length} source${srcs.length > 1 ? "s" : ""}` : "No source",
        desc: (cfg.prefs.epgUrl ? "Custom address. " : "From your playlists. ") + App.epgStatus,
      },
      act: epgDialog,
    });
    out.push({
      text: "Refresh Playlists & Guide Data",
      info: { title: "Refresh", desc: "Download every web playlist and the guide data again now." },
      act: refreshAll,
    });
    return out;
  }

  function channelRows() {
    const out = [{
      text: "Reset Channel Order",
      info: { title: "Reset Channel Order", desc: "Put every channel back in the order its playlist lists it. Hidden channels stay hidden." },
      act: resetOrderDialog,
    }];
    for (const c of App.all) {
      out.push({
        num: String(c.n), text: c.name, tag: c.hidden ? "Hidden" : c.group, key: c.key,
        cls: (c.hidden ? "off" : "") + (M.moving === c.key ? " moving" : ""),
        info: {
          title: c.name,
          chan: `${c.n} ${c.call}`,
          desc: (c.group ? c.group + ". " : "") + (c.hidden ? "Hidden from the guide. " : "") + `From ${c.plName}. OK for options, H to hide or show.`,
        },
        act: () => channelDialog(c),
      });
    }
    if (!App.all.length) {
      out.push({ text: "No channels yet: add a playlist first", info: { title: "No Channels" }, act: () => go(0) });
    }
    return out;
  }

  function onDemandRows() {
    const out = [{
      text: "Open On Demand",
      info: { title: "On Demand", desc: "Browse and watch the movies and shows on your media servers. Also O, from the guide or while watching." },
      act: () => App.openOnDemand(),
    }];
    for (const x of OnDemand.setups()) out.push({ text: x.text, info: { title: x.text, chan: x.label, desc: x.desc }, act: x.act });
    for (const src of Store.cfg.vod.sources) {
      const p = OnDemand.providers[src.type];
      out.push({
        text: src.name, tag: p ? p.label : "Unknown",
        info: { title: src.name, chan: p ? p.label : "", desc: p && p.describe ? p.describe(src) : "" },
        act: () => sourceDialog(src),
      });
    }
    const q = OnDemand.quality();
    out.push({
      text: "Picture Quality", tag: q.label,
      info: {
        title: "Picture Quality", chan: q.label,
        desc: "Automatic measures how fast the server reaches this TV and has it send no more than that, lowering the picture if the connection slows down while you watch (watching away from home, a server's upload is usually the limit). Original plays files as they are where the browser can, and has the server convert only what it can't. A lower setting has the server shrink the picture to at most that.",
      },
      act: () => {
        const list = OnDemand.QUALITY;
        Store.cfg.vod.quality = list[(list.indexOf(q) + 1) % list.length].id;
        Store.save();
        render();
      },
    });
    return out;
  }

  // Subtitle Language: "" is this TV's own (the browser's)
  const SUB_LANGS = ["", "en", "es", "fr", "de", "it", "pt", "pt-BR", "nl", "sv", "no", "da", "fi", "pl", "cs", "ro", "hu", "el", "tr", "ru", "uk", "ar", "he", "fa", "hi", "zh", "ja", "ko", "vi", "id"];
  function subLangName(tag) {
    const names = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "language" }) : null;
    const name = (t) => { try { return (names && names.of(t)) || t; } catch { return t; } };
    return tag ? name(tag) : `Automatic (${name((navigator.language || "en").split("-")[0])})`;
  }

  function optionRows() {
    const p = Store.cfg.prefs;
    return [
      {
        text: "Subtitles When Available", tag: p.ccDefault ? "On" : "Off",
        info: { title: "Subtitles When Available", desc: "Turn subtitles on for everything that has them. Movies and shows from Plex, Jellyfin or Stremio (On Demand and custom channels) that have none in your Subtitle Language get some from OpenSubtitles by themselves. Off, subtitles you turn on stay on for the rest of the show (its next episodes). Press C while watching to switch them on or off. Yours alone: group settings don't include it." + (Sync.editing ? ` Changing it now changes your own, not ${Sync.editing.name}'s.` : "") },
        act: () => { App.setPrefs({ ccDefault: !p.ccDefault }); render(); },
      },
      {
        text: "Subtitle Language", tag: subLangName(p.subLang),
        info: { title: "Subtitle Language", desc: "The language Search for Subtitles (in Subtitle Options, Shift+C, while watching) shows first, and that Subtitles When Available turns on by itself when subtitles in it have been downloaded for a title. Automatic is this TV's language." },
        act: () => {
          const i = SUB_LANGS.indexOf(p.subLang || "");
          App.setPrefs({ subLang: SUB_LANGS[(i + 1) % SUB_LANGS.length] });
          render();
        },
      },
      {
        text: "Subtitle Size", tag: ["Small", "Medium", "Large"][p.ccSize] || "Medium",
        info: { title: "Subtitle Size", desc: "Size of subtitle text on the picture. Also in Subtitle Options (Shift+C) while watching." },
        act: () => { App.setPrefs({ ccSize: ((p.ccSize | 0) + 1) % 3 }); render(); },
      },
      {
        text: "Channel Icons", tag: p.chanIcons !== false ? "On" : "Off",
        info: { title: "Channel Icons", desc: "Show a built-in icon, picked by channel name, for channels whose playlist has none (zlive channels never do). The icons are the ones the channels used around 2005." },
        act: () => { App.setPrefs({ chanIcons: p.chanIcons === false }); App.rebuild(); render(); },
      },
      {
        text: "16:9 Mode (Widescreen TV)", tag: p.wide ? "On" : "Off",
        info: { title: "16:9 Mode", desc: "For a widescreen TV or monitor. Widens the guide and its info panel to fill a 16:9 screen, shows a half hour more of the listings, and makes the guide's picture 16:9. Turns Squish Mode off. Kept on this TV only, never in group settings." },
        act: () => { App.setPrefs({ wide: !p.wide }); render(); },
      },
      {
        text: "Squish Mode (4:3 TV)", tag: p.squish ? "On" : "Off",
        info: { title: "Squish Mode", desc: "For a 16:9 box whose converter squeezes the picture onto a 4:3 TV. Draws the guide and the picture wider so they look right on the TV. Turns 16:9 Mode off. Kept on this TV only, never in group settings." },
        act: () => { App.setPrefs({ squish: !p.squish }); render(); },
      },
      {
        text: "CORS Proxy for Playlists", tag: p.proxy ? "On" : U.server.proxy ? "Server's" : "None",
        info: {
          title: "CORS Proxy",
          desc: U.server.proxy
            ? "This server has its own proxy, used automatically when a playlist or guide can't be downloaded directly. Set a different CORS proxy here only if you need one. Not used for video."
            : "Some playlist servers block web pages from downloading them. A CORS proxy can fetch them for you. Not used for video.",
        },
        act: proxyDialog,
      },
      {
        text: "Remote Control Keys",
        info: { title: "Remote Control Keys", desc: "Keyboard shortcuts for the guide, the menus and the player." },
        act: helpDialog,
      },
      ...(U.app ? appRows() : []),
      {
        text: Sync.editing ? "Erase This Group's Settings" : "Erase All Settings & Playlists",
        info: {
          title: "Erase Everything",
          desc: Sync.editing ? `Remove every playlist, the channel order and all options from ${Sync.editing.name}'s settings.`
            : "Remove every playlist, the channel order and all options from this browser" + (Sync.active ? ", and from the copy saved on the server." : "."),
        },
        act: () => Dialog.confirm("Erase Everything", "Remove all playlists, channel order and options" + (Sync.editing ? ` from ${Sync.editing.name}'s settings?` : Sync.active ? ", here and on the server?" : "?"), "Erase", async () => {
          await Store.reset();
          await Sync.flush();
          location.reload();
        }),
      },
    ];
  }

  /** Only in the Android TV app (U.app): it does these itself. */
  function appRows() {
    const ask = (action) => async () => { await Sync.flush(); U.appAction(action); };
    return [
      {
        text: "Reload App (Clear Cache)",
        info: { title: "Reload App", desc: "Clears this TV app's cache and loads the page again, fresh from the server. Try it if something looks stuck or out of date. You stay signed in, and your settings stay." },
        act: ask("reload"),
      },
      {
        text: "Change Server Address",
        info: { title: "Change Server Address", desc: "The address of the Watchening server this TV app opens." },
        act: ask("server"),
      },
    ];
  }

  /** Saving settings on the server (sync.js): on or off for this TV. */
  function syncRow() {
    const on = Sync.active;
    const where = U.server.auth
      ? "Your playlists, channel order, On Demand servers and options are saved to your account, so every TV you sign in on has them"
      : "Playlists, channel order, On Demand servers and options are saved on the server and shared by every TV on this network";
    return {
      text: "Save Settings on Server", tag: !on ? "Off" : Sync.problem ? "Problem" : "On", cls: on && Sync.problem ? "warn" : "",
      info: {
        title: "Save Settings on Server", chan: on ? "On" : "Off",
        desc: (on ? where + ". Screen shape and picture settings stay with each TV."
          : "Off: this TV keeps its settings to itself. When it's on: " + where.charAt(0).toLowerCase() + where.slice(1) + ".") + (Sync.problem ? " " + Sync.problem : ""),
      },
      act: async () => { await Sync.setOn(!on); render(); },
    };
  }
  /** The person's group: an admin looks after its settings. */
  function groupRow() {
    const g = Sync.group;
    if (!g || !Sync.active) return null;
    const following = Sync.fromGroup || !g.hasSettings;
    return {
      text: `Group: ${g.name}`, tag: !g.hasSettings ? "Not Set Up" : following ? "Using" : "Changed",
      info: {
        title: `Group: ${g.name}`, chan: following ? "Group settings" : "Your changes",
        desc: !g.hasSettings ? "An admin hasn't set up this group's settings yet."
          : following ? "An admin looks after this group's settings. When they update them, your TVs get the update."
            : `You've changed things since ${g.name}'s settings came. OK goes back to ${g.name}'s settings. They also replace yours the next time an admin updates them.`,
      },
      act: following ? null : () => Dialog.confirm(`Use ${g.name}'s Settings`, `Replace your playlists, channel order and options with ${g.name}'s?`, "Replace", async () => {
        try { await Sync.useGroup(); } catch (e) { Dialog.message(e.message, true); return false; }
        render();
      }),
    };
  }

  function accountRows() {
    const s = U.server, u = s.user;
    const leave = (path) => async () => { await Sync.flush(); location.assign(path); };
    if (!s.known) {
      return [{
        text: "No Accounts Here",
        info: { title: "No Accounts", desc: "This copy of the viewer isn't running on its own server (docker compose), so there's no sign-in, no saved settings and no stream proxy." },
      }];
    }
    if (Sync.editing) {
      const g = Sync.editing.name;
      return [
        {
          text: `Editing Group: ${g}`, tag: Sync.problem ? "Problem" : "Saved", cls: Sync.problem ? "warn" : "",
          info: {
            title: `Editing ${g}'s Settings`, chan: g,
            desc: (Sync.problem ? Sync.problem + " " : "") + `Changes you make now are saved as ${g}'s settings, and its people's TVs get them within a few minutes. Your own settings aren't touched. Screen shape and picture settings are this TV's own, and Subtitles When Available is each person's own: none of them are part of a group's settings.`,
          },
        },
        {
          text: "Done Editing",
          info: { title: "Done Editing", desc: "Back to the Users page. Your own settings come back the next time you open the TV." },
          act: leave("/auth/users#groups"),
        },
      ];
    }
    if (!s.auth) {
      return [{
        text: "Sign-In Is Off",
        info: { title: "Sign-In Is Off", desc: "This server has sign-in turned off (AUTH=off in its .env file), so it only answers devices on its home network." },
      }, syncRow()];
    }
    const name = u ? u.name || u.username : "";
    return [
      {
        text: `Signed In: ${name}`, tag: u && u.admin ? "Admin" : "",
        info: { title: name, chan: u ? u.username : "", desc: u && u.admin ? "You can add people, put them in groups and set up their TVs in Manage Users." : "Ask an admin if you need another account." },
      },
      syncRow(),
      groupRow(),
      {
        text: "Change Password",
        info: { title: "Change Password", desc: "Opens your account page, where you can choose a new password. Back returns here." },
        act: leave("/auth/account"),
      },
      u && u.admin && {
        text: "Manage Users",
        info: { title: "Manage Users", desc: "Add people, send them a link to choose their own password, change or turn off accounts, and sign people out everywhere. Groups: set up the settings once for several people." },
        act: leave("/auth/users"),
      },
      {
        text: "Sign Out",
        info: { title: "Sign Out", desc: "Sign out of this TV. Your playlists and settings stay in this browser" + (Sync.active ? ", and saved on the server." : ".") },
        act: () => Dialog.confirm("Sign Out", `Sign ${name} out of this TV?`, "Sign Out", leave("/auth/logout")),
      },
    ].filter(Boolean);
  }

  const rowsFor = (page) => [playlistRows, channelRows, Channels.settingsRows, onDemandRows, optionRows, accountRows][page]();
  const rows = () => rowsFor(M.page);

  // ------------------------------------------------------------------ render
  function div(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function showInfo({ title = "", chan = "", desc = "" }) {
    const chanEl = $("mi-chan"), titleEl = $("mi-title");
    U.fitText(chanEl, chan, true);
    titleEl.style.maxWidth = Math.max(200, $("m-info").offsetWidth - 56 - 24 - chanEl.offsetWidth - 20) + "px";
    U.fitText(titleEl, title, true);
    U.fitText($("mi-desc"), desc, false);
  }

  function pageInfo(i) {
    const cfg = Store.cfg;
    const npl = userPlaylists().length;
    const nsrc = Store.cfg.vod.sources.length;
    const chan = i === 0 ? `${npl} playlist${npl === 1 ? "" : "s"}`
      : i === 1 ? `${App.all.length} channel${App.all.length === 1 ? "" : "s"}`
        : i === 2 ? `${Channels.count()} channel${Channels.count() === 1 ? "" : "s"}`
          : i === 3 ? `${nsrc} server${nsrc === 1 ? "" : "s"}`
            : i === 5 && Sync.editing ? Sync.editing.name
              : i === 5 && U.server.user ? U.server.user.username : "";
    return { title: PAGES[i].name, chan, desc: PAGES[i].desc };
  }

  function render() {
    if (App.mode !== "menu") return;
    const list = rows();
    const sel = (M.sel[M.page] = U.clamp(M.sel[M.page], 0, list.length - 1));
    let top = M.top[M.page];
    if (sel < top) top = sel;
    if (sel >= top + VIS) top = sel - VIS + 1;
    top = M.top[M.page] = U.clamp(top, 0, Math.max(0, list.length - VIS));
    const inRows = M.col === 1;

    // categories
    const cats = document.createDocumentFragment();
    PAGES.forEach((pg, i) => {
      const c = div("m-cat" + (i === M.page ? (inRows ? " cur" : " sel") : ""), pg.name);
      c.style.top = i * PITCH + 2 + "px";
      c.addEventListener("click", () => {
        M.moving = null;
        if (M.page === i && !inRows) M.col = 1;
        else { M.page = i; M.col = 0; }
        render();
      });
      cats.appendChild(c);
    });
    catsEl.replaceChildren(cats);

    // rows, then empty listings to fill the screen
    const frag = document.createDocumentFragment();
    const toFit = [];
    for (let k = 0; k < VIS; k++) {
      const i = top + k;
      const r = list[i];
      if (!r) {
        const blank = div("m-row blank");
        blank.style.top = k * PITCH + "px";
        frag.appendChild(blank);
        continue;
      }
      const row = div("m-row" + (inRows && i === sel ? " sel" : "") + (r.cls ? " " + r.cls : ""));
      row.style.top = k * PITCH + "px";
      if (M.page === 1) row.appendChild(div("m-num", r.num || ""));
      const text = div("m-text");
      row.appendChild(text);
      if (r.tag) row.appendChild(div("m-tag", r.tag));
      if (M.moving && r.key === M.moving) row.appendChild(div("m-updown", "▲▼"));
      row.addEventListener("click", () => {
        if (M.moving) return drop();
        if (M.col === 1 && M.sel[M.page] === i) activate();
        else { M.col = 1; M.sel[M.page] = i; render(); }
      });
      frag.appendChild(row);
      toFit.push([text, r.text]);
    }
    rowsEl.replaceChildren(frag);
    for (const [el, t] of toFit) U.fitText(el, t, true);

    $("m-title").textContent = PAGES[M.page].name;
    if (!M.entry) $("m-pos").textContent = inRows && list.length > VIS ? `${sel + 1} of ${list.length}` : "";
    const cur = list[sel];
    showInfo(inRows ? cur.info || { title: cur.text } : pageInfo(M.page));
    $("m-hint").textContent = M.moving
      ? "▲▼ Move Channel · OK Done"
      : !inRows
        ? "▲▼ Select · OK Open · Back Close Settings"
        : M.page === 1
          ? "▲▼ Select · OK Options · H Hide · Back"
          : "▲▼ Select · OK Choose · Back";
  }

  // ------------------------------------------------------------- navigation
  function selBy(d) {
    const n = rows().length;
    M.sel[M.page] = U.clamp(M.sel[M.page] + d, 0, n - 1);
    render();
  }
  function go(page) {
    M.moving = null;
    M.page = U.clamp(page, 0, PAGES.length - 1);
    render();
  }
  function focusRows(on) {
    M.col = on ? 1 : 0;
    render();
  }
  function activate() {
    const r = rows()[M.sel[M.page]];
    if (r && r.act) r.act();
  }
  function close() {
    M.moving = null;
    App.closeMenu();
  }
  function channelAt(sel) {
    return M.page === 1 ? App.all[sel - 1] || null : null;
  }

  function numEntry(dg) {
    M.entry = (M.entry + dg).slice(0, 5);
    clearTimeout(M.entryTimer);
    $("m-pos").textContent = M.entry + "_";
    M.entryTimer = setTimeout(() => {
      const n = parseInt(M.entry, 10);
      M.entry = "";
      const i = App.all.findIndex((c) => c.n >= n);
      if (i >= 0) M.sel[1] = i + 1;
      render();
    }, 1200);
  }

  // ------------------------------------------------------------ reordering
  function saveOrder(keys) {
    const present = new Set(keys);
    Store.cfg.order = keys.concat(Store.cfg.order.filter((k) => !present.has(k)));
    Store.save();
    App.rebuild();
  }
  function moveTo(key, j) {
    const keys = App.all.map((c) => c.key);
    const i = keys.indexOf(key);
    if (i < 0) return;
    j = U.clamp(j, 0, keys.length - 1);
    keys.splice(i, 1);
    keys.splice(j, 0, key);
    M.sel[1] = j + 1;
    saveOrder(keys);
  }
  function startMove(c) {
    M.moving = c.key;
    M.sel[1] = App.all.indexOf(c) + 1;
    render();
  }
  function moveBy(d) {
    const i = App.all.findIndex((c) => c.key === M.moving);
    if (i < 0) { M.moving = null; return render(); }
    if (U.clamp(i + d, 0, App.all.length - 1) !== i) moveTo(M.moving, i + d);
  }
  function drop() {
    M.moving = null;
    render();
  }
  function setHidden(c, hide) {
    const h = new Set(Store.cfg.hidden);
    if (hide) h.add(c.key); else h.delete(c.key);
    Store.cfg.hidden = [...h];
    Store.save();
    App.rebuild();
  }

  // ----------------------------------------------------------------- dialogs
  function addUrlDialog() {
    Dialog.open({
      title: "Add Playlist from URL",
      fields: [
        { id: "url", label: "Playlist address", placeholder: "https://example.com/playlist.m3u8" },
        { id: "name", label: "Name (optional)", placeholder: "My Channels" },
      ],
      buttons: [
        {
          label: "Add Playlist",
          act: async (v) => {
            if (!v.url) { Dialog.message("Enter the playlist's address first.", true); return false; }
            Dialog.message("Downloading...");
            try {
              const pl = await App.addUrl(v.url, v.name);
              afterAdd([pl]);
            } catch (e) {
              Dialog.message(e.message, true);
              return false;
            }
          },
        },
        { label: "Cancel" },
      ],
    });
  }

  function afterAdd(pls) {
    if (!pls.length) return;
    const total = pls.reduce((n, p) => n + (p.count || 0), 0);
    App.osd(pls.length === 1 ? `Added ${pls[0].name}: ${total} channels` : `Added ${pls.length} playlists: ${total} channels`, 3500);
    if (!Player.ch && App.channels.length) App.tuneKey(App.channels[0].key);
    if (App.mode === "menu" && M.page === 0) {
      M.col = 1;
      M.sel[0] = ZLIVE_ROW + 1 + userPlaylists().indexOf(pls[pls.length - 1]);
      render();
    }
  }

  async function addFiles(files) {
    const added = [], errs = [];
    for (const f of files) {
      try { added.push(await App.addFile(f)); } catch (e) { errs.push(e.message); }
    }
    afterAdd(added);
    if (errs.length) Dialog.open({ title: "Upload Playlist", text: errs.join("\n"), buttons: [{ label: "OK" }] });
  }
  $("file-m3u").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length) addFiles(files);
  });

  function playlistDialog(pl) {
    const isUrl = pl.type === "url";
    const reload = () => { Store.save(); App.rebuild(); App.loadGuideData(false); };
    Dialog.open({
      title: pl.name,
      text: pl.error ? `Problem: ${pl.error}` : "",
      buttons: [
        isUrl && {
          label: "Download Again Now",
          act: async () => {
            Dialog.message("Downloading...");
            await App.loadPlaylist(pl, true);
            reload();
            if (pl.error) { Dialog.message(pl.error, true); return false; }
            App.osd(`${pl.name}: ${pl.count} channels`);
          },
        },
        { label: pl.enabled ? "Turn Off" : "Turn On", act: () => { pl.enabled = !pl.enabled; reload(); } },
        { label: isUrl ? "Edit Name & Address" : "Rename", act: () => editDialog(pl) },
        {
          label: "Remove",
          act: () => Dialog.confirm("Remove Playlist", `Remove "${pl.name}" and its ${pl.count || 0} channels?`, "Remove", () => App.removePlaylist(pl)),
        },
        { label: "Cancel" },
      ].filter(Boolean),
    });
  }

  /** The site part of a saved zlive playlist's address, for showing and editing. */
  function zliveSite(pl) { try { return new URL(pl.url).host; } catch { return ""; } }

  /** Ask for the site's address (nothing is filled in out of the box), then
   *  download its channel list and turn the channels on. */
  function zliveAddressDialog() {
    const pl = App.zlive();
    Dialog.open({
      title: "zlive Channels",
      text: "Enter the address of the site to load live TV and sports channels from. They play in the site's own player: pause, rewind and subtitles aren't available on them.",
      fields: [{
        id: "url", label: "Site address", placeholder: "example.com",
        // the short form when it's the usual list, so it reads as what was typed
        value: !pl ? "" : /^https:\/\/[^/]+\/embed\/manifest\.json$/.test(pl.url) ? zliveSite(pl) : pl.url,
      }],
      buttons: [
        {
          label: "Turn On",
          act: async (v) => {
            if (!v.url) { Dialog.message("Enter the site's address first.", true); return false; }
            Dialog.message("Downloading the channel list...");
            try {
              const p = await App.setZlive(true, v.url);
              App.osd(`zlive: ${p.count} channels`, 3500);
              if (!Player.ch && App.channels.length) App.tuneKey(App.channels[0].key);
              render();
            } catch (e) {
              Dialog.message(e.message, true);
              return false;
            }
          },
        },
        { label: "Cancel" },
      ],
    });
  }

  function zliveDialog() {
    const pl = App.zlive();
    const on = !!(pl && pl.enabled);
    if (!on) return zliveAddressDialog();
    Dialog.open({
      title: "zlive Channels",
      text: (pl.error ? `Problem: ${pl.error}\n` : "") + `${pl.count || 0} channels in your guide, from ${zliveSite(pl)}.`,
      buttons: [
        {
          label: "Download Again Now",
          act: async () => {
            Dialog.message("Downloading...");
            await App.loadPlaylist(pl, true);
            Store.save();
            App.rebuild();
            if (pl.error) { Dialog.message(pl.error, true); return false; }
            App.osd(`zlive: ${pl.count} channels`);
          },
        },
        { label: "Change Address", act: () => zliveAddressDialog() },
        { label: "Turn Off", act: () => { App.setZlive(false); render(); } },
        { label: "Cancel" },
      ],
    });
  }

  function editDialog(pl) {
    const isUrl = pl.type === "url";
    const fields = [{ id: "name", label: "Name", value: pl.name }];
    if (isUrl) fields.push({ id: "url", label: "Playlist address", value: pl.url });
    Dialog.open({
      title: "Edit Playlist",
      fields,
      buttons: [
        {
          label: "Save",
          act: async (v) => {
            if (v.name) pl.name = v.name;
            if (isUrl && v.url && v.url !== pl.url) {
              try { new URL(v.url); } catch { Dialog.message("That doesn't look like a web address.", true); return false; }
              const old = pl.url;
              pl.url = v.url;
              Dialog.message("Downloading...");
              await App.loadPlaylist(pl, true);
              if (pl.error) {
                const err = pl.error;
                pl.url = old;
                pl.error = "";
                Dialog.message(err, true);
                return false;
              }
            }
            Store.save();
            App.rebuild();
            App.loadGuideData(false);
          },
        },
        { label: "Cancel" },
      ],
    });
  }

  function epgDialog() {
    Dialog.open({
      title: "Guide Data (XMLTV)",
      text: "Leave empty to use the guide address your playlists name (url-tvg). Separate several addresses with spaces. .xml and .xml.gz both work.",
      fields: [{ id: "url", label: "XMLTV address", value: Store.cfg.prefs.epgUrl, placeholder: "Automatic" }],
      buttons: [
        { label: "Save & Load", act: (v) => { App.setPrefs({ epgUrl: v.url }); App.loadGuideData(true); } },
        { label: "Cancel" },
      ],
    });
  }

  async function refreshAll() {
    App.osd("Refreshing playlists...", 10000);
    const pls = await App.refreshAll();
    const bad = pls.filter((p) => p.error);
    App.osd(bad.length ? `${bad.length} playlist${bad.length > 1 ? "s" : ""} had a problem` : "Playlists and guide data refreshed", 3500);
  }

  function resetOrderDialog() {
    Dialog.confirm("Reset Channel Order", "Put every channel back in its playlist's order?", "Reset", () => {
      Store.cfg.order = [];
      Store.save();
      App.rebuild();
    });
  }

  function channelDialog(c) {
    Dialog.open({
      title: `${c.n} ${c.name}`,
      buttons: [
        { label: "Watch", disabled: c.hidden, act: () => { App.tuneKey(c.key); App.watch(); } },
        { label: "Move", act: () => startMove(c) },
        { label: "Move to Number...", act: () => moveToDialog(c) },
        { label: "Move to Top", act: () => moveTo(c.key, 0) },
        { label: c.hidden ? "Show in Guide" : "Hide from Guide", act: () => setHidden(c, !c.hidden) },
        { label: "Cancel" },
      ],
    });
  }

  function moveToDialog(c) {
    Dialog.open({
      title: `Move ${c.name}`,
      fields: [{ id: "n", label: `New channel number (1-${App.all.length})`, value: String(c.n) }],
      buttons: [
        {
          label: "Move",
          act: (v) => {
            const n = parseInt(v.n, 10);
            if (!(n >= 1)) { Dialog.message("Enter a channel number.", true); return false; }
            moveTo(c.key, n - 1);
          },
        },
        { label: "Cancel" },
      ],
    });
  }

  function sourceDialog(src) {
    const p = OnDemand.providers[src.type];
    Dialog.open({
      title: src.name,
      text: p && p.describe ? p.describe(src) : "",
      buttons: [
        p && {
          label: "Show & Hide Libraries",
          act: async () => {
            Dialog.message("Loading the libraries...");
            let libs;
            try { libs = await OnDemand.libraries(src); } catch (e) { Dialog.message(e.message, true); return false; }
            if (!libs.length) { Dialog.message("This server has no movie or TV show libraries.", true); return false; }
            librariesDialog(src, libs, 0);
          },
        },
        p && p.reconnect && {
          label: "Find Server Again",
          act: async () => {
            Dialog.message("Connecting...");
            try { await p.reconnect(src); } catch (e) { Dialog.message(e.message, true); return false; }
            OnDemand.changed();
            App.osd(`Connected to ${src.name}`);
            render();
          },
        },
        {
          label: "Remove",
          act: () => Dialog.confirm("Remove Server", `Remove ${src.name} from On Demand?`, "Remove", () => { OnDemand.removeSource(src); render(); }),
        },
        { label: "Cancel" },
      ].filter(Boolean),
    });
  }

  /** A server's libraries, each shown or hidden in On Demand; OK switches one. */
  function librariesDialog(src, libs, sel) {
    Dialog.open({
      title: `${src.name}: Libraries`,
      text: "Hidden libraries are left out of On Demand, and their titles out of Continue Watching and Recently Added.",
      sel,
      buttons: libs.map((lib, i) => {
        const hidden = OnDemand.libHidden(src, lib.id);
        return {
          label: `${lib.title}: ${hidden ? "Hidden" : "Shown"}`,
          act: () => { OnDemand.setLibHidden(src, lib.id, !hidden); librariesDialog(src, libs, i); },
        };
      }).concat([{ label: "Done" }]),
    });
  }

  function proxyDialog() {
    Dialog.open({
      title: "CORS Proxy",
      text: "Used only to download playlists and guide data. Put {url} where the playlist address goes, or leave it out to add the address at the end. Leave empty for none.",
      fields: [{ id: "proxy", label: "Proxy address", value: Store.cfg.prefs.proxy, placeholder: "https://proxy.example/?url={url}" }],
      buttons: [
        { label: "Save", act: (v) => { App.setPrefs({ proxy: v.proxy }); render(); } },
        { label: "Cancel" },
      ],
    });
  }

  function helpDialog() {
    Dialog.open({
      title: "Remote Control Keys",
      text: [
        "TV: ▲▼ channel · ◀▶ 5s · OK controls · Back guide",
        "Controls: ▲▼ timeline or buttons · ◀▶ seek or pick",
        "Keys: W S channel · A D 5s · J L 10s · 0-9 tune",
        "Space or K pause · C captions · M mute · F full screen",
        "I info · G guide · O On Demand",
        "Shift+C subtitles · Shift+F display",
        "Menus: arrows · OK or Enter · Back, Esc or Backspace",
        "F1 settings, anywhere",
      ].join("\n"),
      buttons: [{ label: "OK" }],
    });
  }

  // ------------------------------------------------------------------- input
  function key(e) {
    const k = e.key, nav = U.nav(e);
    if (M.moving) {
      switch (nav || k) {
        case "up": moveBy(-1); break;
        case "down": moveBy(1); break;
        case "PageUp": moveBy(-VIS); break;
        case "PageDown": moveBy(VIS); break;
        case "Home": moveBy(-1e9); break;
        case "End": moveBy(1e9); break;
        case "ok": case "back": case " ": drop(); break;
        default: return false;
      }
      return true;
    }
    if (/^[0-9]$/.test(k) && M.page === 1) { M.col = 1; numEntry(k); return true; }
    if (M.col === 0) {
      switch (nav || k) {
        case "up": go(M.page - 1); break;
        case "down": go(M.page + 1); break;
        case "right": case "ok": case " ": focusRows(true); break;
        case "left": break;
        case "back": close(); break;
        case "Tab": go((M.page + 1) % PAGES.length); break;
        case "f": case "F": App.act.fullscreen(); break;
        default: return false;
      }
      return true;
    }
    switch (nav || k) {
      case "up": selBy(-1); break;
      case "down": selBy(1); break;
      case "PageUp": selBy(-VIS); break;
      case "PageDown": selBy(VIS); break;
      case "Home": selBy(-1e9); break;
      case "End": selBy(1e9); break;
      case "left": case "back": focusRows(false); break;
      case "right": break;
      case "ok": case " ": activate(); break;
      case "Tab": go((M.page + 1) % PAGES.length); break;
      case "h": case "H": { const c = channelAt(M.sel[1]); if (c) setHidden(c, !c.hidden); break; }
      case "f": case "F": App.act.fullscreen(); break;
      default: return false;
    }
    return true;
  }

  window.Settings = {
    /** With a page number, opens straight into that page's rows. */
    open(page) {
      if (typeof page === "number") { M.page = page; M.col = 1; }
      else M.col = 0;
      M.moving = null;
      render();
    },
    close,
    render,
    key,
    wheel(d) { if (M.moving) moveBy(d); else if (M.col === 0) go(M.page + d); else selBy(d); },
    addFiles,
  };
})();
