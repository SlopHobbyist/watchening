#!/bin/sh
# Builds the Android TV app in Docker (no Android Studio or SDK needed).
# APKs land in dist/. Extra arguments go to Gradle, for example:
#   ./build.sh -Pwatchening.url=https://tv.example.com
set -e
cd "$(dirname "$0")"
docker build -q -t watchening-android-build . > /dev/null
run() { docker run --rm -u "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/src/.gradle-home -v "$PWD":/src watchening-android-build "$@"; }

# The signing key. Android only installs an update signed with the same key
# as the installed app, so the first build makes one and keeps it here
# (git ignores it). Back up release.jks and keystore.properties.
if [ ! -f keystore.properties ]; then
  pass=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
  run keytool -genkeypair -keystore release.jks -storetype PKCS12 -alias watchening \
    -keyalg RSA -keysize 4096 -validity 36500 -storepass "$pass" -keypass "$pass" \
    -dname "CN=Watchening" > /dev/null 2>&1
  chmod 600 release.jks; umask 077
  printf 'storeFile=release.jks\nstorePassword=%s\nkeyAlias=watchening\nkeyPassword=%s\n' "$pass" "$pass" > keystore.properties
  echo "Made a signing key: back up android/release.jks and android/keystore.properties."
fi

run ./gradlew --no-daemon -q assembleRelease "$@"
mkdir -p dist
for f in app/build/outputs/apk/release/*.apk; do
  abi=$(basename "$f" | sed -n 's/^app-\(.*\)-release\.apk$/\1/p')
  [ -n "$abi" ] && cp "$f" "dist/watchening-$abi.apk"
done
ls -lh dist/
