/*
 * Channels of our own, made from the shows on a Plex or Jellyfin server: one
 * show (all of it, or some of its seasons) playing around the clock, in order
 * or shuffled. The server keeps them and works out their schedules
 * (auth/channels.mjs), so everyone is shown the same episode at the same
 * moment; they're in the guide with the other channels (main.js adds them).
 *
 * Playing one: the episode on now, from the right point, through this TV's
 * own On Demand connection to that server (the source with the same server
 * id). When it ends, the next one on the schedule. Everyone sees the same
 * moment, so pausing and seeking are for everyone: play/pause asks to pause
 * it for a few minutes, the control bar's ◀▶ to go to another point, and its
 * Vote button has Start Over, Previous (that one, then this one again),
 * Skip, Play Next in Order (the show's next episode after this one, even
 * when shuffled: for two-parters), Pause and Resume. Alone on the channel,
 * they happen at once; with other TVs watching, they're a vote, carried out
 * when more than half the TVs agree (the others see it coming up on screen).
 * Votes change the schedule for everyone. Skip Intro and Skip Credits show
 * over the picture as Plex's do (a vote too), unless the channel skips them
 * itself (an admin's setting: the schedule leaves them out). Continue in On
 * Demand (in Vote) plays the episode on its own, from the same point.
 *
 * While a channel is on (in the picture or the guide's), this TV says so to
 * the server every few seconds, and hears who else is watching and how a vote
 * stands. Other TVs pick up schedule changes within a minute.
 *
 * Making and changing channels (Settings, Custom Channels) is for admins.
 * A channel's seasons can run to the latest one; admins' TVs look for new
 * episodes every few hours (checkNew, below).
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
  /** What's on a channel at time t: { start, end, i (its episode), pos, off
   *  (how far into the episode it starts, the channel's seconds), pause } */
  function entryAt(d, t) {
    const a = d.sched;
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const x = a[mid];
      if (x[1] <= t) lo = mid + 1;
      else if (x[0] > t) hi = mid - 1;
      else return { start: x[0], end: x[1], i: x[2], pos: x[3], off: x[4] || 0, pause: !!x[5] };
    }
    return null;
  }
  const epCode = (ep) => (ep.season != null && ep.episode != null ? `S${ep.season} E${ep.episode}` : "");

  /*
   * The channel's time and the video's: with Skip Intros on, a channel's
   * episode leaves its intro out (and with Skip Credits, stops where the end
   * credits start), so seconds into the episode on the channel aren't
   * seconds into the video. (The same sums as the server's.)
   */
  function cutsOf(d, ep) {
    const s = d.skip || {};
    const end = s.credits && ep.credits ? ep.credits : ep.dur;
    const intro = s.intro && ep.intro && ep.intro[1] < end ? ep.intro : null;
    return { intro, end };
  }
  /** An episode's length on the channel (s). */
  const chanDur = (d, ep) => { const c = cutsOf(d, ep); return c.end - (c.intro ? c.intro[1] - c.intro[0] : 0); };
  /** The channel's seconds into an episode -> the video's. */
  const toMedia = (d, ep, x) => { const c = cutsOf(d, ep); return c.intro && x >= c.intro[0] ? x + c.intro[1] - c.intro[0] : x; };
  /** ...and back (inside a skipped intro: where it starts). */
  const fromMedia = (d, ep, t) => {
    const c = cutsOf(d, ep);
    return !c.intro || t < c.intro[0] ? t : Math.max(c.intro[0], t - (c.intro[1] - c.intro[0]));
  };
  /** How far into its episode entry `e` is at `now` (the channel's seconds). */
  const chanAt = (e, now) => (e.pause ? e.off : e.off + Math.max(0, now - e.start) / 1000);

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
    const out = !d ? [] : d.sched.map(([start, end, i, pos, , paused]) => {
      const ep = d.eps[i] || {};
      const code = epCode(ep);
      return {
        title: d.show.title || d.name, sub: (ep.title || "") + (paused ? " (Paused)" : ""), start, end, pos, cat: "",
        rating: ep.rating || "", desc: [code && `(${code})`, ep.desc].filter(Boolean).join(" "),
      };
    });
    progs.set(id, out);
    return out;
  }

  // ----------------------------------------------------------------- playing
  /** What's playing: { id, i, pos, start, end, off, pause, src, pl, subs, markers } */
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
    const pl = await p.play(src, item, { at: toMedia(d, ep, chanAt(e, Date.now())), burn: null });
    if (my !== resolving) {
      // changed channel meanwhile
      if (p.release) p.release(src, pl);
      throw new Error("Tuning...");
    }
    release();
    playing = Object.assign({ id, src, pl, subs: pl.subs || [], subsDone: false, markers: pl.markers || null }, e);
    // (starting it took a moment: begin that much further in)
    return { url: pl.url, ours: !!pl.ours, start: toMedia(d, ep, chanAt(e, Date.now())) };
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

  /** The schedule has moved on to entry `e`: if it's the episode playing (a
   *  pause starting or ending, a vote to seek or start over), go on with the
   *  same video from the right point. false if it's another episode. */
  function follow(d, e) {
    if (e.i !== playing.i) return false;
    // after a long pause the server may have stopped making the stream: start it afresh
    if (playing.pause && !e.pause && Date.now() - playing.start > 60e3) return false;
    Object.assign(playing, { pos: e.pos, start: e.start, end: e.end, off: e.off, pause: e.pause });
    const t = toMedia(d, d.eps[e.i], chanAt(e, Date.now()));
    if (Math.abs(Player.time() - t) > 2) Player.jump(t);
    Player.hold(e.pause);
    return true;
  }

  /** After the schedule changes: if the picture is behind it, catch up. */
  function catchUp() {
    const ch = Player.ch;
    if (!ch || !ch.custom || Player.loading || !playing || playing.id !== ch.custom) return;
    const d = byId(ch.custom);
    const e = d && entryAt(d, Date.now());
    if (!e) return;
    if (e.pos !== playing.pos || e.start !== playing.start) { if (!follow(d, e)) retune(ch); }
    else playing.end = e.end;
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
    const d = byId(id), now = Date.now(), e = d && entryAt(d, now);
    if (!d) return;
    if (e && (e.pos !== playing.pos || e.start !== playing.start)) { if (!follow(d, e)) return retune(ch); }
    else if (!e && now >= playing.end) return retune(ch);
    else if (e) playing.end = e.end;
    Player.hold(playing.pause);
    // Skip Intros: over the intro as it comes
    const c = cutsOf(d, d.eps[playing.i]), t = Player.time();
    if (c.intro && !playing.pause && t >= c.intro[0] - 0.5 && t < c.intro[1] - 1) Player.jump(c.intro[1]);
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

  const ACTIONS = ["restart", "prev", "skip", "next", "seek", "pause", "resume"];
  const NAME = {
    restart: "Start Over", prev: "Previous", skip: "Skip", next: "Play Next in Order",
    seek: "Go To", pause: "Pause", resume: "Resume",
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  /** What a vote asks for, as "want to ...". `v`: its tally (seek's to, pause's min). */
  function verb(a, v) {
    switch (a) {
      case "restart": return "start this episode over";
      case "prev": return "go back to the previous episode";
      case "skip": return "skip this episode";
      case "next": return "play the next episode in order after this one";
      case "seek": return `go to ${U.fmtDur((v && v.to) || 0)} in this episode`;
      case "pause": return `pause for ${plural((v && v.min) || 1, "minute")}`;
      default: return "resume";
    }
  }
  const DONE = {
    restart: "Started over by vote", prev: "Back to the previous episode by vote",
    skip: "Skipped to the next episode by vote", next: "By vote, the next episode in order plays after this one",
    seek: "Moved by vote", pause: "Paused for everyone", resume: "Resumed",
  };
  function onState(id, st) {
    if (id !== watchingId) return;
    C.state = Object.assign({ id }, st);
    if (st.rev !== C.rev) refresh(true);
    // a vote passed (on another TV, or ours)
    if (st.done && st.done.at > lastDone) {
      lastDone = st.done.at;
      const p = st.pause;
      App.osd(st.done.action === "pause" && p
        ? `Paused for everyone${p.name ? ` by ${p.name}` : ""}: back in ${U.fmtDur(Math.max(0, (p.until - Date.now()) / 1000))}.` +
          (p.mine ? " Press play (or Vote, Resume) to go on now." : "")
        : DONE[st.done.action] || "Changed by vote", 5000);
    }
    // a vote someone else started: say so once, and as it changes
    let note = "";
    for (const a of ACTIONS) {
      const v = st.votes && st.votes[a];
      if (v && v.n && !v.mine) {
        const who = a === "pause" && v.name ? `${v.name} wants` : `${v.n} of ${st.viewers} TVs want`;
        note = `${who} to ${verb(a, v)} (${v.need} needed). To agree: OK, then Vote, ${a === "seek" ? `Go to ${U.fmtDur(v.to)}` : NAME[a]}.`;
        break;
      }
    }
    if (note && note !== lastNote && App.mode === "watch") App.osd(note, 7000);
    lastNote = note;
    if (App.refreshControls) App.refreshControls();
  }
  /** Ask the server how things stand now (the Vote panel opening). */
  const poke = () => beat();

  /** The state for the channel in the picture, if the server has said. */
  const stateNow = () => (C.state && Player.ch && C.state.id === Player.ch.custom ? C.state : null);
  /** The channel playing here, its episode and what's playing: or null while it starts. */
  function here() {
    const ch = Player.ch;
    if (!ch || !ch.custom || !playing || playing.id !== ch.custom || Player.loading) return null;
    const d = byId(ch.custom);
    return d ? { ch, d, ep: d.eps[playing.i] } : null;
  }

  /** A vote, carried out at once when this TV is the only one watching.
   *  Asking for the same again takes it back. `arg`: seek { to }, pause { min }. */
  async function vote(action, arg) {
    const ch = Player.ch;
    if (!ch || !ch.custom) return;
    if (!here()) return App.osd("The channel is still starting", 2500);
    const st = stateNow();
    const v = st && st.votes[action];
    const same = !arg || !v || (action === "seek" ? Math.abs((v.to == null ? -9 : v.to) - arg.to) <= 1 : v.min === arg.min);
    try {
      if (v && v.mine && same) {
        onState(ch.custom, await api("POST", `/api/channels/${ch.custom}/unvote`, { viewer }));
        return App.osd("Vote taken back", 2500);
      }
      const r = await api("POST", `/api/channels/${ch.custom}/vote`, { viewer, action, pos: playing.pos, start: playing.start, arg });
      if (r.applied) {
        lastDone = r.done ? r.done.at : Date.now();
        if (Panel.id() === "vote") Panel.close();
        App.osd({
          restart: "Starting the episode over...", prev: "Going back to the previous episode...",
          skip: "Skipping to the next episode...", next: "The next episode in order plays after this one",
          seek: `Going to ${U.fmtDur(arg ? arg.to : 0)}...`, pause: `Paused for everyone for ${plural(arg ? arg.min : 1, "minute")}`,
          resume: "Resuming...",
        }[action], 3000);
        onState(ch.custom, r);
        await refresh(true);
      } else {
        const t = r.votes[action];
        App.osd(`You voted to ${verb(action, t)}: ${t.n} of the ${t.need} TVs needed so far. Ask again to take your vote back.`, 6000);
        onState(ch.custom, r);
      }
    } catch (e) {
      App.osd(e.message, 4000);
      if (e.status === 409) refresh(true);
    }
  }

  /** How long a pause is asked for (minutes), remembered on this TV. */
  const PAUSE_KEY = "iptv.channelPause";
  let pauseMin = 5;
  try { pauseMin = U.clamp(parseInt(localStorage.getItem(PAUSE_KEY), 10) || 5, 1, 5); } catch { /* */ }
  function setPauseMin(m) {
    pauseMin = U.clamp(m, 1, 5);
    try { localStorage.setItem(PAUSE_KEY, String(pauseMin)); } catch { /* */ }
  }
  /** Play/pause on a custom channel: a vote to pause it (or resume it). */
  function pauseKey() {
    if (!here()) return;
    if (playing.pause) vote("resume");
    else vote("pause", { min: pauseMin });
  }

  /** For the control bar: the episode's length and where it's at, on the
   *  channel's time (paused: and when it goes on). null while it starts. */
  function seekInfo() {
    const h = here();
    if (!h || !h.ep || Player.error) return null;
    return { start: 0, end: chanDur(h.d, h.ep), t: chanAt(playing, Date.now()), paused: !!playing.pause, until: playing.pause ? playing.end : 0 };
  }
  /** The control bar was scrubbed to `to` (the channel's seconds): a vote to go there. */
  function seek(to) {
    if (!here()) return;
    if (playing.pause) return App.osd("It's paused: resume it first (play, or Vote, Resume)", 3000);
    vote("seek", { to: Math.round(to) });
  }

  /** Skip Intro and Skip Credits, as Plex shows them: when the channel
   *  doesn't skip them itself, a vote to go past the intro, or skip on. */
  function skipPop() {
    const h = here();
    if (!h || !h.ep || Player.error || playing.pause) return null;
    const { d, ep } = h, s = d.skip || {};
    const m = playing.markers || ep;
    const t = Player.time();
    const many = stateNow() && stateNow().viewers > 1 ? " (Vote)" : "";
    if (!s.intro && m.intro && t >= m.intro[0] && t < m.intro[1] - 1) {
      return { key: `intro|${playing.start}`, label: "Skip Intro" + many, go: () => vote("seek", { to: Math.round(fromMedia(d, ep, m.intro[1])) }) };
    }
    if (!s.credits && m.credits && t >= m.credits && t < ep.dur - 2) {
      return { key: `credits|${playing.start}`, label: "Skip Credits" + many, go: () => vote("skip") };
    }
    return null;
  }

  /** This episode, in On Demand, from where the picture is: to pause and
   *  seek on your own. */
  async function continueOnDemand() {
    const h = here();
    if (!h) return App.osd("The channel is still starting", 2500);
    const { d, ep } = h;
    const t = Player.time();
    const item = {
      id: ep.id, type: "episode", title: ep.title, show: d.show.title, season: ep.season, episode: ep.episode,
      dur: ep.dur, desc: ep.desc, rating: ep.rating, aired: ep.aired, offset: t, watched: false, cat: "", showId: d.show.id,
    };
    if (Panel.id() === "vote") Panel.close();
    App.osd("Starting it in On Demand...", 8000);
    try { await OnDemand.play(playing.src, item, { at: t }); } catch (e) { App.osd(e.message || String(e), 4000); }
  }

  /** The control bar's button: "Vote", or "Vote 1/2" ("Vote ✓1/2": this TV
   *  voted) while a vote is open. */
  function voteText() {
    const st = stateNow();
    let best = null;
    if (st && st.votes) for (const a of ACTIONS) { const v = st.votes[a]; if (v && v.n && (!best || v.n > best.n)) best = v; }
    if (!best || best.need <= 1) return "Vote";
    return `Vote ${best.mine ? "✓" : ""}${best.n}/${best.need}`;
  }

  const epName = (ep) => (ep ? [epCode(ep), ep.title && `"${ep.title}"`].filter(Boolean).join(" ") || "an episode" : "an episode");

  /** The Vote panel's rows (main.js shows them). */
  let lastProposal = "";
  function voteRows() {
    const h = here();
    if (!h) return [{ label: "The channel is still starting", disabled: true }];
    const { d } = h;
    const st = stateNow();
    const can = (st && st.can) || {};
    const up = entryAt(d, playing.end);
    const many = st && st.viewers > 1;
    const tallyOf = (a) => (st && st.votes && st.votes[a]) || { n: 0, need: 1, mine: false };
    const how = (v) => (!many ? " You're the only one watching, so it happens right away."
      : ` With ${st.viewers} TVs watching, it's a vote: it happens when ${v.need} agree.`) +
      (v.mine ? " You voted for this: choose it again to take your vote back." : "");
    const count = (v) => (v.n && v.need > 1 ? `  ${v.n}/${v.need}` : "");
    const row = (a, desc, why, label) => {
      const v = tallyOf(a);
      return {
        label: (label || NAME[a]) + count(v), check: v.mine,
        desc: why ? `${why}.` : desc + how(v),
        act: () => (why ? App.osd(`${NAME[a]}: ${why}`, 3000) : vote(a)),
      };
    };
    const ep = (r) => (r && r.i != null ? d.eps[r.i] : null);
    const rows = [];
    if (playing.pause) {
      const p = (st && st.pause) || {};
      const left = U.fmtDur(Math.max(0, (playing.end - Date.now()) / 1000));
      rows.push(p.mine
        ? { label: "Resume", desc: `You paused it: go on now, for everyone. Otherwise it goes on by itself in ${left}.`, act: () => vote("resume") }
        : row("resume", `Paused${p.name ? ` by ${p.name}` : ""}; it goes on by itself in ${left}. Resume it sooner for everyone.`));
    }
    rows.push(
      row("restart", "Start this episode again from the beginning."),
      row("prev", can.prev && can.prev.why ? "" : `Go back to ${can.prev ? epName(ep(can.prev)) : "the episode before this one"}, then this one again from the start.`, can.prev && can.prev.why),
      row("skip", `On to the next episode${up && !up.pause && up.i !== playing.i ? `, ${epName(d.eps[up.i])}` : ""}.`),
      row("next", can.next && can.next.why ? "" :
        `When this episode ends, play ${can.next ? epName(ep(can.next)) : "the show's next episode"}${d.order === "shuffle" ? ", even though the channel is shuffled, then carry on shuffling" : ""}. For two-parters.`,
      can.next && can.next.why),
    );
    // a vote to go somewhere in the episode (from the control bar): agree to it here
    const sv = tallyOf("seek");
    if (sv.n && sv.to != null) {
      rows.push({
        label: `Go to ${U.fmtDur(sv.to)}${count(sv)}`, check: sv.mine,
        desc: `Go to ${U.fmtDur(sv.to)} in this episode.` + how(sv) + " (◀▶ in the control bar picks another point.)",
        act: () => vote("seek", { to: sv.to }),
      });
    }
    if (!playing.pause) {
      // someone asked for a length: start on theirs, so agreeing is one press
      const pv = tallyOf("pause");
      const prop = pv.n && !pv.mine ? `${pv.min}|${pv.n}` : "";
      if (prop && prop !== lastProposal) pauseMin = pv.min;
      lastProposal = prop;
      rows.push({
        label: "Pause" + count(pv), value: plural(pauseMin, "min"), check: pv.mine,
        desc: (pv.n && !pv.mine ? `${pv.name || "Someone"} asked for ${plural(pv.min, "minute")}. ` : "") +
          `Hold the picture still for everyone; it goes on by itself after the time you pick (◀▶, up to 5 minutes), or sooner if you resume it.` + how(pv),
        step: (dd) => setPauseMin(pauseMin + dd),
        act: () => vote("pause", { min: pauseMin }),
      });
    }
    rows.push({ sep: true }, {
      label: "Continue in On Demand",
      desc: "Watch this episode on your own from here, in On Demand, where you can pause and fast forward. The channel goes on without you; when you stop, it comes back.",
      act: continueOnDemand,
    });
    return rows;
  }

  // schedule changes made elsewhere, for the guide
  setInterval(() => { if (!document.hidden && !watchingId) refresh(false); }, POLL);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(false); });
  window.addEventListener("pagehide", () => { if (watchingId) leave(watchingId); release(); });

  // --------------------------------------------------------------- settings
  const showSources = () => OnDemand.sources().filter((s) => TYPES.includes(s.type));
  function seasonsText(d) {
    const s = d.seasons;
    if (!s) return "";
    if (s[1] == null) return `, season ${s[0]} to the latest`;
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
          desc: "A channel that plays one show around the clock, in order or shuffled, from your Plex or Jellyfin server. Everyone watching sees the same episode; pausing, seeking, Start Over, Previous, Skip and Play Next in Order go to a vote when more than one TV is on it. Pick the show, which seasons, and a name; skipping intros and credits is set on the channel afterwards.",
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
            `${d.show.title}${seasonsText(d)}: ${plural(d.eps.length, "episode")}, ${d.order === "shuffle" ? "shuffled" : "in order"}${skipText(d) ? `, ${skipText(d)}` : ""}, from ${d.src.name}`,
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
    intro: e.intro || null, credits: e.credits || null, mk: !!e.mk,
  });

  /*
   * Intros and end credits: a channel can skip them (Skip Intros, Skip
   * Credits), so its TVs need to know where they are in every episode. Plex
   * only says one episode at a time, so they're looked up when skipping is
   * turned on, then kept with the episodes (mk: looked up), and new episodes
   * are looked up as they're added.
   */
  const skipping = (d) => !!(d.skip && (d.skip.intro || d.skip.credits));
  /** The show's episodes now, with the markers the channel already has for them. */
  function keepMarks(d, eps) {
    const had = new Map(d.eps.map((e) => [e.id, e]));
    return eps.map((e) => {
      const o = had.get(e.id);
      return o && o.mk ? Object.assign({}, e, { intro: o.intro, credits: o.credits, mk: true }) : e;
    });
  }
  /** Look up the markers of the episodes `want` picks (a few at a time). An
   *  episode that couldn't be looked up is left to try again later. */
  async function withMarkers(src, eps, want, progress) {
    const p = OnDemand.providers[src.type];
    if (!p.markers) throw new Error(`${src.name} can't say where intros and credits are`);
    const out = eps.slice(), todo = [];
    eps.forEach((e, k) => { if (want(e)) todo.push(k); });
    let done = 0, failed = 0, next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const k = todo[next++];
        try {
          const m = await p.markers(src, out[k]);
          out[k] = Object.assign({}, out[k], { intro: m.intro, credits: m.credits, mk: true });
        } catch (e) {
          if (e.auth) throw e;
          failed++;
        }
        done++;
        if (progress) progress(done, todo.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
    if (failed && failed === todo.length) throw new Error(`Couldn't get the intros and credits from ${src.name}`);
    return out;
  }
  const markProgress = (done, n) => Dialog.message(`Finding the intros and credits: ${done} of ${n} episodes...`);
  function skipText(d) {
    const s = d.skip || {};
    return s.intro && s.credits ? "skipping intros and credits" : s.intro ? "skipping intros" : s.credits ? "skipping credits" : "";
  }
  /** The episodes in seasons first-last (last null: to the latest; first
   *  null: all, when the show has no season numbers). */
  function inSeasons(eps, first, last) {
    if (first == null) return eps;
    return eps.filter((e) => e.season != null && e.season >= first && (last == null || e.season <= last));
  }
  /** A channel's episodes, from the show's list now. */
  const channelEps = (d, eps) => (d.seasons ? inSeasons(eps, d.seasons[0], d.seasons[1]) : eps);

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
    // (new channels go to the latest season unless told otherwise, so new seasons join them)
    const last = d && d.seasons ? d.seasons[1] : null;
    const fields = [];
    if (!d) fields.push({ id: "name", label: "Channel name", value: show.title.slice(0, 40) });
    if (has) {
      fields.push({ id: "first", label: "First season", value: String(first) });
      fields.push({ id: "last", label: "Last season (a number, or latest)", value: last == null ? "latest" : String(last), placeholder: "latest" });
    }
    const pick = (v) => {
      if (!has) return { range: null, picked: eps };
      const latest = /^\s*(latest|last|newest)?\s*$/i.test(v.last || "");
      const a = parseInt(v.first, 10), b = latest ? null : parseInt(v.last, 10);
      if (!Number.isInteger(a) || (!latest && (!Number.isInteger(b) || a > b))) {
        throw new Error("Enter the first season as a number, and the last as a number no earlier than it, or latest.");
      }
      const picked = inSeasons(eps, a, b);
      if (!picked.length) throw new Error(`There are no episodes in season${a === b ? ` ${a}` : latest ? `s ${a} on` : `s ${a}-${b}`}.`);
      return { range: [a, b], picked };
    };
    const text = `${show.title}: ${plural(eps.length, "episode")}` +
      (has ? ` in ${plural(seasons.length, "season")} (${seasons[0]}-${seasons[seasons.length - 1]}${seasons[0] === 0 ? "; season 0 is usually specials" : ""}).` : ".") +
      (d ? " Choose which seasons the channel plays. Its schedule starts again after the episode on now." : " Choose which seasons the channel plays, and its name.") +
      (has ? " Last season latest takes in new seasons as they turn up." : "");
    const make = (order) => async (v) => {
      let r;
      try { r = pick(v); } catch (e) { Dialog.message(e.message, true); return false; }
      const name = (v.name || "").trim();
      if (!d && !name) { Dialog.message("Give the channel a name.", true); return false; }
      Dialog.message(d ? "Saving..." : "Making the channel...");
      try {
        if (d) {
          let picked = keepMarks(d, r.picked);
          if (skipping(d)) picked = await withMarkers(src, picked, (e) => !e.mk, markProgress);
          Dialog.message("Saving...");
          await api("PATCH", `/api/channels/${d.id}`, { seasons: r.range, eps: picked.map(epOut) });
        }
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
      text: `${d.show.title}${seasonsText(d)}: ${plural(d.eps.length, "episode")}, ${d.order === "shuffle" ? "shuffled" : "in order"}` +
        `${skipText(d) ? `, ${skipText(d)}` : ""}, from ${d.src.name}.`,
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
        C.edit && { label: `Skip Intros: ${d.skip && d.skip.intro ? "On" : "Off"}`, act: () => setSkip(d, src, { intro: !(d.skip && d.skip.intro) }) },
        C.edit && { label: `Skip Credits: ${d.skip && d.skip.credits ? "On" : "Off"}`, act: () => setSkip(d, src, { credits: !(d.skip && d.skip.credits) }) },
        C.edit && {
          label: "Look for New Episodes",
          act: needSrc(async () => {
            Dialog.message("Getting the episode list...");
            let eps;
            try { eps = keepMarks(d, channelEps(d, await showEpisodes(src, d.show))); } catch (e) { Dialog.message(e.message, true); return false; }
            if (!eps.length) { Dialog.message("None of the channel's episodes are on the server any more.", true); return false; }
            // skipping: also look again at episodes the server hadn't found an intro or credits in
            let marked = 0;
            if (skipping(d)) {
              const before = eps;
              try { eps = await withMarkers(src, eps, (e) => !e.mk || (!e.intro && !e.credits), markProgress); } catch (e) { Dialog.message(e.message, true); return false; }
              marked = eps.filter((e, k) => String(e.intro) !== String(before[k].intro) || e.credits !== before[k].credits).length;
            }
            const { fresh, gone } = diffEps(d, eps);
            if (!fresh && !gone && !marked) { Dialog.message(`No new episodes: still ${plural(d.eps.length, "episode")}.`, true); return false; }
            return patch({ eps: eps.map(epOut) }, `${d.name}: ${plural(fresh, "new episode")}${gone ? `, ${gone} gone` : ""}` +
              (marked ? `, ${plural(marked, "intro or credits")} found` : ""))();
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

  /** Skip Intros, Skip Credits: on or off (`change`: { intro } or { credits }).
   *  Turning one on looks up where they are first, if that hasn't been done. */
  async function setSkip(d, src, change) {
    const skip = Object.assign({ intro: false, credits: false }, d.skip, change);
    let eps = d.eps;
    if ((skip.intro || skip.credits) && eps.some((e) => !e.mk)) {
      if (!src) { Dialog.message(`This TV doesn't have ${d.src.name} in On Demand, so it can't find the intros and credits.`, true); return false; }
      try { eps = await withMarkers(src, eps, (e) => !e.mk, markProgress); } catch (e) { Dialog.message(e.message, true); return false; }
    }
    Dialog.message("Saving...");
    try { await api("PATCH", `/api/channels/${d.id}`, { skip, eps: eps.map(epOut) }); } catch (e) { Dialog.message(e.message, true); return false; }
    await changedNow();
    const what = change.intro !== undefined ? "intros" : "credits";
    const n = eps.filter((e) => (what === "intros" ? e.intro : e.credits)).length;
    App.osd(change[what === "intros" ? "intro" : "credits"]
      ? `${d.name}: skipping ${what} (${n} of ${plural(eps.length, "episode")} have them), after this episode`
      : `${d.name}: playing ${what} again, after this episode`, 5000);
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

  /** How a channel's episodes differ from the show's list now. */
  function diffEps(d, eps) {
    const have = new Set(d.eps.map((e) => e.id)), now = new Set(eps.map((e) => e.id));
    return {
      fresh: eps.filter((e) => !have.has(e.id)).length,
      gone: d.eps.filter((e) => !now.has(e.id)).length,
      same: eps.length === d.eps.length && eps.every((e, i) => e.id === d.eps[i].id && Math.abs(e.dur - d.eps[i].dur) < 0.001),
    };
  }

  /**
   * New episodes, without anyone asking: an admin's TV looks at each
   * channel's show every few hours (the server doesn't talk to Plex or
   * Jellyfin itself), and puts new ones on the channel; with the last season
   * "latest", that takes in new seasons too. Episodes gone from the server
   * come off, unless most of them have (more likely the server having a bad
   * moment than the show being deleted: that's left for an admin).
   */
  const CHECK_EVERY = 6 * 3600e3, CHECKED_KEY = "iptv.channelsChecked";
  let checking = false;
  async function checkNew() {
    if (checking || !C.edit || !C.defs.length || document.hidden) return;
    checking = true;
    let checked = {};
    try { checked = JSON.parse(localStorage.getItem(CHECKED_KEY) || "{}") || {}; } catch { /* */ }
    let changed = false;
    try {
      for (const d of C.defs.slice()) {
        if (Date.now() - (checked[d.id] || 0) < CHECK_EVERY) continue;
        const src = sourceFor(d);
        if (!src) continue;
        let eps;
        try { eps = keepMarks(d, channelEps(d, await showEpisodes(src, d.show))); } catch { continue; } // try again next time
        // skipping intros or credits: find them in the new episodes
        let marked = 0;
        if (skipping(d) && eps.some((e) => !e.mk)) {
          try { eps = await withMarkers(src, eps, (e) => !e.mk); } catch { continue; }
          marked = eps.filter((e) => e.mk && !(d.eps.find((x) => x.id === e.id) || {}).mk).length;
        }
        checked[d.id] = Date.now();
        const { fresh, gone, same } = diffEps(d, eps);
        if ((same && !marked) || !eps.length || gone > d.eps.length / 2) continue;
        try {
          await api("PATCH", `/api/channels/${d.id}`, { eps: eps.map(epOut) });
          changed = true;
          console.info(`${d.name}: ${fresh} new episode(s), ${gone} gone`);
        } catch { delete checked[d.id]; }
      }
    } finally {
      const ids = new Set(C.defs.map((d) => d.id));
      for (const k of Object.keys(checked)) if (!ids.has(k)) delete checked[k];
      try { localStorage.setItem(CHECKED_KEY, JSON.stringify(checked)); } catch { /* */ }
      checking = false;
    }
    if (changed) { await refresh(true); rerender(); }
  }
  setTimeout(checkNew, 45e3);
  setInterval(checkNew, 15 * 60e3);

  // ------------------------------------------------------------------- api
  window.Channels = {
    load: () => load(true).catch(() => false),
    channels,
    programs,
    vote,
    voteText,
    voteRows,
    poke,
    pauseKey,
    seekInfo,
    seek,
    skipPop,
    /** The playing channel's subtitle file, if it has one (for C). */
    subFile: () => (playing && Player.ch && playing.id === Player.ch.custom ? playing.subs.find((s) => s.url) || null : null),
    showSub,
    settingsRows,
    count: () => C.defs.length,
  };
})();
