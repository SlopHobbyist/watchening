# Voice search for older x86-64 CPUs (no AVX2, such as Sandy Bridge and Ivy
# Bridge Xeons), where the prebuilt whisper.cpp image stops at once with
# "exit code 132" (an instruction the CPU doesn't have). This builds the same
# whisper.cpp commit for the CPU of the machine that builds it, so build it
# on the server that runs it. In docker-compose.override.yml:
#
#   services:
#     speech:
#       image: watchening-speech:local
#       build: ./speech
#
# then `docker compose up -d --build speech` (a few minutes the first time).
FROM ubuntu:24.04 AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# the commit the prebuilt image in docker-compose.yaml is from
ARG WHISPER_COMMIT=aba02defd6bb6ff5de63721c21e3456645c153e2
WORKDIR /src
RUN git init -q . \
 && git remote add origin https://github.com/ggml-org/whisper.cpp \
 && git fetch -q --depth 1 origin "$WHISPER_COMMIT" \
 && git checkout -q FETCH_HEAD
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
 && cmake --build build -j"$(nproc)" --target whisper-server

FROM ubuntu:24.04
# curl: start.sh downloads the model, and the healthcheck uses it
# libgomp1: OpenMP, which ggml's CPU threads use
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/bin/whisper-server /usr/local/bin/whisper-server
