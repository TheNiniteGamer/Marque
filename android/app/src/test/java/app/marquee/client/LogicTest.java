package app.marquee.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.sun.net.httpserver.HttpServer;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.Test;

public class LogicTest {
    // ---------- ServerAddress ----------
    @Test public void bareHostGetsMarqueePort() {
        assertEquals("http://192.168.1.20:32500", ServerAddress.normalize("192.168.1.20"));
        assertEquals("http://my-pc:32500", ServerAddress.normalize("  My-PC  "));
    }

    @Test public void explicitPortAndSchemeAreKept() {
        assertEquals("http://nas:8080", ServerAddress.normalize("nas:8080"));
        assertEquals("https://media.example.com", ServerAddress.normalize("https://media.example.com/"));
        assertEquals("http://10.0.0.5:32500", ServerAddress.normalize("http://10.0.0.5:32500/#/library/abc"));
        assertEquals("http://[fe80::1]:32500", ServerAddress.normalize("[fe80::1]"));
    }

    @Test public void junkIsRejected() {
        assertNull(ServerAddress.normalize(""));
        assertNull(ServerAddress.normalize("ftp://host"));
        assertNull(ServerAddress.normalize("host:99999"));
        assertNull(ServerAddress.normalize("host:abc"));
        assertNull(ServerAddress.normalize("my server"));
        assertNull(ServerAddress.normalize("a:b:c"));
    }

    // ---------- Discovery ----------
    @Test public void subnetHostsSkipSelfNetworkAndBroadcast() {
        List<String> hosts = Discovery.subnetHosts(new byte[]{(byte) 192, (byte) 168, 1, 20}, 24);
        assertEquals(253, hosts.size());
        assertEquals("192.168.1.1", hosts.get(0));
        assertEquals("192.168.1.254", hosts.get(hosts.size() - 1));
        assertFalse(hosts.contains("192.168.1.20"));
    }

    @Test public void bigNetworksAreLimitedToTheDevicesSlash24() {
        List<String> hosts = Discovery.subnetHosts(new byte[]{10, 1, 2, 3}, 16);
        assertEquals(253, hosts.size());
        assertTrue(hosts.contains("10.1.2.200"));
        assertFalse(hosts.contains("10.1.3.1"));
    }

    @Test public void healthParsing() {
        assertNotNull(Discovery.parseHealth("u", "{\"ok\":true,\"name\":\"Marquee\",\"version\":\"0.1.0\"}"));
        assertNotNull(Discovery.parseHealth("u", "{\"ok\":true}")); // older servers
        assertEquals("Marquee on Den PC  ·  192.168.1.20",
            Discovery.parseHealth("http://192.168.1.20:32500", "{\"ok\":true,\"name\":\"Marquee\",\"server\":\"Den PC\"}").label());
        assertEquals("Marquee  ·  192.168.1.20", Discovery.parseHealth("http://192.168.1.20:32500", "{\"ok\":true,\"server\":null}").label());
        assertNull(Discovery.parseHealth("u", "{\"ok\":true,\"name\":\"SomethingElse\"}"));
        assertNull(Discovery.parseHealth("u", "<html>"));
        assertNull(Discovery.parseHealth("u", "{\"ok\":false}"));
    }

