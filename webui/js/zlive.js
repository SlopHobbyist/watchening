/*
 * zlive-style channel lists.
 *
 * No site address ships with the app: the user types it in when turning
 * the channels on, and manifestUrl turns it into the channel list's address,
 * <site>/embed/manifest.json (open to any site, CORS enabled):
 *   { name, version, baseUrl, count,
 *     channels: [{ id, name, region, flag, quality, sport, live, url }] }
 * There are no stream addresses: each channel plays in the site's own
 * player, <site>/embed/<id>, inside an iframe. Its options are query
 * parameters on that link (see embedUrl).
 *
 * Turned on, it is kept as a playlist of type "zlive" (id "zlive", url = the
 * manifest's address), so it gets the same channel order, hiding and hourly
 * refresh as M3U playlists.
 *
 * Guide listings come from the epg container (see docker-compose.yaml),
 * which writes an XMLTV file keyed by zlive's channel ids. nginx serves it
 * at epg/zlive.xml.gz beside the page; the playlist names it like an M3U's
 * url-tvg, so it loads with the other guide data.
 */
(function () {
  "use strict";
  const GUIDE = new URL("../epg/zlive.xml.gz", document.currentScript.src).href;

  /** What the user typed ("example.com", "https://example.com", or the
   *  manifest's own address) -> the manifest's address. Throws if it isn't
   *  a web address. */
  function manifestUrl(input) {
    let s = String(input || "").trim();
    if (!s) throw new Error("Enter the site's address first");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
    let u;
    try { u = new URL(s); } catch { throw new Error("That doesn't look like a web address"); }
    if (!/^https?:$/.test(u.protocol)) throw new Error("Only http:// and https:// addresses can be loaded");
    if (!/\.json$/i.test(u.pathname)) u = new URL("/embed/manifest.json", u.origin);
    u.hash = "";
    return u.href;
  }

  /** The manifest's text -> the same shape M3U.parse returns. Throws if it
   *  isn't a zlive manifest. `from` is the manifest's address; the players
   *  sit beside it. */
  function parse(text, from) {
    const BASE = new URL("./", from).href;
    let d;
    try { d = JSON.parse(text); } catch { d = null; }
    if (!d || !Array.isArray(d.channels)) throw new Error("zlive's channel list couldn't be read");
    const channels = [];
    for (const c of d.channels) {
      if (!c || typeof c.id !== "string" || !c.id) continue;
      const name = String(c.name || c.id).trim();
      channels.push({
        name,
        // built from the id rather than taken from `url`, so the player only
        // ever frames embed pages on the site the user typed in
        url: BASE + encodeURIComponent(c.id),
        tvgId: c.id, // the guide file uses zlive's ids
        tvgName: name,
        logo: "",
        group: [c.sport, c.region].filter((s) => s && s !== "Other").join(" · "),
        hd: /^(HD|FHD|UHD|4K)$/i.test(c.quality || ""),
        embed: true,
      });
    }
    return { channels, epg: [GUIDE] };
  }

  /** The player link for a channel: autoplaying, with zlive's own controls,
   *  title and badge hidden (the viewer draws its own), square corners (the
   *  player rounds them otherwise), and the picture stretched over the whole
   *  iframe, which the player sizes to the picture. */
  function embedUrl(url, muted) {
    const u = new URL(url);
    u.search = new URLSearchParams({
      autoplay: "1", muted: muted ? "1" : "0", controls: "none",
      title: "0", brand: "0", frame: "0", bg: "000000", fit: "fill",
      radius: "0",
    });
    return u.href;
  }

  window.Zlive = { GUIDE, manifestUrl, parse, embedUrl };
})();
