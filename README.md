# Watchening

A cable box simulator! Watch IPTV and Plex/Jellyfin with a classic cable aesthetic.

## Self Hosting

Install `Docker` first.

```sh
docker compose up -d
docker compose logs accounts     # prints the admin password, can be changed later
```

Open <http://localhost:8080> and sign in as `admin` with the password from the
log (it's also in `data/admin-login.txt`). Change it under
**Settings > Account > Change Password**, then add everyone else under
**Manage Users**.

Settings, if you need any, go in a `.env` file next to `docker-compose.yaml`:
copy `.env.example` and edit it. The ones most people change:

| Setting      | What it's for |
|--------------|---------------|
| `PUBLIC_URL` | The address people open, such as `https://tv.example.com` or `http://192.168.1.20:8080`. |
| `WEBUI_PORT` | The port the site is published on (default `8080`). |
| `AUTH`       | `on` (default) needs sign-in. `off` has none, and only answers your home network. |

Then run `docker compose up -d` again. Secrets are made on the first start;
there are no default passwords to change.

Playlists, channel order, On Demand servers and options are saved to each
person's account, so every TV they sign in on has them. Screen shape and
picture settings stay with each TV. To set up TVs for other people, an admin
makes a **group** under Manage Users and either sets its settings up on the TV
(**Set Up on TV**) or copies someone's. Everyone in the group gets them, and
gets the admin's later updates too. A TV can keep its settings to itself instead:
**Settings > Account > Save Settings on Server**. With `AUTH=off`, the home
network shares one saved copy.

Streams the browser can't play directly play through the server's built-in
proxy ([MediaFlow Proxy](https://github.com/mhdzumair/mediaflow-proxy)). That
covers an `http://` stream on an `https://` site, a server that blocks web
pages, and MPEG-DASH.

The on-screen keyboard's **Voice** key searches by talking. What's said is
turned into text on your own server, on its CPU, by one of
[FUTO's voice input models](https://keyboard.futo.tech/voice-input-models)
(`SPEECH_MODEL` in `.env`); nothing is sent anywhere else, and nothing is kept.
Browsers only allow the microphone on an `https://` address (or
`http://localhost`), and the page only sends recordings over those, so the
Voice key appears only there.

Saved settings, groups and uploaded playlists are kept in `data/settings/`.

Putting it on the internet behind a reverse proxy: see
[docs/REMINDERS.md](docs/REMINDERS.md).

### Stremio addons and debrid

On Demand can also play from Stremio addons with a debrid service (Real-Debrid,
TorBox, AllDebrid, Premiumize...), the way Stremio does, through
[AIOStreams](https://github.com/Viren070/AIOStreams), which runs alongside:

1. Optionally put your debrid service and API key in `.env` (`DEBRID_SERVICE`,
   `DEBRID_API_KEY`), then `docker compose up -d`.
2. On the server, open <http://localhost:3001/stremio/configure> and sign in
   with `data/aiostreams-login.txt`. Add your debrid service (already filled
   in if it's in `.env`), a catalog addon such as Cinemeta (what you browse
   and search) and one or more stream addons (Torrentio, Comet...), then
   **Save & Install**. Note the UUID and the password you chose.
3. In Watchening: **Settings > On Demand > Sign In to Stremio**, with that UUID
   and password (or Quick Connect: approve the code under **Save & Install >
   Jellyfin apps > Connect** on that page).

Catalogs and their genres show up as libraries, with Search. A title is
looked up in every stream addon, the debrid service says which files it
already has, and the best one the browser can play starts. Every stream
comes through this server (AIOStreams' own proxy), so the debrid service only
ever sees the server's address, however many people watch at once. Files are
played as they are, never converted: MP4 and MKV with H.264 play everywhere,
HEVC, Dolby Vision, DTS and TrueHD often don't in a browser, so On Demand
prefers versions that will.

## Licenses

Watchening is licensed under the [GNU GPL v3](LICENSE.txt).

It's built on these projects, each under its own license:

| Project | Used for | License |
|---------|----------|---------|
| [hls.js](https://github.com/video-dev/hls.js) | Playing HLS streams in the browser | Apache-2.0 |
| [mpegts.js](https://github.com/xqq/mpegts.js) | Playing MPEG-TS and FLV streams in the browser | Apache-2.0 |
| [Tiresias Screenfont](https://www.tiresias.org/) (RNIB) | The guide's font, in `webui/fonts/` | GPL-3.0-or-later, with font exception |
| [nginx](https://nginx.org/) | Web server (`webui`) | BSD-2-Clause |
| [Node.js](https://nodejs.org/) | Runs `setup`, `accounts` and the guide builder | MIT |
| [Ory Kratos](https://github.com/ory/kratos) | Accounts and sign-in | Apache-2.0 |
| [MediaFlow Proxy](https://github.com/mhdzumair/mediaflow-proxy) | Stream proxy | MIT |
| [iptv-org/epg](https://github.com/iptv-org/epg) | Guide grabber and its Docker image | Unlicense |
| [iptv-org/database](https://github.com/iptv-org/database) | Channel database for guide matching | Unlicense |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Voice search server | MIT |
| [FUTO voice input models](https://keyboard.futo.tech/voice-input-models) ([whisper-acft](https://github.com/futo-org/whisper-acft)) | Voice search models, downloaded on first start | Apache-2.0 (models), MIT (training code) |
| [OpenAI Whisper](https://github.com/openai/whisper) | The model FUTO's are fine-tuned from | MIT |
| [AIOStreams](https://github.com/Viren070/AIOStreams) | Stremio addons, debrid services and their stream proxy, for On Demand | AGPL-3.0 |

The Comcast and TV Guide logos and the channel logos in `webui/assets/` are
trademarks of their owners. They're used here only to identify the channels,
and Watchening isn't affiliated with or endorsed by any of them. The same goes
for Plex, Jellyfin, Stremio, zlive.st and the debrid services, which
Watchening connects to but doesn't include.

> [!NOTE]
> Watchening doesn't host, provide or distribute any TV channels, shows or movies. It's only a player: everything it plays comes from sources you set up yourself, such as your own IPTV playlists, your Plex or Jellyfin servers, or the Stremio addons and debrid account you set up in AIOStreams. Watchening doesn't run or control any of those sources. Make sure you have the right to watch what you play.