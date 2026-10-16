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

    /** "1:02:03" / "4:05" */
    public static String clock(double seconds) {
        long s = Math.max(0, (long) seconds);
        long h = s / 3600, m = (s / 60) % 60, sec = s % 60;
        return h > 0 ? String.format(Locale.ROOT, "%d:%02d:%02d", h, m, sec) : String.format(Locale.ROOT, "%d:%02d", m, sec);
    }
}
