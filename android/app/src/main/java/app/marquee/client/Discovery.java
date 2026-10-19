package app.marquee.client;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Finds Marquee servers on the local network by asking every address in the subnet for /api/health. */
public final class Discovery {
    public static final class Found {
        public final String url, name, version;
        /** The PC's name (empty from older servers). */
        public final String server;
        Found(String url, String name, String version, String server) { this.url = url; this.name = name; this.version = version; this.server = server; }
        /** "Marquee on Living room PC · 192.168.1.20" for lists. */
        public String label() {
            String host = url.replace("http://", "").replace(":" + ServerAddress.DEFAULT_PORT, "");
            return (server.isEmpty() ? "Marquee" : "Marquee on " + server) + "  ·  " + host;
        }
    }

    public interface Listener { void onFound(Found f); }

    private Discovery() {}

    /** Addresses to probe for a device at ipv4/prefix. Networks bigger than /24 are limited to the device's /24. */
    public static List<String> subnetHosts(byte[] ipv4, int prefix) {
        int ip = ((ipv4[0] & 0xff) << 24) | ((ipv4[1] & 0xff) << 16) | ((ipv4[2] & 0xff) << 8) | (ipv4[3] & 0xff);
        int p = Math.max(24, Math.min(30, prefix));
        int mask = p == 0 ? 0 : -1 << (32 - p);
        int network = ip & mask;
        int broadcast = network | ~mask;
        List<String> out = new ArrayList<>();
        for (int a = network + 1; a < broadcast; a++) {
            if (a == ip) continue;
            out.add(((a >>> 24) & 0xff) + "." + ((a >>> 16) & 0xff) + "." + ((a >>> 8) & 0xff) + "." + (a & 0xff));
        }
        return out;
    }

    /** Parses /api/health. Older servers only send {"ok":true}. Returns null if it isn't Marquee. */
    public static Found parseHealth(String url, String body) {
        try {
            JSONObject o = new JSONObject(body);
            if (!o.optBoolean("ok", false)) return null;
            String name = o.optString("name", "Marquee");
            if (!name.isEmpty() && !name.equals("Marquee")) return null;
            String server = o.isNull("server") ? "" : o.optString("server", "");
            return new Found(url, "Marquee", o.optString("version", ""), server);
        } catch (Exception e) {
            return null;
        }
    }

    /** Asks one server for /api/health; returns null if nothing (or not Marquee) answers. */
    public static Found probe(String baseUrl, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(baseUrl + "/api/health").openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setInstanceFollowRedirects(false);
            if (c.getResponseCode() != 200) return null;
            return parseHealth(baseUrl, readAll(c.getInputStream(), 4096));
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Probes all hosts in parallel; blocks until done. */
    public static List<Found> scan(List<String> hosts, int port, int timeoutMs, Listener listener) {
        List<Found> found = new ArrayList<>();
        ExecutorService pool = Executors.newFixedThreadPool(48);
        for (String h : hosts) {
            pool.execute(() -> {
                Found f = probe("http://" + h + ":" + port, timeoutMs);
                if (f != null) {
                    synchronized (found) { found.add(f); }
                    if (listener != null) listener.onFound(f);
                }
            });
        }
        pool.shutdown();
        try { pool.awaitTermination(60, TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        return found;
    }

    static String readAll(InputStream in, int max) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[2048];
        int n;
        while ((n = in.read(buf)) > 0 && out.size() < max) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }
}
