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
