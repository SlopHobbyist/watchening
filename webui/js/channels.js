/*
 * Channels of our own, made from the shows on a Plex or Jellyfin server: one
 * show (all of it, or some of its seasons) playing around the clock, in order
 * or shuffled. The server keeps them and works out their schedules
 * (auth/channels.mjs), so everyone is shown the same episode at the same
 * moment; they're in the guide with the other channels (main.js adds them).
 *
 * Playing one: the episode on now, from the right point, through this TV's
 * own On Demand connection to that server (the source with the same server
 * id). When it ends, the next one on the schedule. Like live TV, there's no
 * pausing or seeking; the control bar has Start Over and Skip instead. Alone
 * on the channel, they happen at once; with other TVs watching, they're a
 * vote, carried out when more than half the TVs agree (the others see it
 * coming up on screen). Votes change the schedule for everyone.
 *
 * While a channel is on (in the picture or the guide's), this TV says so to
 * the server every few seconds, and hears who else is watching and how a vote
 * stands. Other TVs pick up schedule changes within a minute.
 *
 * Making and changing channels (Settings, Custom Channels) is for admins.
 * Watching a channel doesn't mark episodes watched on the media server.
 */
(function () {
  "use strict";
  const DAY = 864e5;
  const BEAT = 6000;        // saying "watching" (and hearing about votes)
  const POLL = 60e3;        // schedule changes, when not watching one
  const TYPES = ["plex", "jellyfin"];
  const viewer = (crypto.randomUUID ? crypto.randomUUID() : U.uid() + U.uid()).replace(/[^a-z0-9-]/gi, "");

  const C = {
    rev: -1,
    defs: [],        // the channels, as the server sends them (with sched: [[start, end, ep, pos]])
    edit: false,     // this person can make and change channels
    known: false,    // the server has answered
    state: null,     // the channel being watched: { id, viewers, votes, done, ... } from the server
  };
  let win = { from: 0, to: 0 };   // the schedule's window
  const progs = new Map();        // channel id -> guide listings (made when asked for)

  // ------------------------------------------------------------------ server
  async function api(method, path, body, keepalive) {
    let res;
    try {
      res = await fetch(path, {
        method, cache: "no-store", keepalive: !!keepalive,
        headers: Object.assign({ Accept: "application/json" }, body !== undefined ? { "Content-Type": "application/json" } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("Couldn't reach the server");
    }
    let data = {};
    try { data = (await res.json()) || {}; } catch { /* empty */ }
    if (!res.ok) throw Object.assign(new Error(data.error || `The server answered ${res.status}`), { status: res.status });
    return data;
  }

  /** The channels and their schedules (from a few hours ago to past the
   *  guide's last day). true if anything changed. */
  let loading = null;
  function load(force) {
    if (!U.server.known) return Promise.resolve(false);
    if (loading) return loading.then(() => (force ? load(true) : false));
    loading = (async () => {
      const now = Date.now();
      const slid = now - win.from > 6 * 3600e3 || win.to - now < 8.5 * DAY;
      const w = force || slid || !C.known ? { from: now - 3 * 3600e3, to: now + 9.5 * DAY } : win;
      const q = new URLSearchParams({ from: Math.round(w.from), to: Math.round(w.to) });
      if (w === win) q.set("rev", C.rev);
      const d = await api("GET", "/api/channels?" + q);
      C.known = true;
      if (d.same) return false;
      win = w;
      C.rev = d.rev;
      C.edit = !!d.edit;
      C.defs = (d.channels || []).map((c) => Object.assign(c, { sched: c.sched || [] }));
      progs.clear();
      return true;
    })().finally(() => { loading = null; });
    return loading;
  }

  /** Load again; if anything changed, rebuild the guide and catch up the picture. */
  async function refresh(force) {
    let changed = false;
    try { changed = await load(force); } catch { return; }
    if (!changed) return;
    App.rebuild();
    catchUp();
  }

  const byId = (id) => C.defs.find((d) => d.id === id) || null;
  /** This TV's On Demand source for a channel's server. */
  const sourceFor = (d) => OnDemand.sources().find((s) => s.type === d.src.type && s.server && s.server.id === d.src.server) || null;
  /** What's on a channel at time t: { start, end, i (its episode), pos } */
  function entryAt(d, t) {
    const a = d.sched;
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid][1] <= t) lo = mid + 1;
      else if (a[mid][0] > t) hi = mid - 1;
      else return { start: a[mid][0], end: a[mid][1], i: a[mid][2], pos: a[mid][3] };
    }
    return null;
  }
  const epCode = (ep) => (ep.season != null && ep.episode != null ? `S${ep.season} E${ep.episode}` : "");

  // ------------------------------------------------------------ in the guide
  /** The channel-like objects for the guide (main.js gives them numbers and listings). */
  function channels() {
    return C.defs.map((d) => {
      const src = sourceFor(d);
      const p = src && OnDemand.providers[src.type];
      let logo = "";
      try { logo = p && p.logo ? p.logo(src, d.show.id) : ""; } catch { /* none */ }
      return {
        key: "chan|" + d.id, url: "", name: d.name, call: U.shortName(d.name), logo,
        group: d.show.title, tvgId: "", tvgName: "", plId: "channels", plName: "Custom Channels",
        embed: false, hd: false, custom: d.id, resolve: () => resolve(d.id),
      };
    });
  }

  /** A channel's guide listings: the show, with the episode as the subtitle. */
  function programs(id) {
    if (progs.has(id)) return progs.get(id);
    const d = byId(id);
    const out = !d ? [] : d.sched.map(([start, end, i, pos]) => {
      const ep = d.eps[i] || {};
      const code = epCode(ep);
      return {
        title: d.show.title || d.name, sub: ep.title || "", start, end, pos, cat: "",
        rating: ep.rating || "", desc: [code && `(${code})`, ep.desc].filter(Boolean).join(" "),
      };
    });
    progs.set(id, out);
    return out;
  }

  // ----------------------------------------------------------------- playing
  /** What's playing: { id, pos, start, end, src, pl, subs } */
  let playing = null, resolving = 0;

  function release() {
    if (!playing) return;
    const p = OnDemand.providers[playing.src.type];
    if (p && p.release) { try { p.release(playing.src, playing.pl); } catch { /* */ } }
    playing = null;
  }

  /** For the player: the episode on now, from where it's got to. */
  async function resolve(id) {
    const my = ++resolving;
    let d = byId(id);
    if (!d) throw new Error("This channel isn't on the server any more");
    let e = entryAt(d, Date.now());
    if (!e) {
      // past the end of what was loaded
      try { await load(true); } catch { /* */ }
      d = byId(id);
      e = d && entryAt(d, Date.now());
    }
    if (!e) throw new Error("Nothing is on this channel right now");
    const src = sourceFor(d);
    if (!src) throw new Error(`This channel plays from ${d.src.name}, which isn't in On Demand on this TV. Add it in Settings, On Demand.`);
    const p = OnDemand.providers[src.type];
    const ep = d.eps[e.i];
    const item = { id: ep.id, type: "episode", title: ep.title, show: d.show.title, season: ep.season, episode: ep.episode, dur: ep.dur };
    const pl = await p.play(src, item, { at: Math.max(0, (Date.now() - e.start) / 1000), burn: null });
    if (my !== resolving) {
      // changed channel meanwhile
      if (p.release) p.release(src, pl);
      throw new Error("Tuning...");
    }
    release();
    playing = { id, pos: e.pos, start: e.start, end: e.end, src, pl, subs: pl.subs || [], subsDone: false };
    // (starting it took a moment: begin that much further in)
    return { url: pl.url, ours: !!pl.ours, start: Math.max(0, (Date.now() - e.start) / 1000) };
  }

  /** Start what's on now again (the next episode, or the schedule moved),
   *  keeping the subtitles as they were. */
  let wantSubs = false;
  function retune(ch) {
    const off = Player.ccOffset;
    wantSubs = Player.cc === Player.EXT;
    Player.load(ch);
    Player.setOffset(off);
  }

  /** After the schedule changes: if the picture is behind it, catch up. */
  function catchUp() {
    const ch = Player.ch;
    if (!ch || !ch.custom || Player.loading || !playing || playing.id !== ch.custom) return;
    const d = byId(ch.custom);
    if (!d) return;
    const e = entryAt(d, Date.now());
    if (!e || e.pos !== playing.pos || e.start !== playing.start) retune(ch);
  }

  /** A text subtitle file from the server, shown by the player. */
  async function showSub(sub) {
    const ch = Player.ch;
    const text = await U.fetchText(sub.url);
    if (Player.ch !== ch) return;
    Player.loadSubs(sub.label, text);
  }

  // -------------------------------------------------------------- watching
  let watchingId = null, errAt = 0, lastNote = "", lastDone = 0;

  function leave(id) {
    api("POST", `/api/channels/${id}/leave`, { viewer }, true).catch(() => {});
  }

  setInterval(() => {
    const ch = Player.ch;
    const id = (ch && ch.custom) || null;
    if (watchingId !== id) {
      if (watchingId) leave(watchingId);
      watchingId = id;
      C.state = null;
      lastNote = "";
      if (id) beat();
    }
    if (!id) { if (playing) release(); return; }
    if (Player.loading) return;
    if (Player.error) {
      // try again now and then (the server may be back)
      if (!errAt) errAt = Date.now();
      else if (Date.now() - errAt > 30000) { errAt = 0; retune(ch); }
      return;
    }
    errAt = 0;
    if (!playing || playing.id !== id) return;
    // the episode's time is up, or a vote (or an admin) moved the schedule: catch up
    const d = byId(id), e = d && entryAt(d, Date.now());
    if (Date.now() >= playing.end || (e && (e.pos !== playing.pos || e.start !== playing.start))) return retune(ch);
    if (!playing.subsDone) {
      playing.subsDone = true;
      const sub = playing.subs.find((s) => s.url && s.selected) || playing.subs.find((s) => s.url);
      if (sub && (wantSubs || Store.cfg.prefs.ccDefault)) showSub(sub).catch(() => {});
      wantSubs = false;
    }
  }, 1000);

  // the video ran out at (about) the end of its time: on to the next now
  // (the timer above can be slow in a tab that isn't showing)
  Player.on((type) => {
    const ch = Player.ch;
    if (type === "ended" && ch && ch.custom && playing && playing.id === ch.custom && Date.now() >= playing.end - 3000) {
      const was = playing;
      setTimeout(() => {
        const now = Player.ch;
        if (now && now.custom === ch.custom && playing === was && !Player.loading) retune(now);
      }, Math.max(0, playing.end - Date.now()));
    }
  });

  /** Tell the server this TV is watching; hear who else is, and the votes. */
  async function beat() {
    const id = watchingId;
    if (!id) return;
    try {
      onState(id, await api("POST", `/api/channels/${id}/watch`, { viewer }));
    } catch (e) {
      if (e.status === 404) refresh(true);
    }
  }
  setInterval(beat, BEAT);

  const VERB = { restart: "start this episode over", skip: "skip this episode" };
  function onState(id, st) {
    if (id !== watchingId) return;
    C.state = Object.assign({ id }, st);
    if (st.rev !== C.rev) refresh(true);
    // a vote passed (on another TV, or ours)
    if (st.done && st.done.at > lastDone) {
      lastDone = st.done.at;
      App.osd(st.done.action === "skip" ? "Skipped to the next episode by vote" : "Started over by vote", 4000);
    }
    // a vote someone else started: say so once, and as it changes
    let note = "";
    for (const a of ["skip", "restart"]) {
      const v = st.votes && st.votes[a];
      if (v && v.n && !v.mine) {
        note = `${v.n} of ${st.viewers} TVs want to ${VERB[a]} (${v.need} needed). To agree: OK, then ${a === "skip" ? "Skip" : "Start Over"}.`;
        break;
      }
    }
    if (note && note !== lastNote && App.mode === "watch") App.osd(note, 7000);
    lastNote = note;
    if (App.refreshControls) App.refreshControls();
  }

  /** Start Over or Skip, from the control bar: a vote, carried out at once
   *  when this TV is the only one watching. Again takes the vote back. */
  async function vote(action) {
    const ch = Player.ch;
    if (!ch || !ch.custom) return;
    if (!playing || playing.id !== ch.custom || Player.loading) return App.osd("The channel is still starting", 2500);
    const st = C.state && C.state.id === ch.custom ? C.state : null;
    try {
      if (st && st.votes[action].mine) {
        onState(ch.custom, await api("POST", `/api/channels/${ch.custom}/unvote`, { viewer }));
        return App.osd("Vote taken back", 2500);
      }
      const r = await api("POST", `/api/channels/${ch.custom}/vote`, { viewer, action, pos: playing.pos });
      if (r.applied) {
        lastDone = r.done ? r.done.at : Date.now();
        App.osd(action === "skip" ? "Skipping to the next episode..." : "Starting the episode over...", 3000);
        onState(ch.custom, r);
        await refresh(true);
      } else {
        const v = r.votes[action];
        App.osd(`You voted to ${VERB[action]}: ${v.n} of the ${v.need} TVs needed so far. Press it again to take your vote back.`, 6000);
        onState(ch.custom, r);
      }
    } catch (e) {
      App.osd(e.message, 4000);
      if (e.status === 409) refresh(true);
    }
  }

  /** The control bar's button text: "Skip", "Skip 1/2", "Skip ✓1/2" (voted). */
  function voteText(action) {
    const base = action === "skip" ? "Skip" : "Start Over";
    const st = C.state;
    const v = st && Player.ch && st.id === Player.ch.custom && st.votes && st.votes[action];
    if (!v || !v.n || v.need <= 1) return base;
    return `${base} ${v.mine ? "✓" : ""}${v.n}/${v.need}`;
  }

  // schedule changes made elsewhere, for the guide
  setInterval(() => { if (!document.hidden && !watchingId) refresh(false); }, POLL);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(false); });
  window.addEventListener("pagehide", () => { if (watchingId) leave(watchingId); release(); });

  // --------------------------------------------------------------- settings
  const showSources = () => OnDemand.sources().filter((s) => TYPES.includes(s.type));
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  function seasonsText(d) {
    const s = d.seasons;
    if (!s) return "";
    return s[0] === s[1] ? `, season ${s[0]}` : `, seasons ${s[0]}-${s[1]}`;
  }

  /** Settings, Custom Channels: its rows. */
  function settingsRows() {
    if (!U.server.known) {
      return [{ text: "Not Available Here", info: { title: "Custom Channels", desc: "Custom channels are kept on Watchening's own server (docker compose), and this copy isn't running on one." } }];
    }
    const out = [];
    if (C.edit) {
      out.push({
        text: "Make a Channel",
        info: {
          title: "Make a Channel",
          desc: "A channel that plays one show around the clock, in order or shuffled, from your Plex or Jellyfin server. Everyone watching sees the same episode; Start Over and Skip go to a vote when more than one TV is on it. Pick the show, which seasons, and a name.",
        },
        act: makeDialog,
      });
    }
    for (const d of C.defs) {
      const ch = App.all.find((c) => c.custom === d.id);
      const e = entryAt(d, Date.now()), ep = e && d.eps[e.i];
      const src = sourceFor(d);
      out.push({
        text: d.name, tag: (ch && ch.hidden ? "Hidden · " : "") + (d.order === "shuffle" ? "Shuffle" : "In Order"),
        cls: (ch && ch.hidden ? "off" : "") + (src ? "" : " warn"),
        info: {
          title: d.name, chan: ch ? `${ch.n} ${ch.call}` : "",
          desc: [
            `${d.show.title}${seasonsText(d)}: ${plural(d.eps.length, "episode")}, ${d.order === "shuffle" ? "shuffled" : "in order"}, from ${d.src.name}`,
            ep ? `On now: ${[epCode(ep), ep.title && `"${ep.title}"`].filter(Boolean).join(" ")}` : "",
            src ? "" : `This TV can't play it: ${d.src.name} isn't in its On Demand (Settings, On Demand)`,
            C.edit ? "OK to watch or change it" : "OK to watch it",
          ].filter(Boolean).join(". ") + ".",
        },
        act: () => channelDialog(d),
      });
    }
    if (!C.defs.length) {
      out.push({
        text: C.edit ? "No Channels Yet" : "No Channels Yet: an admin can make some",
        info: { title: "No Custom Channels", desc: C.edit ? "Make a Channel (above) to add one." : "Admins can make channels that play a show around the clock. Ask one to make some." },
      });
    }
    return out;
  }
  const rerender = () => { if (window.Settings) Settings.render(); };

  /** After a change: load the channels again, and show it. */
  async function changedNow() {
    await refresh(true);
    rerender();
  }

  function makeDialog() {
    const srcs = showSources();
    if (!srcs.length) {
      return Dialog.open({
        title: "Make a Channel",
        text: "Channels play shows from a Plex or Jellyfin server. Add yours in Settings, On Demand, first.",
        buttons: [{ label: "OK" }],
      });
    }
    if (srcs.length === 1) return findDialog(srcs[0], "");
    Dialog.open({
      title: "Make a Channel",
      text: "Which server is the show on?",
      buttons: srcs.map((s) => ({ label: s.name, act: () => findDialog(s, "") })).concat([{ label: "Cancel" }]),
    });
  }

  /** Shows on `src` matching what's typed, from each of its TV libraries. */
  async function findShows(src, q) {
    const p = OnDemand.providers[src.type];
    const libs = (await OnDemand.libraries(src)).filter((l) => l.kind !== "movie");
    if (!libs.length) throw new Error(`${src.name} has no TV show libraries`);
    const found = await Promise.all(libs.map((l) => p.search(src, l, q).then((r) => r.items, () => [])));
    const seen = new Set();
    return found.flat().filter((it) => it.type === "show" && !seen.has(it.id) && seen.add(it.id));
  }

  function findDialog(src, q) {
    Dialog.open({
      title: "Make a Channel",
      text: `Type the name of a show on ${src.name}.`,
      fields: [{ id: "q", label: "Show", value: q, placeholder: "Futurama" }],
      buttons: [
        {
          label: "Search",
          act: async (v) => {
            if (!v.q) { Dialog.message("Type part of the show's name first.", true); return false; }
            Dialog.message("Searching...");
            let shows;
            try { shows = await findShows(src, v.q); } catch (e) { Dialog.message(e.message, true); return false; }
            if (!shows.length) { Dialog.message(`No show on ${src.name} matches "${v.q}".`, true); return false; }
            Dialog.open({
              title: "Make a Channel",
              text: "Which show?",
              buttons: shows.slice(0, 8).map((s) => ({
                label: s.year ? `${s.title} (${s.year})` : s.title,
                act: () => seasonsDialog(src, s, null),
              })).concat([{ label: "Search Again", act: () => findDialog(src, v.q) }, { label: "Cancel" }]),
            });
          },
        },
        { label: "Cancel" },
      ],
    });
  }

  /** Every episode of a show that can be scheduled, in order. */
  async function showEpisodes(src, show) {
    const p = OnDemand.providers[src.type];
    const eps = await p.episodes(src, { id: show.id, type: "show", title: show.title });
    const key = (e) => [e.season == null ? 1e6 : e.season, e.episode == null ? 1e6 : e.episode];
    return eps.filter((e) => e.dur >= 30).sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      return x[0] - y[0] || x[1] - y[1];
    });
  }
  const epOut = (e) => ({
    id: e.id, title: e.title, season: e.season == null ? null : e.season, episode: e.episode == null ? null : e.episode,
    dur: e.dur, desc: String(e.desc || "").slice(0, 400), rating: e.rating || "", aired: e.aired || "",
  });
  /** The episodes in seasons first-last (or all, when the show has no season numbers). */
  function inSeasons(eps, first, last) {
    if (first == null) return eps;
    return eps.filter((e) => e.season != null && e.season >= first && e.season <= last);
  }

  /**
   * Choose the seasons (and, for a new channel, the name and order). `d`: an
   * existing channel, changing its seasons. Fetches the episode list itself,
   * so it's also how new episodes get onto a channel.
   */
  async function seasonsDialog(src, show, d) {
    Dialog.message("Getting the episode list...");
    let eps;
    try { eps = await showEpisodes(src, show); } catch (e) { Dialog.message(e.message, true); return false; }
    if (!eps.length) { Dialog.message("That show has no episodes with a running time, so there's nothing to schedule.", true); return false; }
    const seasons = [...new Set(eps.map((e) => e.season).filter((s) => s != null))].sort((a, b) => a - b);
    const regular = seasons.filter((s) => s > 0);
    const has = seasons.length > 0;
    const first = d && d.seasons ? d.seasons[0] : regular.length ? regular[0] : seasons[0];
    const last = d && d.seasons ? d.seasons[1] : seasons[seasons.length - 1];
    const fields = [];
    if (!d) fields.push({ id: "name", label: "Channel name", value: show.title.slice(0, 40) });
    if (has) {
      fields.push({ id: "first", label: "First season", value: String(first) });
      fields.push({ id: "last", label: "Last season", value: String(last) });
    }
    const pick = (v) => {
      if (!has) return { range: null, picked: eps };
      const a = parseInt(v.first, 10), b = parseInt(v.last, 10);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) throw new Error("Enter the first and last season as numbers, the first no later than the last.");
      const picked = inSeasons(eps, a, b);
      if (!picked.length) throw new Error(`There are no episodes in season${a === b ? ` ${a}` : `s ${a}-${b}`}.`);
      return { range: [a, b], picked };
    };
    const text = `${show.title}: ${plural(eps.length, "episode")}` +
      (has ? ` in ${plural(seasons.length, "season")} (${seasons[0]}-${seasons[seasons.length - 1]}${seasons[0] === 0 ? "; season 0 is usually specials" : ""}).` : ".") +
      (d ? " Choose which seasons the channel plays. Its schedule starts again after the episode on now." : " Choose which seasons the channel plays, and its name.");
    const make = (order) => async (v) => {
      let r;
      try { r = pick(v); } catch (e) { Dialog.message(e.message, true); return false; }
      const name = (v.name || "").trim();
      if (!d && !name) { Dialog.message("Give the channel a name.", true); return false; }
      Dialog.message(d ? "Saving..." : "Making the channel...");
      try {
        if (d) await api("PATCH", `/api/channels/${d.id}`, { seasons: r.range, eps: r.picked.map(epOut) });
        else {
          await api("POST", "/api/channels", {
            name, order, seasons: r.range,
            src: { type: src.type, server: src.server.id, name: src.name },
            show: { id: show.id, title: show.title }, eps: r.picked.map(epOut),
          });
        }
      } catch (e) { Dialog.message(e.message, true); return false; }
      await changedNow();
      const ch = App.all.find((c) => c.name === (d ? d.name : name) && c.custom);
      App.osd(d ? `${d.name}: ${plural(r.picked.length, "episode")}` : `Made ${name}${ch ? `: channel ${ch.n}` : ""}`, 4000);
    };
    Dialog.open({
      title: d ? `${d.name}: Seasons` : "Make a Channel",
      text,
      fields,
      buttons: (d
        ? [{ label: "Save", act: make(d.order) }]
        : [{ label: "Make Channel: Shuffled", act: make("shuffle") }, { label: "Make Channel: In Order", act: make("order") }]
      ).concat([{ label: "Cancel" }]),
    });
  }

  function channelDialog(d) {
    const src = sourceFor(d);
    const needSrc = (fn) => async () => {
      if (!src) { Dialog.message(`This TV doesn't have ${d.src.name} in On Demand, so it can't look at the show's episodes.`, true); return false; }
      return fn();
    };
    const patch = (body, done) => async () => {
      try { await api("PATCH", `/api/channels/${d.id}`, body); } catch (e) { Dialog.message(e.message, true); return false; }
      await changedNow();
      if (done) App.osd(done, 3000);
    };
    Dialog.open({
      title: d.name,
      text: `${d.show.title}${seasonsText(d)}: ${plural(d.eps.length, "episode")}, ${d.order === "shuffle" ? "shuffled" : "in order"}, from ${d.src.name}.`,
      buttons: [
        {
          label: "Watch",
          act: () => {
            if (!App.tuneKey("chan|" + d.id)) { Dialog.message("This channel is hidden from the guide. Show it again in Settings, Channels.", true); return false; }
            App.watch();
          },
        },
        C.edit && { label: "Rename", act: () => renameDialog(d) },
        C.edit && {
          label: d.order === "shuffle" ? "Play in Order" : "Shuffle",
          act: patch({ order: d.order === "shuffle" ? "order" : "shuffle" }, d.order === "shuffle" ? `${d.name}: in order, after this episode` : `${d.name}: shuffled, after this episode`),
        },
        C.edit && { label: "Change Seasons", act: needSrc(() => seasonsDialog(src, d.show, d)) },
        C.edit && d.seasons && {
          label: "Look for New Episodes",
          act: needSrc(async () => {
            Dialog.message("Getting the episode list...");
            let eps;
            try { eps = inSeasons(await showEpisodes(src, d.show), d.seasons[0], d.seasons[1]); } catch (e) { Dialog.message(e.message, true); return false; }
            const have = new Set(d.eps.map((e) => e.id));
            const fresh = eps.filter((e) => !have.has(e.id)).length, gone = d.eps.length - (eps.length - fresh);
            if (!fresh && !gone) { Dialog.message(`No new episodes: still ${plural(d.eps.length, "episode")}.`, true); return false; }
            if (!eps.length) { Dialog.message("None of the channel's episodes are on the server any more.", true); return false; }
            return patch({ eps: eps.map(epOut) }, `${d.name}: ${plural(fresh, "new episode")}${gone ? `, ${gone} gone` : ""}`)();
          }),
        },
        C.edit && !d.seasons && {
          label: "Look for New Episodes",
          act: needSrc(async () => {
            Dialog.message("Getting the episode list...");
            let eps;
            try { eps = await showEpisodes(src, d.show); } catch (e) { Dialog.message(e.message, true); return false; }
            if (!eps.length) { Dialog.message("None of the show's episodes are on the server any more.", true); return false; }
            return patch({ eps: eps.map(epOut) }, `${d.name}: ${plural(eps.length, "episode")}`)();
          }),
        },
        C.edit && {
          label: "Remove",
          act: () => Dialog.confirm("Remove Channel", `Remove ${d.name} for everyone?`, "Remove", async () => {
            try { await api("DELETE", `/api/channels/${d.id}`); } catch (e) { Dialog.message(e.message, true); return false; }
            await changedNow();
            App.osd(`Removed ${d.name}`, 3000);
          }),
        },
        { label: "Cancel" },
      ].filter(Boolean),
    });
  }

  function renameDialog(d) {
    Dialog.open({
      title: `Rename ${d.name}`,
      fields: [{ id: "name", label: "Channel name", value: d.name }],
      buttons: [
        {
          label: "Save",
          act: async (v) => {
            if (!v.name) { Dialog.message("Give the channel a name.", true); return false; }
            try { await api("PATCH", `/api/channels/${d.id}`, { name: v.name }); } catch (e) { Dialog.message(e.message, true); return false; }
            await changedNow();
          },
        },
        { label: "Cancel" },
      ],
    });
  }

  // ------------------------------------------------------------------- api
  window.Channels = {
    load: () => load(true).catch(() => false),
    channels,
    programs,
    vote,
    voteText,
    /** The playing channel's subtitle file, if it has one (for C). */
    subFile: () => (playing && Player.ch && playing.id === Player.ch.custom ? playing.subs.find((s) => s.url) || null : null),
    showSub,
    settingsRows,
    count: () => C.defs.length,
  };
})();