    @Test public void scanFindsARealServer() throws Exception {
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        s.createContext("/api/health", ex -> {
            byte[] b = "{\"ok\":true,\"name\":\"Marquee\",\"version\":\"9.9\"}".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        s.start();
        try {
            int port = s.getAddress().getPort();
            List<Discovery.Found> found = Discovery.scan(Arrays.asList("127.0.0.1", "127.0.0.2"), port, 500, null);
            assertEquals(1, found.size());
            assertEquals("http://127.0.0.1:" + port, found.get(0).url);
            assertEquals("9.9", found.get(0).version);
        } finally {
            s.stop(0);
        }
    }

    // ---------- PlaybackPlan ----------
    private static final Set<String> PHONE = new HashSet<>(Arrays.asList(
        "video/avc", "video/hevc", "video/x-vnd.on2.vp9", "audio/mp4a-latm", "audio/opus", "audio/mpeg", "audio/flac"));

    @Test public void directPlayWhenThePhoneHasTheDecoders() {
        assertTrue(PlaybackPlan.canDirectPlay("Movie.mkv", "hevc", "Main 10", "aac", PHONE));
        assertTrue(PlaybackPlan.canDirectPlay("a.MP4", "h264", "High", "aac", PHONE));
        assertTrue(PlaybackPlan.canDirectPlay("a.webm", "vp9", null, "opus", PHONE));
    }

    @Test public void convertWhenSomethingIsMissing() {
        assertFalse("AC3 audio without a Dolby decoder", PlaybackPlan.canDirectPlay("a.mkv", "h264", "High", "ac3", PHONE));
        assertFalse("AVI container", PlaybackPlan.canDirectPlay("a.avi", "h264", "High", "aac", PHONE));
        assertFalse("10-bit H.264", PlaybackPlan.canDirectPlay("a.mkv", "h264", "High 10", "aac", PHONE));
        assertFalse("AV1 without decoder", PlaybackPlan.canDirectPlay("a.mkv", "av1", null, "opus", PHONE));
        assertFalse("unknown codec", PlaybackPlan.canDirectPlay("a.mkv", "wmv3", null, "aac", PHONE));
    }

    @Test public void clockFormatting() {
        assertEquals("0:05", PlaybackPlan.clock(5.9));
        assertEquals("4:05", PlaybackPlan.clock(245));
        assertEquals("1:02:03", PlaybackPlan.clock(3723));
    }

    // ---------- Vtt ----------
    @Test public void vttParsingAndLookup() {
        String vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500 align:start\n<i>Hello</i> &amp; bye\n\n"
            + "00:01:05.250 --> 00:01:07.000\nLine one\nLine two\n\nNOTE comment\n";
        List<Vtt.Cue> cues = Vtt.parse(vtt);
        assertEquals(2, cues.size());
        assertEquals("Hello & bye", Vtt.textAt(cues, 2000));
        assertEquals("", Vtt.textAt(cues, 3600));
        assertEquals("Line one\nLine two", Vtt.textAt(cues, 66000));
        assertEquals(65250, cues.get(1).startMs);
    }

    @Test public void vttFromSrtStyleCommasAndCrlf() {
        List<Vtt.Cue> cues = Vtt.parse("WEBVTT\r\n\r\n00:00:00,500 --> 00:00:01,000\r\nHi\r\n");
        assertEquals(1, cues.size());
        assertEquals(500, cues.get(0).startMs);
    }

    // ---------- quality / adaptive streaming / skip intro ----------
    @Test public void qualityDefaultsToOriginalAtHomeAndAdaptiveAway() {
        assertEquals("original", PlaybackPlan.defaultQuality("", "192.168.1.20"));
        assertEquals("original", PlaybackPlan.defaultQuality(null, "my-pc"));
        assertEquals("original", PlaybackPlan.defaultQuality("", "172.20.0.4"));
        assertEquals("auto", PlaybackPlan.defaultQuality("", "marquee.tail1234.ts.net"));
        assertEquals("auto", PlaybackPlan.defaultQuality("", "172.40.1.1"));
        assertEquals("an explicit choice wins", "720p", PlaybackPlan.defaultQuality("720p", "192.168.1.20"));
    }

    @Test public void adaptiveStreamAddress() {
        assertEquals("/api/items/abc/hls/master.m3u8?sid=s1&audio=0&mt=t.o.k.en",
            PlaybackPlan.hlsPath("abc", "s1", 0, "auto", "t.o.k.en"));
        assertEquals("/api/items/abc/hls/master.m3u8?sid=s1&audio=2&q=480p",
            PlaybackPlan.hlsPath("abc", "s1", 2, "480p", null));
    }

    @Test public void skipIntroWindow() {
        assertFalse(PlaybackPlan.inIntro(4.9, 5, 35));
        assertTrue(PlaybackPlan.inIntro(5, 5, 35));
        assertTrue(PlaybackPlan.inIntro(33.9, 5, 35));
        assertFalse("hidden in the last second", PlaybackPlan.inIntro(34.5, 5, 35));
        assertFalse("no intro", PlaybackPlan.inIntro(10, 0, 0));
    }
}
