# Watchening for Android TV

A small app that shows your Watchening server full screen on an Android TV box
(or any Android 8.0+ device). It runs on GeckoView, Firefox's engine, rather
than Android's built-in WebView, because GeckoView can run browser extensions.

- **First launch** asks for your server's address (for example
  `https://tv.example.com` or `http://192.168.1.20:8080`). To skip that
  question, build with the address included (see below).
- **Control Panel for YouTube** is installed from addons.mozilla.org on first
  launch, and on any later launch where it's missing. It's updated on every
  launch. Mozilla signs the file, and GeckoView requires that signature.
- **Settings › Options** on the site gets two extra rows, shown only inside the
  app:
  - **Reload App (Clear Cache)** clears the network and image caches and
    reloads. You stay signed in, and your settings are kept.
  - **Change Server Address**.
- **Back** works as it does in the site. Press it twice to leave the app.
- **Voice search** asks for microphone permission the first time you use it.
- If the server can't be reached, a page offers **Try Again** and
  **Change Server**.

## Install

Copy the APK for your box's CPU type from `dist/` to the box and open it. You
may first need to allow installs from the file manager you use, under the
box's security settings.

| APK | For |
|-----|-----|
| `watchening-armeabi-v7a.apk` | Any ARM box. Many TV boxes run 32-bit Android even on a 64-bit chip, and nearly all 64-bit ones run this too. Use this one if unsure. |
| `watchening-arm64-v8a.apk` | 64-bit ARM Android (`adb shell getprop ro.product.cpu.abi` says `arm64-v8a`): a little faster |
| `watchening-x86_64.apk` | The Android emulator and x86 boxes |

If the wrong one is installed, Android says the app isn't compatible. Fire TV
needs Fire OS 7 or newer (Android 9), since GeckoView needs Android 8.0.

From a computer with `adb`: `adb install -r dist/watchening-armeabi-v7a.apk`.

## Build

You only need Docker. The build runs in a container with the JDK, Android SDK
and Gradle (see `Dockerfile`):

```sh
./build.sh                                        # asks for the server on first launch
./build.sh -Pwatchening.url=https://tv.example.com  # opens this server straight away
```

APKs land in `dist/`. The first build downloads about 1.5 GB (the SDK and
GeckoView) and takes a few minutes. Later builds take under a minute.

### The signing key

Android installs an update only when it's signed with the same key as the app
already installed. The first build therefore makes a key, `release.jks`, with
its passwords in `keystore.properties`. Git ignores both. **Back them up.** If
they're lost, the next build has a new key, and every box must uninstall the
app (losing its sign-in) before installing the new build. To use your own key,
write `keystore.properties` yourself before building:

```properties
storeFile=release.jks
storePassword=...
keyAlias=...
keyPassword=...
```

## How the site and the app talk

- The app adds `WatcheningTV/<version>` to the end of its user agent. The site
  checks for it (`U.app` in `webui/js/util.js`) to show the extra rows and to
  turn on its TV Back-button handling.
- The site asks the app to do things by going to `watchening-app:reload` or
  `watchening-app:server` (`U.appAction`). The app catches these before
  they load. It acts on them only when they come from the server's own pages
  or its own error page.

## Notes

- GeckoView is set up with desktop viewport behaviour (`dom.meta-viewport.enabled`
  off, in `MainActivity.GECKO_CONFIG`). Mobile Gecko makes the page taller
  than the screen when content overflows, and the site sizes itself to the
  window, so the guide came out too large and cut off.
- GeckoView needs Android 8.0 (API 26) or newer. That's the app's minimum.
- Popups (`window.open`, such as plex.tv/link) are handed to another app on
  the box if one can open them. Otherwise the address is shown briefly.
