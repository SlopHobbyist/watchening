/*
 * zlive.st channels (https://zlive.st/api).
 *
 * zlive publishes a channel list at MANIFEST (open to any site, CORS enabled):
 *   { name, version, baseUrl, count,
 *     channels: [{ id, name, region, flag, quality, sport, live, url }] }
 * There are no stream addresses: each channel plays in zlive's own player,
 * https://zlive.st/embed/<id>, inside an iframe. Its options are query
 * parameters on that link (see embedUrl).
 *
 * Turned on, it is kept as a playlist of type "zlive" (id "zlive"), so it
 * gets the same channel order, hiding and hourly refresh as M3U playlists.
 *
 * Guide listings come from the epg container (see docker-compose.yaml),
 * which writes an XMLTV file keyed by zlive's channel ids. nginx serves it
 * at epg/zlive.xml.gz beside the page; the playlist names it like an M3U's
 * url-tvg, so it loads with the other guide data.
 */
(function () {
  "use strict";
  const BASE = "https://zlive.st/embed/";
  const MANIFEST = BASE + "manifest.json";
  const GUIDE = new URL("../epg/zlive.xml.gz", document.currentScript.src).href;

  /** The manifest's text -> the same shape M3U.parse returns. Throws if it
   *  isn't a zlive manifest. */
  function parse(text) {
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
        // ever frames zlive's own embed pages
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

  window.Zlive = { MANIFEST, GUIDE, parse, embedUrl };
})();
