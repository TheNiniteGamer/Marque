package app.marquee.client;

import java.util.Locale;

/** Turns what people type ("192.168.1.20", "nas:32500", "https://media.example.com/") into a base URL. */
public final class ServerAddress {
    public static final int DEFAULT_PORT = 32500;

    private ServerAddress() {}

    /** Returns e.g. "http://192.168.1.20:32500", or null if the input can't be a server address. */
    public static String normalize(String input) {
        if (input == null) return null;
        String s = input.trim();
        if (s.isEmpty()) return null;
        String scheme = "http";
        boolean explicitScheme = false;
        int sep = s.indexOf("://");
        if (sep >= 0) {
            scheme = s.substring(0, sep).toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) return null;
            s = s.substring(sep + 3);
            explicitScheme = true;
        }
        int cut = firstIndexOf(s, '/', '#', '?');
        if (cut >= 0) s = s.substring(0, cut);
        if (s.isEmpty()) return null;

        String host;
        int port = -1;
        if (s.startsWith("[")) { // IPv6 literal
            int end = s.indexOf(']');
            if (end < 0) return null;
            host = s.substring(0, end + 1);
            String rest = s.substring(end + 1);
            if (rest.startsWith(":")) port = parsePort(rest.substring(1));
            else if (!rest.isEmpty()) return null;
            if (rest.startsWith(":") && port < 0) return null;
        } else {
            int colon = s.indexOf(':');
            if (colon >= 0) {
                if (s.indexOf(':', colon + 1) >= 0) return null;
                host = s.substring(0, colon);
                port = parsePort(s.substring(colon + 1));
                if (port < 0) return null;
            } else {
                host = s;
            }
            if (!host.matches("[A-Za-z0-9.\\-]+") || host.startsWith(".") || host.startsWith("-")) return null;
        }
        // A bare host means Marquee's default port; an explicit http(s):// address is used as written.
        if (port < 0 && !explicitScheme) port = DEFAULT_PORT;
        return scheme + "://" + host.toLowerCase(Locale.ROOT) + (port > 0 ? ":" + port : "");
    }

    private static int parsePort(String p) {
        if (!p.matches("\\d{1,5}")) return -1;
        int n = Integer.parseInt(p);
        return n >= 1 && n <= 65535 ? n : -1;
    }

    private static int firstIndexOf(String s, char... chars) {
        int best = -1;
        for (char c : chars) {
            int i = s.indexOf(c);
            if (i >= 0 && (best < 0 || i < best)) best = i;
        }
        return best;
    }
}
