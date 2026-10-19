package app.marquee.client;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.tv.TvContract;
import android.media.tv.TvContract.WatchNextPrograms;
import android.net.Uri;
import android.provider.BaseColumns;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Continue Watching on the Android TV home screen (its "Play next" / "Continue watching" row):
 * kept the same as the Continue Watching row on Marquee's home page each time the app comes to the
 * front, after the player closes too. Picking one there opens the app and plays it.
 */
final class WatchNext {
    static final String ACTION_PLAY = "app.marquee.client.PLAY";
    private static final int MAX = 12;
    private static volatile boolean running;

    private WatchNext() {}

    static boolean supported(Context c) {
        return c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
    }

    /** Call on the main thread (it reads the sign-in cookie there); the work runs in the background. */
    static void sync(Context c, String base) {
        if (base == null || running || !supported(c)) return;
        running = true;
        Net.refreshCookie(base);
        Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                Thread.sleep(2500); // let the player's last progress report land first
                syncNow(app, base);
            } catch (Exception ignored) {
                // Offline, or the TV has no home-screen rows: try again next time.
            } finally {
                running = false;
            }
        }).start();
    }

    private static void syncNow(Context c, String base) throws Exception {
        JSONArray items = new JSONArray();
        try {
            JSONArray hubs = Net.getJson(base + "/api/home").optJSONArray("hubs");
            for (int i = 0; hubs != null && i < hubs.length(); i++) {
                JSONObject hub = hubs.optJSONObject(i);
                if (hub != null && "continue".equals(hub.optString("key"))) items = hub.optJSONArray("items");
            }
        } catch (IOException e) {
            if (!Net.SIGNED_OUT.equals(e.getMessage())) throw e; // signed out: nothing to continue
        }

        // This app's rows there now (an app only sees its own). Ones the viewer removed stay removed.
        ContentResolver cr = c.getContentResolver();
        Map<String, Long> rows = new HashMap<>();
        Set<String> removed = new HashSet<>();
        try (Cursor cur = cr.query(WatchNextPrograms.CONTENT_URI,
                new String[] { BaseColumns._ID, WatchNextPrograms.COLUMN_INTERNAL_PROVIDER_ID, WatchNextPrograms.COLUMN_BROWSABLE }, null, null, null)) {
            while (cur != null && cur.moveToNext()) {
                String id = cur.getString(1);
                if (id == null) continue;
                rows.put(id, cur.getLong(0));
                if (cur.getInt(2) == 0) removed.add(id);
            }
        }

        File dir = ArtProvider.dir(c);
        Set<String> keep = new HashSet<>();
        Set<String> pictures = new HashSet<>();
        for (int i = 0; items != null && i < items.length() && keep.size() < MAX; i++) {
            JSONObject it = items.optJSONObject(i);
            String id = it != null ? it.optString("id") : "";
            if (id.isEmpty() || !id.matches("[A-Za-z0-9_-]+")) continue;
            keep.add(id);
            if (removed.contains(id)) continue;
            String picture = picture(base, it, dir);
            if (picture != null) pictures.add(picture);
            ContentValues v = values(c, it, picture);
            Long row = rows.get(id);
            if (row != null) cr.update(TvContract.buildWatchNextProgramUri(row), v, null, null);
            else cr.insert(WatchNextPrograms.CONTENT_URI, v);
        }
        for (Map.Entry<String, Long> e : rows.entrySet()) {
            if (!keep.contains(e.getKey())) cr.delete(TvContract.buildWatchNextProgramUri(e.getValue()), null, null);
        }
        File[] old = dir.listFiles();
        for (int i = 0; old != null && i < old.length; i++) if (!pictures.contains(old[i].getName())) old[i].delete();
    }

    private static ContentValues values(Context c, JSONObject it, String picture) {
        String id = it.optString("id");
        boolean episode = "episode".equals(it.optString("type"));
        JSONObject p = it.optJSONObject("progress");
        double position = p != null && !p.optBoolean("watched") ? p.optDouble("position", 0) : 0;
        long seen = p != null ? p.optLong("updatedAt", 0) : 0;
        ContentValues v = new ContentValues();
        v.put(WatchNextPrograms.COLUMN_INTERNAL_PROVIDER_ID, id);
        v.put(WatchNextPrograms.COLUMN_TYPE, episode ? WatchNextPrograms.TYPE_TV_EPISODE : WatchNextPrograms.TYPE_MOVIE);
        v.put(WatchNextPrograms.COLUMN_WATCH_NEXT_TYPE, position > 0 ? WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE : WatchNextPrograms.WATCH_NEXT_TYPE_NEXT);
        if (episode) {
            v.put(WatchNextPrograms.COLUMN_TITLE, it.optString("showTitle"));
            v.put(WatchNextPrograms.COLUMN_EPISODE_TITLE, it.optString("title"));
            if (it.has("season")) v.put(WatchNextPrograms.COLUMN_SEASON_DISPLAY_NUMBER, String.valueOf(it.optInt("season")));
            if (it.has("episode")) v.put(WatchNextPrograms.COLUMN_EPISODE_DISPLAY_NUMBER, String.valueOf(it.optInt("episode")));
        } else {
            v.put(WatchNextPrograms.COLUMN_TITLE, it.optString("title"));
            if (!it.isNull("year")) v.put(WatchNextPrograms.COLUMN_RELEASE_DATE, String.valueOf(it.optInt("year")));
        }
        String overview = it.optString("overview", "");
        if (!overview.isEmpty() && !"null".equals(overview)) v.put(WatchNextPrograms.COLUMN_SHORT_DESCRIPTION, overview);
        v.put(WatchNextPrograms.COLUMN_DURATION_MILLIS, (int) (it.optDouble("duration", 0) * 1000));
        v.put(WatchNextPrograms.COLUMN_LAST_PLAYBACK_POSITION_MILLIS, (int) (position * 1000));
        v.put(WatchNextPrograms.COLUMN_LAST_ENGAGEMENT_TIME_UTC_MILLIS, seen > 0 ? seen : System.currentTimeMillis());
        if (picture != null) {
            v.put(WatchNextPrograms.COLUMN_POSTER_ART_URI, ArtProvider.uri(c, picture).toString());
            v.put(WatchNextPrograms.COLUMN_POSTER_ART_ASPECT_RATIO, WatchNextPrograms.ASPECT_RATIO_16_9);
        }
        Intent open = new Intent(c, MainActivity.class).setAction(ACTION_PLAY).setData(Uri.parse("marquee-play:" + id))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        v.put(WatchNextPrograms.COLUMN_INTENT_URI, open.toUri(Intent.URI_INTENT_SCHEME));
        return v;
    }

    /** The title's wide picture, saved for the home screen to show (kept until its artwork changes). */
    private static String picture(String base, JSONObject it, File dir) {
        String id = it.optString("id");
        String version = it.optString("artV", "0").replaceAll("[^A-Za-z0-9]", "");
        String name = id + "-" + version + ".jpg";
        File f = new File(dir, name);
        if (f.length() > 0) return name;
        String kind = "episode".equals(it.optString("type")) ? "thumb" : "backdrop";
        try {
            byte[] b = Net.getBytes(base + "/api/art/" + kind + "/" + id + "?v=" + version);
            try (FileOutputStream out = new FileOutputStream(f)) { out.write(b); }
            return name;
        } catch (IOException e) {
            f.delete();
            return null;
        }
    }

    /** From a Watch Next card: the title it plays, or null. */
    static String playId(Intent i) {
        if (i == null || !ACTION_PLAY.equals(i.getAction()) || i.getData() == null) return null;
        String id = i.getData().getSchemeSpecificPart();
        return id != null && id.matches("[A-Za-z0-9_-]+") ? id : null;
    }
}
