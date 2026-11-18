# zlive guide builder

The `epg` service in `docker-compose.yaml` builds guide listings for zlive's
channels. nginx serves the result at `/epg/zlive.xml.gz`, and the web UI's
zlive playlist loads it the same way an M3U's `url-tvg` is loaded.

No site address ships with Watchening. Set `ZLIVE_URL` in `.env` to the same
address you typed into the web UI (Settings, Playlists, "zlive Channels");
until then the service starts, logs that it has nothing to do, and waits.

It runs in [iptv-org/epg](https://github.com/iptv-org/epg)'s own Docker image,
which includes iptv-org's channel database, their scrapers for about 250 guide
sites, and which site carries which channel. iptv-org rebuilds the image on
every change, so `docker compose pull` picks up their fixes.

## How a run works

`zlive-epg.mjs` runs at start-up and then every `EPG_EVERY_HOURS`:

1. It downloads the channel list from `ZLIVE_URL`.
2. `match.mjs` matches each zlive channel to an iptv-org channel by name, alt
   name, and the country in the name ("Cartoon Network UK"). Listings only
   come from site entries that iptv-org has mapped to that channel.
3. It picks each channel's site in this order: the right country's feed, then
   the channel's own language (or English), then sites that have worked
   lately, then sites from that country, then the fullest listings. The
   fullness score is learned from each run.
4. iptv-org's grabber downloads the listings. A channel that comes back empty
   is retried on its next site, up to `EPG_TRIES` sites per run. A site that
   failed for a channel is tried last for three days.
5. Channels that still got nothing keep the previous run's listings.

## Checking and fixing matches

`/epg/status.json` lists every zlive channel with the iptv-org channel it
matched, the site its listings came from, and why there's no guide when
there isn't one.

When a match is wrong or missing, add an entry to `overrides.json`. The key
is the zlive channel id and the value is an iptv-org channel id, optionally
with `@Feed`. Use `null` for no guide. iptv-org's ids can be searched at
<https://iptv-org.github.io>.

To see what would match without grabbing anything:

    docker compose run --rm --entrypoint node epg /zlive/match.mjs

Then restart the service (`docker compose restart epg`) to rebuild now.
