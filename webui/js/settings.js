/*
 * Settings screen, laid out like the iGuide's list screens ("Scheduled
 * Recordings", "Listings By Channel"): the guide's top half, a title bar with
 * a  < Page >  selector, and a list of rows.
 *
 *   Playlists  add by URL / upload file, refresh, turn off, rename, remove,
 *              guide data (XMLTV) address
 *   Channels   reorder (Move, Move to Number), hide/show
 *   Options    subtitle defaults, CORS proxy, erase everything
 */
(function () {
  "use strict";
  const { $ } = U;
  const PAGES = ["Playlists", "Channels", "Options"];
  const VIS = 6;          // visible rows
  const PITCH = 44;       // row height + gap
  const M = { page: 0, sel: [0, 0, 0], top: [0, 0, 0], moving: null, entry: "", entryTimer: 0 };
  const rowsEl = $("m-rows");

  // -------------------------------------------------------------------- rows
  function playlistRows() {
    const cfg = Store.cfg;
    const out = [
      {
        label: "Add", text: "Add Playlist from URL",
        info: { title: "Add Playlist from URL", desc: "Enter the web address of an M3U or M3U8 playlist. Web playlists are downloaded again when they are more than an hour old." },
        act: addUrlDialog,
      },
      {
        label: "Upload", text: "Upload Playlist File",
        info: { title: "Upload Playlist File", desc: "Choose .m3u or .m3u8 files on this computer. You can also drag playlist files onto this window." },
        act: () => $("file-m3u").click(),
      },
    ];
    for (const pl of cfg.playlists) {
      out.push({
        label: pl.enabled ? `${pl.count || 0} ch` : "Off",
        text: pl.name,
        tag: pl.error ? "Problem" : pl.type === "url" ? "Web" : "File",
        cls: (pl.enabled ? "" : "off") + (pl.error ? " warn" : ""),
        info: {
          title: pl.name,
          chan: pl.enabled ? `${pl.count || 0} channels` : "Turned off",
          time: pl.type === "url" ? (pl.updated ? "Updated " + U.fmtDate(pl.updated) : "Not downloaded") : "Uploaded file",
          desc: (pl.error ? `Problem: ${pl.error}. ` : "") + pl.url,
        },
        act: () => playlistDialog(pl),
      });
    }
    const srcs = App.epgSources();
    out.push({
      label: "Guide", text: "Guide Data (XMLTV)", tag: App.epgBusy ? "Loading" : cfg.prefs.epgUrl ? "Custom" : "Auto",
      info: {
        title: "Guide Data (XMLTV)",
        chan: cfg.prefs.epgUrl ? "Custom" : "Automatic",
        time: srcs.length ? `${srcs.length} source${srcs.length > 1 ? "s" : ""}` : "No source",
        desc: App.epgStatus,
      },
      act: epgDialog,
    });
    out.push({
      label: "Refresh", text: "Refresh Playlists & Guide Data",
      info: { title: "Refresh", desc: "Download every web playlist and the guide data again now." },
      act: refreshAll,
    });
    return out;
  }

  function channelRows() {
    const out = [{
      label: "Reset", text: "Reset Channel Order",
      info: { title: "Reset Channel Order", desc: "Put every channel back in the order its playlist lists it. Hidden channels stay hidden." },
      act: resetOrderDialog,
    }];
    for (const c of App.all) {
      out.push({
        label: String(c.n), text: c.name, tag: c.hidden ? "Hidden" : c.group, key: c.key,
        cls: (c.hidden ? "off" : "") + (M.moving === c.key ? " moving" : ""),
        info: {
          title: c.name,
          chan: `${c.n} ${c.call}`,
          time: c.group || "",
          desc: (c.hidden ? "Hidden from the guide. " : "") + `From ${c.plName}. OK for options, H to hide or show.`,
        },
        act: () => channelDialog(c),
      });
    }
    if (!App.all.length) {
      out.push({ label: "", text: "No channels yet: add a playlist first", info: { title: "No Channels" }, act: () => go(0) });
    }
    return out;
  }

  function optionRows() {
    const p = Store.cfg.prefs;
    return [
      {
        label: "CC", text: "Subtitles When Available", tag: p.ccDefault ? "On" : "Off",
        info: { title: "Subtitles When Available", desc: "Turn subtitles on automatically when a channel has them. Press C while watching to switch them on or off." },
        act: () => { App.setPrefs({ ccDefault: !p.ccDefault }); render(); },
      },
      {
        label: "CC", text: "Subtitle Size", tag: ["Small", "Medium", "Large"][p.ccSize] || "Medium",
        info: { title: "Subtitle Size", desc: "Size of subtitle text on the picture." },
        act: () => { App.setPrefs({ ccSize: ((p.ccSize | 0) + 1) % 3 }); render(); },
      },
      {
        label: "Proxy", text: "CORS Proxy for Playlists", tag: p.proxy ? "On" : "None",
        info: { title: "CORS Proxy", desc: "Some playlist servers block web pages from downloading them. A CORS proxy can fetch them for you. Not used for video." },
        act: proxyDialog,
      },
      {
        label: "Help", text: "Remote Control Keys",
        info: { title: "Remote Control Keys", desc: "Keyboard shortcuts for the guide and the player." },
        act: helpDialog,
      },
      {
        label: "Erase", text: "Erase All Settings & Playlists",
        info: { title: "Erase Everything", desc: "Remove every playlist, the channel order and all options from this browser." },
        act: () => Dialog.confirm("Erase Everything", "Remove all playlists, channel order and options?", "Erase", async () => {
          await Store.reset();
          location.reload();
        }),
      },
    ];
  }

  const rows = () => (M.page === 0 ? playlistRows() : M.page === 1 ? channelRows() : optionRows());

  // ------------------------------------------------------------------ render
  function div(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function render() {
    if (App.mode !== "menu") return;
    const list = rows();
    const sel = (M.sel[M.page] = U.clamp(M.sel[M.page], 0, list.length - 1));
    let top = M.top[M.page];
    if (sel < top) top = sel;
    if (sel >= top + VIS) top = sel - VIS + 1;
    top = M.top[M.page] = U.clamp(top, 0, Math.max(0, list.length - VIS));

    $("m-page").textContent = PAGES[M.page];
    const frag = document.createDocumentFragment();
    const toFit = [];
    for (let i = top; i < Math.min(list.length, top + VIS); i++) {
      const r = list[i];
      const row = div("m-row" + (i === sel ? " sel" : "") + (r.cls ? " " + r.cls : ""));
      row.style.top = (i - top) * PITCH + "px";
      const text = div("m-text");
      const cell = div("m-cell");
      cell.appendChild(text);
      if (r.tag) cell.appendChild(div("m-tag", r.tag));
      row.append(div("m-label", r.label), cell);
      if (M.moving && r.key === M.moving) row.appendChild(div("m-updown", "▲▼"));
      row.addEventListener("click", () => {
        if (M.moving) return drop();
        if (M.sel[M.page] === i) activate();
        else { M.sel[M.page] = i; render(); }
      });
      frag.appendChild(row);
      toFit.push([text, r.text]);
    }
    rowsEl.replaceChildren(frag);
    for (const [el, t] of toFit) U.fitText(el, t, true);

    const cur = list[sel];
    App.showInfo(cur.info || { title: cur.text });
    $("m-pos").textContent = list.length > VIS ? `${sel + 1} of ${list.length}` : "";
    $("m-hint").textContent = M.moving
      ? "▲▼ Move Channel · OK Done"
      : M.page === 1
        ? "▲▼ Select · OK Options · H Hide · ◀▶ Page · Esc Guide"
        : "▲▼ Select · OK Choose · ◀▶ Page · Esc Guide";
  }

  // ------------------------------------------------------------- navigation
  function selBy(d) {
    const n = rows().length;
    M.sel[M.page] = U.clamp(M.sel[M.page] + d, 0, n - 1);
    render();
  }
  function go(page) {
    M.moving = null;
    M.page = (page + PAGES.length) % PAGES.length;
    render();
  }
  function activate() {
    const r = rows()[M.sel[M.page]];
    if (r && r.act) r.act();
  }
  function close() {
    M.moving = null;
    App.openGuide();
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
      M.sel[0] = 2 + Store.cfg.playlists.indexOf(pls[pls.length - 1]);
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
        "Guide: Arrows browse · OK tune · Shift+◀▶ day · G/Esc TV",
        "TV: ▲▼ channel · 0-9 tune · L last · I info · G guide",
        "Space pause · ◀ back 10s · ▶ ahead 30s · P progress bar",
        "C subtitles · [ ] offset 0.1s · { } 1s · \\ reset · V subtitle file",
        "M mute · F full screen · S settings",
      ].join("\n"),
      buttons: [{ label: "OK" }],
    });
  }

  // ------------------------------------------------------------------- input
  function key(e) {
    const k = e.key;
    if (M.moving) {
      switch (k) {
        case "ArrowUp": moveBy(-1); break;
        case "ArrowDown": moveBy(1); break;
        case "PageUp": moveBy(-VIS); break;
        case "PageDown": moveBy(VIS); break;
        case "Home": moveBy(-1e9); break;
        case "End": moveBy(1e9); break;
        case "Enter": case " ": case "Escape": case "Backspace": drop(); break;
        default: return false;
      }
      return true;
    }
    if (/^[0-9]$/.test(k) && M.page === 1) { numEntry(k); return true; }
    switch (k) {
      case "ArrowUp": selBy(-1); break;
      case "ArrowDown": selBy(1); break;
      case "PageUp": selBy(-VIS); break;
      case "PageDown": selBy(VIS); break;
      case "Home": selBy(-1e9); break;
      case "End": selBy(1e9); break;
      case "ArrowLeft": go(M.page - 1); break;
      case "ArrowRight": case "Tab": go(M.page + 1); break;
      case "Enter": case " ": activate(); break;
      case "h": case "H": { const c = channelAt(M.sel[1]); if (c) setHidden(c, !c.hidden); break; }
      case "f": case "F": App.act.fullscreen(); break;
      case "Escape": case "Backspace": case "s": case "S": case "g": case "G": close(); break;
      default: return false;
    }
    return true;
  }

  $("m-prev").addEventListener("click", () => go(M.page - 1));
  $("m-next").addEventListener("click", () => go(M.page + 1));
  $("m-page").addEventListener("click", () => go(M.page + 1));

  window.Settings = {
    open(page) {
      if (typeof page === "number") M.page = page;
      M.moving = null;
      render();
    },
    render,
    key,
    wheel(d) { if (M.moving) moveBy(d); else selBy(d); },
    addFiles,
  };
})();
