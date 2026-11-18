# Putting Watchening on the internet

A checklist for running Watchening on an internet-facing server, with a
reverse proxy (the examples use Traefik) doing https in front, and optionally
Cloudflare for DNS. Tick them off as you go. A setup that's only used at home
needs none of this.

## Before the first `docker compose up -d`

- [ ] **Make `.env`** from `.env.example` and set
      `PUBLIC_URL=https://tv.example.com` (your real hostname, no path).
      This is what turns on https-only cookies. If it's left as `http://...`,
      sign-in still works but cookies aren't marked Secure, and
      `docker compose logs accounts` prints a warning the first time a visitor
      arrives over https.
- [ ] Keep `AUTH=on`. `off` is only for installs that can't be reached from
      the internet: behind Traefik every visitor's address can look "local".
- [ ] **Don't publish port 8080 to the world.** Either set
      `WEBUI_PORT=127.0.0.1:8080` or drop the port entirely in an override
      (below), so nobody reaches nginx without going through Traefik.

## Traefik

Put this in a `docker-compose.override.yml` next to `docker-compose.yaml`
(compose loads it on its own, so the main file stays as it is in git). Adjust
the network name, entrypoint and cert resolver to match your Traefik.

```yaml
services:
  webui:
    ports: !reset []            # reachable only through Traefik
    networks: [default, traefik]
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.watchening.rule=Host(`tv.example.com`)
      - traefik.http.routers.watchening.entrypoints=websecure
      - traefik.http.routers.watchening.tls.certresolver=letsencrypt
      - traefik.http.services.watchening.loadbalancer.server.port=80
      - traefik.http.routers.watchening.middlewares=watchening-hsts
      - traefik.http.middlewares.watchening-hsts.headers.stsSeconds=31536000

networks:
  traefik:
    external: true
```

- [ ] Route **only `webui`**. Kratos, the accounts service, MediaFlow and AIOStreams must
      stay internal; nginx is the only door, and it's what checks sign-ins and
      adds MediaFlow's password.
- [ ] Don't add a buffering middleware on this router: live streams go through
      `/proxy/` and never end.
- [ ] HSTS (above) belongs at Traefik, since nginx only ever sees plain http.

## Cloudflare

