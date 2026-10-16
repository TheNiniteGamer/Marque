# Marquee media server — Node.js + ffmpeg + yt-dlp in one image.
FROM node:22-bookworm-slim AS node

FROM ubuntu:24.04
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# ffmpeg: probing, thumbnails, transcoding, merging downloads
# python3: runs yt-dlp; tini: forwards signals and reaps child processes
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ffmpeg python3 tini ca-certificates tzdata wget \
 && rm -rf /var/lib/apt/lists/*

# Latest yt-dlp release (sites change often, so it is not taken from the distro).
RUN wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

# /data holds the database, thumbnails and caches; media folders are mounted under /media.
# yt-dlp is owned by the app user so "Update yt-dlp" in the web UI can replace it.
RUN useradd --system --create-home --uid 999 marquee \
 && mkdir -p /data /media \
 && chown -R marquee:marquee /data /media /usr/local/bin/yt-dlp

# Which version this image was built from (passed in by marquee.ps1; used for update checks).
ARG MARQUEE_COMMIT=
ARG MARQUEE_BUILT_AT=
ENV MARQUEE_COMMIT=$MARQUEE_COMMIT \
    MARQUEE_BUILT_AT=$MARQUEE_BUILT_AT

ENV NODE_ENV=production \
    PORT=32500 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    MEDIA_ROOT=/media

USER marquee
EXPOSE 32500
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:32500/api/health >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
