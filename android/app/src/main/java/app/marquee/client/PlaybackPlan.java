package app.marquee.client;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Decides whether the phone can play a file as-is ("direct play") or should ask the server to convert it.
 * Android's own player handles these containers; codecs are checked against the phone's real decoders.
 */
public final class PlaybackPlan {
    // (Set.of needs Android 11; this app supports Android 8+.)
    private static final Set<String> CONTAINERS = new HashSet<>(Arrays.asList("mp4", "m4v", "mov", "mkv", "webm", "ts", "m2ts", "mts", "3gp", "3g2"));

    private PlaybackPlan() {}

    // The other codes files label languages with ("eng" for "en"…): see LANG_ALIASES in the web app.
    private static final String[][] LANG_ALIASES = {
        { "en", "eng" }, { "es", "spa" }, { "fr", "fre", "fra" }, { "de", "ger", "deu" }, { "it", "ita" }, { "pt", "por" },
        { "nl", "dut", "nld" }, { "sv", "swe" }, { "pl", "pol" }, { "ru", "rus" }, { "tr", "tur" }, { "ar", "ara" },
        { "hi", "hin" }, { "ja", "jpn" }, { "ko", "kor" }, { "zh", "chi", "zho" },
    };

    /** Whether a track's language ("eng", "en-US"…) is the account's `code` ("en"). */
    public static boolean sameLang(String lang, String code) {
        if (lang == null || code == null || lang.isEmpty() || code.isEmpty()) return false;
        String l = lang.toLowerCase(Locale.ROOT).split("[-_]")[0];
        if (l.equals(code)) return true;
        for (String[] a : LANG_ALIASES) {
            if (!a[0].equals(code)) continue;
            for (int i = 1; i < a.length; i++) if (a[i].equals(l)) return true;
        }
        return false;
    }

    public static String videoMime(String codec) {
        if (codec == null) return null;
        switch (codec) {
            case "h264": return "video/avc";
            case "hevc": return "video/hevc";
            case "vp8": return "video/x-vnd.on2.vp8";
            case "vp9": return "video/x-vnd.on2.vp9";
            case "av1": return "video/av01";
            case "mpeg4": return "video/mp4v-es";
            case "mpeg2video": return "video/mpeg2";
            default: return null;
        }
    }

    public static String audioMime(String codec) {
        if (codec == null) return null;
        if (codec.startsWith("pcm_")) return "audio/raw";
        switch (codec) {
            case "aac": return "audio/mp4a-latm";
            case "mp3": return "audio/mpeg";
            case "opus": return "audio/opus";
            case "vorbis": return "audio/vorbis";
            case "flac": return "audio/flac";
            case "ac3": return "audio/ac3";
            case "eac3": return "audio/eac3";
            case "dts": return "audio/vnd.dts";
            case "truehd": return "audio/true-hd";
            default: return null;
        }
    }

    /**
     * @param decoders MIME types the phone has decoders for (lower case), e.g. from MediaCodecList.
     */
    public static boolean canDirectPlay(String fileName, String videoCodec, String videoProfile, String audioCodec, Set<String> decoders) {
        if (fileName == null) return false;
        int dot = fileName.lastIndexOf('.');
        String ext = dot >= 0 ? fileName.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        if (!CONTAINERS.contains(ext)) return false;
        if (videoCodec != null) {
            String vm = videoMime(videoCodec);
            if (vm == null || !decoders.contains(vm)) return false;
            // 10-bit H.264 has almost no hardware support on phones.
            if ("h264".equals(videoCodec) && videoProfile != null && videoProfile.contains("10")) return false;
        }
        if (audioCodec != null) {
            String am = audioMime(audioCodec);
            if (am == null || !decoders.contains(am)) return false;
        }
        return true;
    }

    /**
     * Streaming quality: the user's choice from the web app's Account page if they made one;
     * otherwise the original file at home and adaptive streaming when connected from outside.
     */
    public static String defaultQuality(String pref, String host) {
        if (pref != null && !pref.isEmpty()) return pref;
        String h = host == null ? "" : host.toLowerCase(Locale.ROOT);
        boolean home = h.equals("localhost") || h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.")
            || h.matches("172\\.(1[6-9]|2\\d|3[01])\\..*") || h.endsWith(".local") || h.startsWith("[") || !h.contains(".");
        return home ? "original" : "auto";
    }

    /** Adaptive-streaming address (relative to the server) for a quality other than "original". */
    public static String hlsPath(String itemId, String sid, int audio, String quality, String token) {
        StringBuilder b = new StringBuilder("/api/items/").append(itemId).append("/hls/master.m3u8?sid=").append(sid).append("&audio=").append(audio);
        if (!"auto".equals(quality)) b.append("&q=").append(quality);
        if (token != null && !token.isEmpty()) b.append("&mt=").append(token); // tokens are URL-safe already
        return b.toString();
    }

    /** Whether to offer "Skip Intro" at time t (hidden in the last second so it doesn't flash). */
    public static boolean inIntro(double t, double start, double end) {
        return end > start && t >= start && t < end - 1;
    }

    /** "1:02:03" / "4:05" */
    public static String clock(double seconds) {
        long s = Math.max(0, (long) seconds);
        long h = s / 3600, m = (s / 60) % 60, sec = s % 60;
        return h > 0 ? String.format(Locale.ROOT, "%d:%02d:%02d", h, m, sec) : String.format(Locale.ROOT, "%d:%02d", m, sec);
    }
}
