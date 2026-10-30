package app.marquee.client;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

/** Remembers the current server and recently used ones. */
final class Prefs {
    private static final String FILE = "marquee";

    private Prefs() {}

    private static SharedPreferences p(Context c) { return c.getSharedPreferences(FILE, Context.MODE_PRIVATE); }

    static String server(Context c) { return p(c).getString("server", null); }

    static void setServer(Context c, String url) {
        List<String> recent = recent(c);
        recent.remove(url);
        recent.add(0, url);
        while (recent.size() > 5) recent.remove(recent.size() - 1);
        p(c).edit().putString("server", url).putString("recent", new JSONArray(recent).toString()).apply();
    }

    /** Whether the user said "Later" to this app version in the last week (not offered at start-up then). */
    static boolean skippedUpdate(Context c, long code) {
        long ago = System.currentTimeMillis() - p(c).getLong("skippedUpdateAt", 0);
        return p(c).getLong("skippedUpdate", 0) == code && ago >= 0 && ago < 7 * 24 * 3600_000L;
    }

    static void setSkippedUpdate(Context c, long code) {
        p(c).edit().putLong("skippedUpdate", code).putLong("skippedUpdateAt", System.currentTimeMillis()).apply();
    }

    /** Notifications up to this time have been shown on the phone (see NotifyJob). */
    static long notifiedUpTo(Context c) { return p(c).getLong("notifiedUpTo", 0); }

    static void setNotifiedUpTo(Context c, long at) { p(c).edit().putLong("notifiedUpTo", at).apply(); }

    static boolean askedNotifications(Context c) { return p(c).getBoolean("askedNotifications", false); }

    static void setAskedNotifications(Context c) { p(c).edit().putBoolean("askedNotifications", true).apply(); }

    /** Phone downloads only on Wi-Fi (the default, as on the big streaming apps). */
    static boolean offlineWifiOnly(Context c) { return p(c).getBoolean("offlineWifiOnly", true); }

    static void setOfflineWifiOnly(Context c, boolean on) { p(c).edit().putBoolean("offlineWifiOnly", on).apply(); }

    static void clearServer(Context c) { p(c).edit().remove("server").apply(); }

    static List<String> recent(Context c) {
        List<String> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(p(c).getString("recent", "[]"));
            for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        } catch (Exception ignored) { }
        return out;
    }
}
