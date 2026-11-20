# Watchening

A cable box simulator! Watch IPTV and Plex/Jellyfin with a classic cable aesthetic.

## Features
### Screens
- **Interactive guide** - in the style of the 2005 Comcast iGuide
- **Video player** - can display subtitles and change aspect ratios
- **On Demand** - can play pre recorded media from various sources
- **Custom channels** - 24 hour channels that play a show from Plex or Jellyfin, or a YouTube channel or playlist, in order or shuffled
- **Account management** - can remotely manage settings for family members and novices
### Sources
- **Plex**
- **Jellyfin**
- **Stremio** - debrid caches
- **IPTV playlists** - m3u/m3u8 files or links
- **Other external players** - through embeds, or apis like zlive

## Self Hosting

### First launch

Install [Docker](https://docs.docker.com/get-docker/) first (Engine 26 or newer, with Compose v2). Then:

```sh
git clone https://github.com/SlopHobbyist/watchening
cd watchening
docker compose up -d
docker compose logs accounts     # prints the admin password, can be changed later
```

Some Linux systems require `sudo` in front of the `docker` commands.

The voice search image is for x86-64 (amd64) machines. On an ARM server
(such as a Raspberry Pi), see the note above `speech:` in `docker-compose.yaml`.
On an older x86-64 CPU without AVX2 (voice search keeps restarting with exit
code 132), build it for your CPU instead: see `speech/Dockerfile`.

Open <http://localhost:8080> and sign in as `admin` with the password from the
log. If you missed it, it's also printed to `data/admin-login.txt`.

Password is generated on first start. Change it under `Settings > Account > Change Password`, then add everyone else under `Manage Users`.

Settings go in `.env` file next to `docker-compose.yaml`:
copy `.env.example` and edit it. Main ones you should change:

| Setting      | What it's for |
|--------------|---------------|
| `PUBLIC_URL` | The address people open, such as `https://tv.example.com` or `http://192.168.1.20:8080`. |
| `WEBUI_PORT` | The port the site is published on (default `8080`). |
| `AUTH`       | `on` (default) needs sign-in. `off` has none, and only answers your home network. |

Then run `docker compose up -d` again.

Settings are saved to each user account, except for aspect ratio.

### User accounts and settings

Users can be put into groups to share settings, this way family members and computer novices can have settings changed for them.

TVs can choose to save settings in their browser if they wish with `Settings > Account > Save Settings on Server`.

Saved settings, groups and uploaded playlists are kept in `data/settings/`.

`AUTH=off` disables accounts, and everyone on the home network shares one saved copy.

### Other

Streams that browsers can't play are sent through [MediaFlow Proxy](https://github.com/mhdzumair/mediaflow-proxy) first.

There's a voice search built into the keyboard. Runs [FUTO's voice input models](https://keyboard.futo.tech/voice-input-models) on server. Can change `SPEECH_MODEL` in `.env`. You must serve over **HTTPS** or browsers refuse to allow microphone permission.

Putting it on the internet behind a reverse proxy: see
[docs/DEPLOYING.md](docs/DEPLOYING.md).

### Android TV app

[android/](android/README.md) has a small app that opens your server full
screen on an Android TV box (Android 8.0 or newer). It installs the
[Control Panel for YouTube](https://github.com/insin/control-panel-for-youtube)
extension for YouTube channels, and adds **Reload App (Clear Cache)** to
`Settings > Options`. Build it with `android/build.sh` (needs only Docker),
then sideload the APK from `android/dist/`.

### Stremio addons and debrid

On Demand can also play from Stremio addons with a debrid service (Real-Debrid,
TorBox, AllDebrid, Premiumize...), the way Stremio does, through
[AIOStreams](https://github.com/Viren070/AIOStreams), which runs alongside:

1. Optionally put your debrid service and API key in `.env` (`DEBRID_SERVICE`,
   `DEBRID_API_KEY`), then `docker compose up -d`.
2. On the server, open <http://localhost:3001/stremio/configure> and sign in
   with `data/aiostreams-login.txt`. Add your debrid service (if its key is
   in `.env`, it's already on and its key field is hidden), a catalog addon such as Cinemeta (what you browse
   and search) and one or more stream addons (Torrentio, Comet...), then
   **Save & Install**. Note the UUID and the password you chose.
3. In Watchening: **Settings > On Demand > Sign In to Stremio**, with that UUID
   and password (or Quick Connect: approve the code under **Save & Install >
   Jellyfin apps > Connect** on that page).

Catalogs and their genres show up as libraries, with Search. A title is
looked up in every stream addon, the debrid service says which files it
already has, and of the ones the browser can play, the one with the most
seeders starts (even over a slightly better picture). Every stream
comes through this server (AIOStreams' own proxy), so the debrid service only
ever sees the server's address, however many people watch at once. Files are
played as they are, never converted: MP4 and MKV with H.264 play everywhere,
HEVC, Dolby Vision, DTS and TrueHD often don't in a browser, so On Demand
prefers versions that will.

### Custom channels

Make channels out of the shows on your Plex or Jellyfin server under
**Settings > Custom Channels > Make a Channel** (admins). Pick the show, which
seasons (so "old" and "new" Simpsons can be separate channels; a last season of
`latest` takes in new seasons as they arrive), a name, and
whether it plays in order or shuffled (shuffled plays every episode once before
any repeats). The channel then runs around the clock, with listings in the
guide, and everyone who tunes in sees the same episode at the same moment.

Everyone sees the same moment, so pausing and seeking are for everyone:
play/pause asks to pause the channel for a few minutes (up to 5; it goes on by
itself, or when whoever paused it presses play again), and ◀▶ on the control
bar picks a point in the episode to go to. The controls (OK while watching)
also have **Vote**, with **Start Over**, **Previous** (the episode before,
then this one again from the start), **Skip**, **Play Next in Order** (the
show's next episode after this one, even on a shuffled channel, for
two-parters; then the shuffle carries on), and **Pause** / **Resume**. If
yours is the only TV on the channel, they happen right away. With others
watching, they're a vote: when more than half of the TVs agree (or the others
leave), it happens for everyone. **Continue in On Demand** (in Vote) plays the
episode on its own from the same point, to pause and fast forward just for you.

Admins can have a channel skip intros and end credits (the channel's settings:
**Skip Intros**, **Skip Credits**), using where Plex (or Jellyfin 10.10's media
segments) says they are; the schedule leaves them out. Otherwise a **Skip
Intro** or **Skip Credits** button shows over the picture during them, as in
Plex (a vote too). On Demand shows the same buttons; Skip Credits goes on to
the show's next episode.

Each TV plays the episodes through its own On Demand sign-in to that server, so
people need it in **Settings > On Demand** (group settings carry it). (YouTube
channels need nothing: see below.) Channels
are added after the others in the guide; move them with **Settings > Channels**.
Watching a channel doesn't mark episodes as watched. New episodes on the server
are added by themselves: an admin's TV checks each channel's show every six
hours while the app is open (the accounts service doesn't talk to Plex or
Jellyfin itself). To check right away, use **Look for New Episodes** on the
channel. Channels are saved
in `data/settings/channels.json`.

#### YouTube channels

**Make a Channel > YouTube** takes a link to a YouTube channel
(`youtube.com/@name`, for all of its uploads) or a playlist
(`youtube.com/playlist?list=...`). Choose whether it plays **Shorts** and
**Live Stream Replays** (both off to start with), and its order: oldest first,
newest first or shuffled for a channel, the playlist's order, backwards or
shuffled for a playlist. All of that can be changed on the channel later.
Big channels take a minute or two to read (a channel plays its newest 5,000
videos at most).

Videos play in YouTube's own embedded player, so the people who made them get
the views (and YouTube may show its ads). No API key or account is needed:
Watchening's server reads the lists the way youtube.com's own pages do, and
looks at them again every six hours for new uploads (**Look for New Videos**
to look now). A video whose owner doesn't allow it to play outside YouTube is
skipped for everyone the first time a TV runs into it, and left off the
channel after that. The schedule leaves three seconds before each video for
the TVs to start YouTube's player, so every video plays from its very start
to its very end.

[SponsorBlock](https://sponsor.ajay.app)'s crowd-sourced skips are added over
the first few minutes after a channel is made (and for each new video):
sponsors, self promotion and reminders to like and subscribe are always left
out, and end cards and credits are too unless **Skip End Cards and Credits** is
turned off. An intro animation or intermission gets the **Skip Intro**
button, or is left out with **Skip Intro Animations** on. As with Plex's
intros and credits, the schedule leaves them out, so everyone stays on the
same moment.

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
| [GeckoView](https://mozilla.github.io/geckoview/) | The Android TV app's web engine | MPL-2.0 |

The Comcast and TV Guide logos and the channel logos in `webui/assets/` are
trademarks of their owners. They're used here only to identify the channels,
and Watchening isn't affiliated with or endorsed by any of them. The same goes
for Plex, Jellyfin, Stremio, YouTube, zlive and the debrid services, which
Watchening connects to but doesn't include. Skip times for YouTube videos come
from [SponsorBlock](https://sponsor.ajay.app), whose data is under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).

> [!NOTE]
> Watchening doesn't host, provide or distribute any TV channels, shows or movies. It's only a player: everything it plays comes from sources you set up yourself, such as your own IPTV playlists, your Plex or Jellyfin servers, or the Stremio addons and debrid account you set up in AIOStreams. Watchening doesn't run or control any of those sources. Make sure you have the right to watch what you play.