package app.marquee.client;

import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** Small HTTP helpers that reuse the web view's sign-in cookie. Call them off the main thread. */
final class Net {
    private Net() {}

    static final String SIGNED_OUT = "You're signed out. Sign in again in the app.";

    // The sign-in cookie, read from the web view on the main thread and reused by background requests.
    private static volatile String cookie;

    /** Call on the main thread (after the page has loaded / before playing). */
    static void refreshCookie(String baseUrl) {
        cookie = CookieManager.getInstance().getCookie(baseUrl);
    }

    static Map<String, String> headers(String url) {
        Map<String, String> h = new HashMap<>();
        String c = cookie;
        if (c != null) h.put("Cookie", c);
        return h;
    }

    private static HttpURLConnection open(String url, int timeoutMs) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(timeoutMs);
        c.setReadTimeout(timeoutMs);
        for (Map.Entry<String, String> e : headers(url).entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
        return c;
    }

    static String getText(String url) throws IOException {
        HttpURLConnection c = open(url, 15000);
        try {
            int code = c.getResponseCode();
            if (code == 401) throw new IOException(SIGNED_OUT);
            if (code != 200) throw new IOException("The server answered " + code);
            return Discovery.readAll(c.getInputStream(), 8 * 1024 * 1024);
        } finally {
            c.disconnect();
        }
    }

    /** For pictures (preview sheets, thumbnails). */
    static byte[] getBytes(String url) throws IOException {
        HttpURLConnection c = open(url, 15000);
        try {
            if (c.getResponseCode() != 200) throw new IOException("The server answered " + c.getResponseCode());
            java.io.InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0 && out.size() < 32 * 1024 * 1024) out.write(buf, 0, n);
            in.close();
            return out.toByteArray();
        } finally {
            c.disconnect();
        }
    }

    static JSONObject getJson(String url) throws IOException {
        try { return new JSONObject(getText(url)); } catch (org.json.JSONException e) { throw new IOException("Unexpected answer from the server"); }
    }

    static void postJson(String url, JSONObject body) { send("POST", url, body); }

    static void putJson(String url, JSONObject body) { send("PUT", url, body); }

    private static void send(String method, String url, JSONObject body) {
        HttpURLConnection c = null;
        try {
            c = open(url, 10000);
            c.setRequestMethod(method);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
            c.getResponseCode();
        } catch (IOException ignored) {
            // Progress reports are best effort.
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static void delete(String url) {
        HttpURLConnection c = null;
        try {
            c = open(url, 10000);
            c.setRequestMethod("DELETE");
            c.getResponseCode();
        } catch (IOException ignored) {
            // Best effort: the server also stops idle streams on its own.
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