- [ ] **Grey cloud (DNS only) for Watchening's subdomain.** Every `http://` channel, every
      CORS-blocked stream, and all MPEG-DASH plays *through your server*
      (MediaFlow), so a lot of video passes through that hostname. Cloudflare's
      terms have long restricted serving video through its free proxy outside
      its paid video products. Traefik gets the certificate from Let's Encrypt
      (the DNS challenge works with Cloudflare's API).
- [ ] If you have other subdomains that stay orange (proxied), make sure the
      grey one is **the one in `PUBLIC_URL`**, the address people open. The
      stream proxy is always on the same hostname as the page (`/proxy/`), so
      if people open Watchening on an orange subdomain, the video goes through
      Cloudflare after all. If an orange subdomain serves something else
      (ErsatzTV's own page, say), have Watchening reach ErsatzTV's streams by
      LAN address (see below), not through that subdomain. Watchening can't
      yet put pages and streams on separate subdomains.
- [ ] If it stays orange anyway: set Traefik's entrypoint
      `forwardedHeaders.trustedIPs` to Cloudflare's ranges
      (<https://www.cloudflare.com/ips/>), so the visitor's real address reaches
      nginx. The sign-in rate limit (10 tries a minute per address) depends on
      it; otherwise all visitors share Cloudflare's addresses. Only add
      Cloudflare's ranges to `nginx/trusted-proxies.conf` if Cloudflare connects
      to nginx directly, with no Traefik between.
- [ ] Either way, nothing is cached at Cloudflare: nginx sends `no-cache`.

## First sign-in

- [ ] After the first start: `docker compose logs accounts` shows the admin
      username and a random password; it's also in `data/admin-login.txt`.
- [ ] Sign in, then **Settings > Account > Change Password**. The text file
      deletes itself once you have (checked when an admin opens the app, and
      hourly).
- [ ] Add people from **Settings > Account > Manage Users**. "Send them a
      link" gives a one-time link, good for 3 days, where they choose their
      own password.
- [ ] Set up their TVs: make a group, put them in it, then **Set Up on TV**
      (the TV opens on the group's settings, with a lime strip at the top
      saying so) or copy your own. Their TVs pick it up within a few minutes.
- [ ] Locked out of the only admin account:
      `docker compose exec accounts node server.mjs reset-password admin`
      prints a new password and signs that account out everywhere.

## ErsatzTV (and other home-network sources)

- [ ] Add ErsatzTV's playlist by its **LAN address**, such as
      `http://192.168.1.20:8409/iptv/channels.m3u`, not `localhost` (to the
      MediaFlow container, `localhost` is itself). Same for its guide,
      `.../iptv/xmltv.xml`. On the https site these download and play through
      MediaFlow automatically.
- [ ] If ErsatzTV runs in another compose project, MediaFlow needs to reach it:
      the LAN address usually works from Docker; otherwise join MediaFlow to
      ErsatzTV's network.
- [ ] Anyone signed in can make the server fetch addresses on your home network
      through `/proxy/` (that's how ErsatzTV and HDHomeRun work). Only give
      accounts to people you'd let on your network.

## Stremio addons and debrid (AIOStreams)

- [ ] **Keep AIOStreams' own page off the internet.** It's published on
      `127.0.0.1:3001` (`AIOSTREAMS_PORT`), this machine only. To set it up
      from your computer, use an SSH tunnel
      (`ssh -L 3001:127.0.0.1:3001 server`, then <http://localhost:3001/stremio/configure>)
      rather than publishing it. Don't route it in Traefik.
- [ ] Its links are made on `PUBLIC_URL` (setup gives it the same address),
      and only `/jellyfin/` and `/api/v1/proxy/` reach it, through nginx, for
      signed-in visitors. Set `PUBLIC_URL` before you configure it: links in
      setups saved under another address won't work.
- [ ] Every stream it hands out comes through its proxy (forced in
      `aiostreams.env`, which setup writes), so the debrid service sees only
      the server's address. **Grey cloud** matters even more here: films are
      big, and they all go through the server.
- [ ] Don't add a buffering middleware for `/api/v1/proxy/` either: streams
      are long and need Range requests (seeking) to pass straight through.
- [ ] Its admin sign-in is in `data/aiostreams-login.txt` (and in the setup
      log the first time). It comes from the `auth-secrets` volume and can't be
      changed on its page.
- [ ] The setup you make there holds your debrid API key, and anyone signed
      in to it in Watchening (UUID and password, or Quick Connect) streams on
      your debrid account. Group settings carry that sign-in to everyone in
      the group, as with Plex and Jellyfin.

## Keep safe

- [ ] **Back up** the `watchening_kratos-db` volume (the accounts),
      `watchening_auth-secrets` (the keys), `watchening_aiostreams-data`
      (AIOStreams' setups; they can only be opened with the key in
      auth-secrets) and the `data/` folder (everyone's
      saved settings, the groups and uploaded playlists, in `data/settings/`).
      Losing the secrets signs everyone out (and locks AIOStreams' setups); losing the database loses the
      accounts (a new admin is made on the next start). Saved settings are
      filed by account id, so they only match the accounts database they were
      made with.
- [ ] Group settings carry any Plex or Jellyfin sign-in in them to everyone in
      the group. Set groups up with an account you're happy to share (or none).
- [ ] Versions are pinned (Kratos `v26.2.0`, MediaFlow `v2.4.9`). Read their
      release notes before bumping them in `docker-compose.yaml`.
- [ ] Upload bandwidth: whatever plays through the proxy while you're away
      from home uses your server's upload, once per viewer.

## Later, if wanted

- [ ] Two-factor sign-in (TOTP): Kratos supports it
      (`selfservice.methods.totp` in `auth/kratos/kratos.yml`); the account
      page would need a section for setting it up.
- [ ] Forgot-password by email: needs an `email` trait in
      `auth/kratos/identity.schema.json`, a real SMTP server in `courier`, and
      the code recovery method. Right now an admin makes a new link instead.
