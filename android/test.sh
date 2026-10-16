#!/usr/bin/env bash
# Unit tests for the app's plain-Java logic (address parsing, network discovery, playback decisions,
# subtitles). Runs on a normal JVM; downloads JUnit and org.json from Maven Central on first use.
set -euo pipefail
cd "$(dirname "$0")"
LIB=build/test-lib
mkdir -p "$LIB" build/test-classes
# Maven Central, falling back to Gradle's mirror of it.
fetch() {
  [ -f "$LIB/$2" ] && return
  curl -sSfL --retry 2 --retry-delay 3 -o "$LIB/$2" "https://repo1.maven.org/maven2/$1/$2" 2>/dev/null ||
    curl -sSfL --retry 2 --retry-delay 3 -o "$LIB/$2" "https://plugins.gradle.org/m2/$1/$2"
}
fetch junit/junit/4.13.2 junit-4.13.2.jar
fetch org/hamcrest/hamcrest-core/1.3 hamcrest-core-1.3.jar
fetch org/json/json/20231013 json-20231013.jar
CP="$LIB/junit-4.13.2.jar:$LIB/hamcrest-core-1.3.jar:$LIB/json-20231013.jar"
SRC=app/src/main/java/app/marquee/client
javac -nowarn -d build/test-classes -cp "$CP" $SRC/ServerAddress.java $SRC/Discovery.java $SRC/PlaybackPlan.java $SRC/Vtt.java \
  app/src/test/java/app/marquee/client/*.java
java -cp "build/test-classes:$CP" org.junit.runner.JUnitCore app.marquee.client.LogicTest
