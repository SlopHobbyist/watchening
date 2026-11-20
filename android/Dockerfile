# Build environment for the Android TV app: JDK, Android SDK, Gradle.
# Used by build.sh, so you don't need Android Studio or a local SDK.
FROM eclipse-temurin:21-jdk-noble

ARG CMDLINE_TOOLS=13114758
ARG GRADLE=9.8.2
ARG PLATFORM=37.2
ARG BUILD_TOOLS=37.0.0

RUN apt-get update && apt-get install -y --no-install-recommends unzip wget && rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
 && wget -q https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip -O /tmp/t.zip \
 && unzip -q /tmp/t.zip -d $ANDROID_HOME/cmdline-tools && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
 && rm /tmp/t.zip \
 && yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
 && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-${PLATFORM}" "build-tools;${BUILD_TOOLS}" "platform-tools" > /dev/null

RUN wget -q https://services.gradle.org/distributions/gradle-${GRADLE}-bin.zip -O /tmp/g.zip \
 && unzip -q /tmp/g.zip -d /opt && ln -s /opt/gradle-${GRADLE}/bin/gradle /usr/local/bin/gradle && rm /tmp/g.zip

ENV PATH=$PATH:$ANDROID_HOME/platform-tools
WORKDIR /src
