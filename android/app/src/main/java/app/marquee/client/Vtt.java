package app.marquee.client;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Minimal WebVTT parser for drawing subtitles over the video. */
public final class Vtt {
    public static final class Cue {
        public final long startMs, endMs;
        public final String text;
        Cue(long s, long e, String t) { startMs = s; endMs = e; text = t; }
    }

    private static final Pattern TIME = Pattern.compile("(?:(\\d+):)?(\\d{1,2}):(\\d{2})[.,](\\d{3})");

    private Vtt() {}

    public static List<Cue> parse(String vtt) {
        List<Cue> cues = new ArrayList<>();
        if (vtt == null) return cues;
        String[] blocks = vtt.replace("\r\n", "\n").replace('\r', '\n').split("\n{2,}");
        for (String block : blocks) {
            String[] lines = block.split("\n");
            for (int i = 0; i < lines.length; i++) {
                int arrow = lines[i].indexOf("-->");
                if (arrow < 0) continue;
                long start = time(lines[i].substring(0, arrow));
                long end = time(lines[i].substring(arrow + 3));
                if (start < 0 || end < 0) break;
                StringBuilder text = new StringBuilder();
                for (int j = i + 1; j < lines.length; j++) {
                    if (text.length() > 0) text.append('\n');
                    text.append(clean(lines[j]));
                }
                if (text.length() > 0) cues.add(new Cue(start, end, text.toString()));
                break;
            }
        }
        cues.sort((a, b) -> Long.compare(a.startMs, b.startMs));
        return cues;
    }

    /** Text of every cue showing at `ms`, or "" */
    public static String textAt(List<Cue> cues, long ms) {
        StringBuilder sb = new StringBuilder();
        for (Cue c : cues) {
            if (c.startMs > ms) break;
            if (ms < c.endMs) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(c.text);
            }
        }
        return sb.toString();
    }

    private static long time(String s) {
        Matcher m = TIME.matcher(s.trim());
        if (!m.find()) return -1;
        long h = m.group(1) != null ? Long.parseLong(m.group(1)) : 0;
        return ((h * 60 + Long.parseLong(m.group(2))) * 60 + Long.parseLong(m.group(3))) * 1000 + Long.parseLong(m.group(4));
    }

    private static String clean(String line) {
        return line.replaceAll("<[^>]*>", "").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&nbsp;", " ").replace("&quot;", "\"").replace("&#39;", "'");
    }
}
