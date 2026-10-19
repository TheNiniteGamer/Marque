package app.marquee.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.File;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Downloads on this phone: what's saved, what's still coming, and how much space it takes. Works
 * without the internet (it's opened from the "can't reach the server" page too). Tap to watch,
 * ✕ to delete.
 */
public class DownloadsActivity extends Activity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable tick = this::tickLoop;
    private LinearLayout list;
    private TextView footer;
    private String shown = "";
    private final Map<String, TextView> statusViews = new HashMap<>();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(getColor(R.color.bg));
        root.setFitsSystemWindows(true);

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(4), dp(8), dp(16), dp(8));
        ImageButton back = new ImageButton(this);
        back.setImageResource(R.drawable.ic_back);
        back.setBackground(null);
        back.setContentDescription(getString(android.R.string.cancel));
        back.setPadding(dp(12), dp(12), dp(12), dp(12));
        back.setOnClickListener(v -> finish());
        bar.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));
        TextView heading = text(getString(R.string.downloads_title), 22, R.color.text, true);
        heading.setPadding(dp(8), 0, 0, 0);
        bar.addView(heading);
        root.addView(bar);

        ScrollView scroll = new ScrollView(this);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(0, 0, 0, dp(16));
        scroll.addView(list);
        root.addView(scroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        // Wi-Fi only (for downloads started from now on: Android can't change ones already going).
        android.widget.Switch wifi = new android.widget.Switch(this);
        wifi.setText(R.string.downloads_wifi_only);
        wifi.setTextColor(getColor(R.color.text));
        wifi.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        wifi.setChecked(Prefs.offlineWifiOnly(this));
        wifi.setPadding(dp(16), dp(10), dp(16), dp(4));
        wifi.setOnCheckedChangeListener((v, on) -> Prefs.setOfflineWifiOnly(this, on));
        root.addView(wifi, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        footer = text("", 13, R.color.muted, false);
        footer.setPadding(dp(16), dp(4), dp(16), dp(14));
        root.addView(footer);
        setContentView(root);
    }

    @Override
    protected void onResume() {
        super.onResume();
        String base = Prefs.server(this);
        OfflineStore.resume(this, base);
        shown = "";
        ui.post(tick);
    }

    @Override
    protected void onPause() {
        ui.removeCallbacks(tick);
        super.onPause();
    }

    private void tickLoop() {
        Map<String, Double> running = OfflineStore.refresh(this);
        List<JSONObject> all = OfflineStore.list(this);
        StringBuilder sig = new StringBuilder();
        boolean busy = false;
        for (JSONObject e : all) {
            String st = e.optString("state");
            sig.append(e.optString("id")).append(st).append(';');
            if ("preparing".equals(st) || "downloading".equals(st)) busy = true;
        }
        if (!sig.toString().equals(shown)) { shown = sig.toString(); build(all); }
        for (JSONObject e : all) {
            TextView s = statusViews.get(e.optString("id"));
            if (s != null) s.setText(status(e, running.get(e.optString("id"))));
        }
        if (busy) ui.postDelayed(tick, 1000);
    }

    private void build(List<JSONObject> all) {
        list.removeAllViews();
        statusViews.clear();
        long used = 0;
        if (all.isEmpty()) {
            TextView empty = text(getString(R.string.downloads_empty), 15, R.color.muted, false);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(dp(32), dp(80), dp(32), 0);
            list.addView(empty);
        }
        for (JSONObject e : all) {
            used += e.optLong("size", 0);
            list.addView(row(e));
        }
        File dir = OfflineStore.dir(this);
        footer.setText(getString(R.string.downloads_space, OfflineStore.size(used), OfflineStore.size(dir.getUsableSpace())));
    }

    private View row(JSONObject e) {
        String id = e.optString("id");
        JSONObject item = e.optJSONObject("item");
        if (item == null) item = new JSONObject();
        boolean ep = "episode".equals(item.optString("type"));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), dp(10), dp(4), dp(10));
        TypedValue tv = new TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, tv, true);
        row.setBackgroundResource(tv.resourceId);

        ImageView pic = new ImageView(this);
        pic.setScaleType(ImageView.ScaleType.CENTER_CROP);
        pic.setBackgroundColor(getColor(R.color.bg3));
        File pf = OfflineStore.picture(this, id);
        if (pf.exists()) {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = 2;
            Bitmap b = BitmapFactory.decodeFile(pf.getPath(), o);
            if (b != null) pic.setImageBitmap(b);
        }
        row.addView(pic, new LinearLayout.LayoutParams(dp(128), dp(72)));

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.setPadding(dp(14), 0, dp(8), 0);
        TextView t1 = text(ep ? item.optString("showTitle") : item.optString("title"), 16, R.color.text, true);
        t1.setMaxLines(2);
        texts.addView(t1);
        String sub = ep ? "S" + item.optInt("season") + ":E" + item.optInt("episode") + "  " + item.optString("title")
            : (item.optInt("year", 0) > 0 ? String.valueOf(item.optInt("year")) : "");
        if (!sub.isEmpty()) {
            TextView t2 = text(sub, 13, R.color.muted, false);
            t2.setMaxLines(1);
            texts.addView(t2);
        }
        TextView status = text("", 13, R.color.muted, false);
        texts.addView(status);
        statusViews.put(id, status);
        row.addView(texts, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        TextView del = text("✕", 20, R.color.muted, false);
        del.setGravity(Gravity.CENTER);
        del.setContentDescription(getString(R.string.downloads_delete_ok));
        del.setOnClickListener(v -> confirmDelete(id, OfflineStore.display(e.optJSONObject("item"))));
        row.addView(del, new LinearLayout.LayoutParams(dp(48), dp(48)));

        row.setOnClickListener(v -> open(e));
        return row;
    }

    private void open(JSONObject e) {
        String id = e.optString("id");
        String state = e.optString("state");
        if ("done".equals(state) && OfflineStore.isDone(this, id)) {
            try {
                JSONObject req = new JSONObject().put("offline", true).put("id", id).put("start", -1);
                startActivity(new Intent(this, PlayerActivity.class).putExtra(PlayerActivity.EXTRA_REQUEST, req.toString()));
            } catch (Exception ignored) { }
        } else if ("failed".equals(state)) {
            // Try again (needs the server).
            String base = Prefs.server(this);
            if (base != null) OfflineStore.choose(this, base, id);
        }
    }

    private void confirmDelete(String id, String name) {
        new AlertDialog.Builder(this)
            .setTitle(R.string.downloads_delete)
            .setMessage(name)
            .setPositiveButton(R.string.downloads_delete_ok, (d, w) -> { OfflineStore.delete(this, id); shown = ""; ui.removeCallbacks(tick); ui.post(tick); })
            .setNegativeButton(android.R.string.cancel, null)
            .show();
    }

    private String status(JSONObject e, Double fraction) {
        switch (e.optString("state")) {
            case "preparing":
                if (e.optBoolean("waiting")) return getString(R.string.downloads_waiting);
                return getString(R.string.downloads_preparing, (int) Math.round(e.optDouble("progress", 0) * 100));
            case "downloading":
                if (fraction != null && fraction == OfflineStore.WAITING_FOR_WIFI) return getString(R.string.downloads_wifi_wait);
                return fraction != null && fraction >= 0 ? getString(R.string.downloads_progress, (int) Math.round(fraction * 100)) : getString(R.string.downloads_starting);
            case "failed":
                return getString(R.string.downloads_failed, e.optString("error", "?"));
            default: {
                String q = e.optString("quality");
                String label = "original".equals(q) ? getString(R.string.downloads_original) : q;
                JSONObject item = e.optJSONObject("item");
                double pos = e.optDouble("position", 0), dur = item != null ? item.optDouble("duration", 0) : 0;
                String left = pos > 15 && dur > 0 && pos < dur - 30 ? " · " + getString(R.string.downloads_left, Math.max(1, (int) Math.round((dur - pos) / 60))) : "";
                return label + " · " + OfflineStore.size(e.optLong("size")) + left;
            }
        }
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(getColor(color));
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
