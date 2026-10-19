package app.marquee.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.webkit.CookieManager;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Downloads for watching without the internet (phone app). A title is saved either as its original
 * file (when this phone can play it) or as a smaller MP4 the server makes first; Android's download
 * manager fetches it in the background, with its own notification. The details the player needs
 * (titles, intro times, subtitles, the picture) are saved alongside, and the resume position is kept
 * here and sent to the server the next time the app is online.
 *
 * Each download's record (offline.json in the app's files):
 * { id, item, quality, state: preparing | downloading | done | failed, dm, file, error, size,
 *   progress (server conversion, 0-1), position, dirty, server, addedAt }
 */
final class OfflineStore {
    private static final String INDEX = "offline.json";
    private static final Set<String> polling = new HashSet<>();

    private OfflineStore() {}

    // ---------------------------------------------------------------- records
    static File dir(Context c) {
        File d = c.getExternalFilesDir("offline");
        if (d == null) d = new File(c.getFilesDir(), "offline");
        d.mkdirs();
        return d;
    }

    static synchronized JSONObject all(Context c) {
        try {
            File f = new File(c.getFilesDir(), INDEX);
            if (!f.exists()) return new JSONObject();
            return new JSONObject(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static synchronized void saveAll(Context c, JSONObject all) {
        File f = new File(c.getFilesDir(), INDEX), tmp = new File(c.getFilesDir(), INDEX + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(all.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            return;
        }
        tmp.renameTo(f);
    }

    static JSONObject get(Context c, String id) { return all(c).optJSONObject(id); }

    /** Changes one record (read, change, save in one go). */
    private static synchronized void update(Context c, String id, Edit edit) {
        JSONObject all = all(c);
        JSONObject e = all.optJSONObject(id);
        if (e == null) return;
        try { edit.apply(e); } catch (Exception ignored) { }
        try { all.put(id, e); } catch (Exception ignored) { }
        saveAll(c, all);
    }

    interface Edit { void apply(JSONObject e) throws Exception; }

    static boolean isDone(Context c, String id) {
        JSONObject e = get(c, id);
        return e != null && "done".equals(e.optString("state")) && file(c, e).exists();
    }

    static File file(Context c, JSONObject e) { return new File(dir(c), e.optString("file", e.optString("id") + ".mp4")); }
    static File picture(Context c, String id) { return new File(dir(c), id + ".jpg"); }
    static File subtitle(Context c, String id, String subId) { return new File(dir(c), id + "-" + subId.replaceAll("[^A-Za-z0-9_-]", "_") + ".vtt"); }

    /** Newest first. */
    static List<JSONObject> list(Context c) {
        JSONObject all = all(c);
        List<JSONObject> out = new ArrayList<>();
        for (Iterator<String> it = all.keys(); it.hasNext(); ) out.add(all.optJSONObject(it.next()));
        out.sort((a, b) -> Long.compare(b.optLong("addedAt"), a.optLong("addedAt")));
        return out;
    }

    // ---------------------------------------------------------------- starting a download
    /** "Download" on a title: asks which size, then starts. Call on the main thread. */
    static void choose(Activity a, String base, String id) {
        JSONObject existing = get(a, id);
        if (existing != null && !"failed".equals(existing.optString("state"))) {
            Toast.makeText(a, R.string.offline_already, Toast.LENGTH_SHORT).show();
            return;
        }
        Net.refreshCookie(base);
        String cookie = CookieManager.getInstance().getCookie(base);
        new Thread(() -> {
            try {
                JSONObject item = Net.getJson(base + "/api/items/" + id);
                JSONObject offer = Net.getJson(base + "/api/items/" + id + "/offline");
                a.runOnUiThread(() -> ask(a, base, cookie, item, offer));
            } catch (Exception e) {
                a.runOnUiThread(() -> Toast.makeText(a, a.getString(R.string.offline_failed, e.getMessage()), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private static void ask(Activity a, String base, String cookie, JSONObject item, JSONObject offer) {
        if (a.isFinishing()) return;
        List<String> labels = new ArrayList<>();
        List<String> choices = new ArrayList<>();
        JSONObject original = offer.optJSONObject("original");
        if (original != null && original.optBoolean("allowed") && playsAsIs(item)) {
            labels.add(a.getString(R.string.offline_original, size(original.optLong("size"))));
            choices.add("original");
        }
        JSONArray sizes = offer.optJSONArray("sizes");
        for (int i = 0; sizes != null && i < sizes.length(); i++) {
            JSONObject s = sizes.optJSONObject(i);
            labels.add(s.optString("label") + " · " + a.getString(R.string.offline_about, size(s.optLong("size"))));
            choices.add(s.optString("id"));
        }
        if (choices.isEmpty()) { Toast.makeText(a, R.string.offline_none, Toast.LENGTH_LONG).show(); return; }
        new AlertDialog.Builder(a)
            .setTitle(a.getString(R.string.offline_title, display(item)))
            .setItems(labels.toArray(new String[0]), (d, which) -> start(a, base, cookie, item, choices.get(which)))
            .setNegativeButton(android.R.string.cancel, null)
            .show();
    }

    private static void start(Activity a, String base, String cookie, JSONObject item, String quality) {
        Context c = a.getApplicationContext();
        String id = item.optString("id");
        boolean original = "original".equals(quality);
        int audio = original ? 0 : preferredAudio(item);
        try {
            JSONObject e = new JSONObject()
                .put("id", id).put("quality", quality).put("audio", audio).put("state", "preparing")
                .put("server", base).put("addedAt", System.currentTimeMillis())
                .put("file", id + (original ? extension(item.optString("fileName")) : ".mp4"));
            JSONObject p = item.optJSONObject("progress");
            if (p != null && !p.optBoolean("watched")) e.put("position", p.optDouble("position", 0));
            e.put("item", offlineItem(item, original ? -1 : audio));
            JSONObject all = all(c);
            all.put(id, e);
            saveAll(c, all);
        } catch (Exception ex) {
            return;
        }
        Toast.makeText(a, a.getString(R.string.offline_started, display(item)), Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            saveExtras(c, base, item);
            if (original) enqueue(c, base, cookie, id, base + "/api/items/" + id + "/stream?download=1");
            else prepare(c, base, cookie, id);
        }).start();
    }

    /** Whether this phone plays the original file as it is (the same test as the player's). */
    private static boolean playsAsIs(JSONObject item) {
        JSONObject media = item.optJSONObject("media");
        JSONObject v = media != null ? media.optJSONObject("video") : null;
        JSONArray audio = media != null ? media.optJSONArray("audio") : null;
        String aCodec = audio != null && audio.length() > 0 ? audio.optJSONObject(0).optString("codec", null) : null;
        return v != null && PlaybackPlan.canDirectPlay(item.optString("fileName"), v.optString("codec", null), v.optString("profile", null), aCodec, PlayerActivity.decoders());
    }

    /** The item as the player will see it offline: only what was saved (one sound track for a copy, text subtitles). */
    private static JSONObject offlineItem(JSONObject item, int audioOnly) throws Exception {
        JSONObject it = new JSONObject(item.toString());
        JSONArray subs = it.optJSONArray("subtitles");
        JSONArray kept = new JSONArray();
        for (int i = 0; subs != null && i < subs.length(); i++) if (!subs.optJSONObject(i).has("burn")) kept.put(subs.optJSONObject(i));
        it.put("subtitles", kept);
        if (audioOnly >= 0) {
            JSONArray tracks = it.optJSONArray("audioTracks");
            if (tracks != null && audioOnly < tracks.length()) it.put("audioTracks", new JSONArray().put(tracks.optJSONObject(audioOnly)));
            JSONObject media = it.optJSONObject("media");
            JSONArray audio = media != null ? media.optJSONArray("audio") : null;
            if (audio != null && audioOnly < audio.length()) media.put("audio", new JSONArray().put(audio.optJSONObject(audioOnly)));
        }
        return it;
    }

    /** The sound language picked last for this show, else the first track. */
    private static int preferredAudio(JSONObject item) {
        JSONObject pref = item.optJSONObject("tracks");
        String lang = pref != null && !pref.isNull("audio") ? pref.optString("audio") : null;
        JSONArray tracks = item.optJSONArray("audioTracks");
        for (int i = 0; lang != null && tracks != null && i < tracks.length(); i++) {
            if (lang.equals(tracks.optJSONObject(i).optString("lang"))) return i;
        }
        return 0;
    }

    /** The picture for the list and the text subtitles. */
    private static void saveExtras(Context c, String base, JSONObject item) {
        String id = item.optString("id");
        boolean ep = "episode".equals(item.optString("type"));
        try {
            byte[] b = Net.getBytes(base + "/api/art/" + (ep ? "thumb" : "backdrop") + "/" + id + "?v=" + item.optString("artV", ""));
            try (FileOutputStream out = new FileOutputStream(picture(c, id))) { out.write(b); }
        } catch (Exception ignored) { }
        JSONArray subs = item.optJSONArray("subtitles");
        for (int i = 0; subs != null && i < subs.length(); i++) {
            JSONObject s = subs.optJSONObject(i);
            if (s.has("burn")) continue;
            try {
                String vtt = Net.getText(base + "/api/items/" + id + "/subtitles/" + s.optString("id"));
                try (FileOutputStream out = new FileOutputStream(subtitle(c, id, s.optString("id")))) { out.write(vtt.getBytes(StandardCharsets.UTF_8)); }
            } catch (Exception ignored) { }
        }
    }

    /** A copy: asks the server to make it, waits until it's ready, then downloads it. */
    private static void prepare(Context c, String base, String cookie, String id) {
        synchronized (polling) { if (!polling.add(id)) return; }
        try {
            JSONObject e = get(c, id);
            if (e == null) return;
            String q = "quality=" + e.optString("quality") + "&audio=" + e.optInt("audio");
            JSONObject s = Net.postForJson(base + "/api/items/" + id + "/offline", new JSONObject().put("quality", e.optString("quality")).put("audio", e.optInt("audio")));
            while (true) {
                if (get(c, id) == null) return; // deleted meanwhile
                String state = s.optString("status");
                if ("ready".equals(state)) break;
                if ("failed".equals(state) || "none".equals(state)) {
                    String err = s.optString("error", c.getString(R.string.offline_server_failed));
                    update(c, id, x -> x.put("state", "failed").put("error", err));
                    return;
                }
                double progress = s.optDouble("progress", 0);
                boolean waiting = s.optBoolean("waiting"); // the server is busy playing something
                update(c, id, x -> x.put("progress", progress).put("waiting", waiting));
                Thread.sleep(4000);
                s = Net.getJson(base + "/api/items/" + id + "/offline?" + q).optJSONObject("copy");
                if (s == null) s = new JSONObject();
            }
            enqueue(c, base, cookie, id, base + "/api/items/" + id + "/offline/file?" + q);
        } catch (Exception ex) {
            // Offline or the app closed: carried on the next time the app opens (see resume).
        } finally {
            synchronized (polling) { polling.remove(id); }
        }
    }

    private static void enqueue(Context c, String base, String cookie, String id, String url) {
        JSONObject e = get(c, id);
        if (e == null) return;
        try {
            File target = file(c, e);
            target.delete();
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url))
                .setTitle(display(e.optJSONObject("item")))
                .setDescription("Marquee")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationUri(Uri.fromFile(target));
            if (cookie != null) r.addRequestHeader("Cookie", cookie);
            long dm = c.getSystemService(DownloadManager.class).enqueue(r);
            update(c, id, x -> x.put("state", "downloading").put("dm", dm).put("progress", 0));
        } catch (Exception ex) {
            String msg = ex.getMessage();
            update(c, id, x -> x.put("state", "failed").put("error", msg != null ? msg : "?"));
        }
    }

    // ---------------------------------------------------------------- keeping up to date
    /**
     * Brings the records up to date with the download manager; returns the downloads in progress as
     * id -> fraction done (0-1, or -1 when the size isn't known yet).
     */
    static java.util.Map<String, Double> refresh(Context c) {
        java.util.Map<String, Double> running = new java.util.HashMap<>();
        DownloadManager dm = c.getSystemService(DownloadManager.class);
        for (JSONObject e : list(c)) {
            if (!"downloading".equals(e.optString("state"))) continue;
            String id = e.optString("id");
            try (Cursor cur = dm.query(new DownloadManager.Query().setFilterById(e.optLong("dm")))) {
                if (cur == null || !cur.moveToFirst()) {
                    update(c, id, x -> x.put("state", "failed").put("error", c.getString(R.string.offline_cancelled)));
                    continue;
                }
                int status = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                long done = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                long total = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    long size = file(c, e).length();
                    update(c, id, x -> x.put("state", "done").put("size", size));
                } else if (status == DownloadManager.STATUS_FAILED) {
                    int reason = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                    update(c, id, x -> x.put("state", "failed").put("error", c.getString(R.string.offline_dm_failed, reason)));
                } else {
                    running.put(id, total > 0 ? (double) done / total : -1);
                }
            }
        }
        return running;
    }

    /** When the app opens: carries on copies the server was making, and sends saved positions. */
    static void resume(Context c, String base) {
        if (base == null) return;
        Net.refreshCookie(base);
        String cookie = CookieManager.getInstance().getCookie(base);
        Context app = c.getApplicationContext();
        new Thread(() -> {
            refresh(app);
            for (JSONObject e : list(app)) {
                String id = e.optString("id");
                if (!base.equals(e.optString("server"))) continue;
                if ("preparing".equals(e.optString("state"))) prepare(app, base, cookie, id);
            }
        }).start();
        syncProgress(app, base);
    }

    // ---------------------------------------------------------------- watching
    static void savePosition(Context c, String id, double position) {
        update(c, id, x -> x.put("position", position).put("dirty", true));
    }

    /** Positions from watching offline go to the server (so other devices resume there too). */
    static void syncProgress(Context c, String base) {
        new Thread(() -> {
            for (JSONObject e : list(c)) {
                if (!e.optBoolean("dirty") || !base.equals(e.optString("server"))) continue;
                String id = e.optString("id");
                double pos = e.optDouble("position", 0);
                try {
                    Net.postForJson(base + "/api/items/" + id + "/progress", new JSONObject().put("position", pos));
                    update(c, id, x -> { if (x.optDouble("position", 0) == pos) x.put("dirty", false); });
                } catch (Exception ignored) {
                    return; // offline: next time
                }
            }
        }).start();
    }

    static void delete(Context c, String id) {
        JSONObject e = get(c, id);
        if (e == null) return;
        if (e.has("dm")) {
            try { c.getSystemService(DownloadManager.class).remove(e.optLong("dm")); } catch (Exception ignored) { }
        }
        file(c, e).delete();
        File[] files = dir(c).listFiles();
        for (int i = 0; files != null && i < files.length; i++) if (files[i].getName().startsWith(id + "-") || files[i].getName().equals(id + ".jpg")) files[i].delete();
        synchronized (OfflineStore.class) {
            JSONObject all = all(c);
            all.remove(id);
            saveAll(c, all);
        }
    }

    // ---------------------------------------------------------------- words
    static String display(JSONObject item) {
        if (item == null) return "";
        if ("episode".equals(item.optString("type"))) {
            return item.optString("showTitle") + " · S" + item.optInt("season") + ":E" + item.optInt("episode") + " " + item.optString("title");
        }
        return item.optString("title");
    }

    static String size(long bytes) {
        if (bytes <= 0) return "?";
        if (bytes >= 1L << 30) return String.format(Locale.getDefault(), "%.1f GB", bytes / (double) (1L << 30));
        return String.format(Locale.getDefault(), "%d MB", Math.max(1, bytes >> 20));
    }

    private static String extension(String fileName) {
        int dot = fileName != null ? fileName.lastIndexOf('.') : -1;
        String ext = dot >= 0 ? fileName.substring(dot).toLowerCase(Locale.ROOT) : "";
        return ext.matches("\\.[a-z0-9]{1,5}") ? ext : ".mp4";
    }
}
