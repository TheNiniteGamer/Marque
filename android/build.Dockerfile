# The Android apps' build machine, in Docker: a JDK, Node (for publish.js), zip, and the Android SDK
# command-line tools. The SDK itself is a folder mounted at /sdk (see README.md, "Building").
FROM eclipse-temurin:17-jdk
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zip unzip nodejs && rm -rf /var/lib/apt/lists/*
ENV ANDROID_HOME=/sdk
