# Watchening

A cable-box style TV guide and player for IPTV playlists, in the browser.

## Running it

You need Docker with Compose.

```sh
docker compose up -d
docker compose logs accounts     # the first admin password
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

Saved settings, groups and uploaded playlists are kept in `data/settings/`.

Putting it on the internet behind a reverse proxy: see
[docs/REMINDERS.md](docs/REMINDERS.md).
