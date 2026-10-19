package app.marquee.client;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The player's controls, on phones and TVs, laid out like the big streaming apps (and Marquee's
 * Roku channel). On a phone everything is tapped (the screen shows and hides them, the bar can be
 * dragged). With a TV remote:
 * OK or ▶‖ pauses and plays; any key shows the title, a progress bar with the time left and
 * back 10 / play / ahead 10; left/right scrub with preview pictures (hold to speed up, release to
 * jump there); Down reaches Episodes, Audio & Subtitles and Next Episode; at the credits a Next
 * Episode card counts down; paused for a while, it shows what you're watching.
 * Nothing takes Android focus: the keys come here from PlayerActivity.dispatchKeyEvent.
 */
@SuppressWarnings("ClickableViewAccessibility")
final class PlayerControls {
    /** Episodes started by themselves in a row; any key resets it. After three, ask first. */
    static int autoNexts;

    interface Pick { void pick(int index); }

    private final PlayerActivity a;
    private final boolean tv;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final View controls, preview, played, knob, track, upNext, idle, panel;
    private final ImageView previewImg, playIcon, bigPlay, nextThumb;
    private final TextView previewTime, time, nextKind, nextTitle, nextBtn0, nextBtn1;
    private final LinearLayout left, right, panelCols;
    private final float dp;

    // The buttons under the bar, left to right.
    private final List<View> ctls = new ArrayList<>();
    private final List<String> actions = new ArrayList<>();
    private String zone = "bar";
    private int ctlIndex;

    private boolean scrubbing, wasPaused;
    private double scrubPos;
    private long lastStep;

    private boolean stillWatching, countingDown;
    private int count, upNextIndex;

    private JSONObject tp;           // the server's preview pictures (trickplay), once made
    private long tpAskedAt;
    private int sheetIndex = -1, sheetWanted = -1;
    private Bitmap sheet;

    // Audio & Subtitles panel: one column per choice.
    private final List<List<TextView>> cols = new ArrayList<>();
    private final List<Pick> picks = new ArrayList<>();
    private final List<Integer> chosen = new ArrayList<>();
    private int panelCol, panelRow;

    private final Runnable commit = this::commitScrub;
    private final Runnable hide = this::hideIfPlaying;
    private final Runnable idleRun = this::showIdle;
    private final Runnable countRun = this::countdownTick;
    private final Runnable fadeRun = this::fadeUpNext;

    PlayerControls(PlayerActivity a, boolean tv) {
        this.a = a;
        this.tv = tv;
        dp = a.getResources().getDisplayMetrics().density;
        controls = a.findViewById(R.id.controls);
        preview = a.findViewById(R.id.tv_preview);
        previewImg = a.findViewById(R.id.tv_preview_img);
        previewTime = a.findViewById(R.id.tv_preview_time);
        played = a.findViewById(R.id.tv_played);
        knob = a.findViewById(R.id.tv_knob);
        track = a.findViewById(R.id.tv_track);
        time = a.findViewById(R.id.time);
        playIcon = a.findViewById(R.id.play_pause);
        bigPlay = a.findViewById(R.id.tv_big_play);
        left = a.findViewById(R.id.tv_left);
        right = a.findViewById(R.id.tv_right);
        upNext = a.findViewById(R.id.tv_upnext);
        nextThumb = a.findViewById(R.id.tv_next_thumb);
        nextKind = a.findViewById(R.id.tv_next_kind);
        nextTitle = a.findViewById(R.id.tv_next_title);
        nextBtn0 = a.findViewById(R.id.tv_next_btn0);
        nextBtn1 = a.findViewById(R.id.tv_next_btn1);
        idle = a.findViewById(R.id.tv_idle);
        panel = a.findViewById(R.id.tv_panel);
        panelCols = a.findViewById(R.id.tv_panel_cols);

        // Touch: tap the picture to show / hide the controls, drag along the bar, tap the buttons.
        a.findViewById(R.id.root).setOnClickListener(v -> { if (visible()) hide(); else show(null); });
        bigPlay.setOnClickListener(v -> togglePause());
        idle.setOnClickListener(v -> { hideIdle(); show(null); });
        panel.setOnClickListener(v -> closePanel());
        panelCols.setClickable(true);
        nextBtn0.setOnClickListener(v -> { stopCountdown(); a.playNext(); });
        nextBtn1.setOnClickListener(v -> { if (stillWatching) a.finish(); else dismissUpNext(); });
        upNext.setClickable(true);
        track.setOnTouchListener((v, ev) -> {
            if (a.item == null || a.duration <= 0 || v.getWidth() == 0) return false;
            double f = Math.max(0, Math.min(1, ev.getX() / v.getWidth()));
            switch (ev.getActionMasked()) {
                case android.view.MotionEvent.ACTION_DOWN:
                case android.view.MotionEvent.ACTION_MOVE:
                    v.getParent().requestDisallowInterceptTouchEvent(true);
                    scrubTo(f * a.duration);
                    return true;
                case android.view.MotionEvent.ACTION_UP:
                    scrubTo(f * a.duration);
                    commitScrub();
                    return true;
                case android.view.MotionEvent.ACTION_CANCEL:
                    commitScrub();
                    return true;
                default:
                    return true;
            }
        });
    }

    boolean scrubbing() { return scrubbing; }

    // ---------------------------------------------------------------- a new video
    void onBegin() {
        JSONObject it = a.item;
        scrubbing = false;
        preview.setVisibility(View.INVISIBLE);
        stillWatching = false;
        stopCountdown();
        upNext.setVisibility(View.GONE);
        idle.setVisibility(View.GONE);
        panel.setVisibility(View.GONE);
        tp = null;
        tpAskedAt = 0;
        sheet = null;
        sheetIndex = sheetWanted = -1;
        askTrickplay();

        ctls.clear();
        actions.clear();
        left.removeAllViews();
        right.removeAllViews();
        boolean isEp = "episode".equals(it.optString("type"));
        if (isEp && !it.isNull("showId")) addText(left, a.getString(R.string.episodes), "episodes");
        addIcon(a.findViewById(R.id.rewind), "back10");
        ctlIndex = ctls.size();
        addIcon(playIcon, "play");
        addIcon(a.findViewById(R.id.forward), "fwd10");
        addText(right, a.getString(R.string.audio_subtitles), "tracks"); // always has Speed at least
        if (a.hasNext()) addText(right, a.getString(R.string.next_episode), "next");
        zone = "bar";
        paint();
    }

    private void addIcon(View v, String action) {
        ctls.add(v);
        actions.add(action);
        v.setOnClickListener(x -> { act(action); poke(); });
    }

    private void addText(LinearLayout row, String text, String action) {
        TextView t = new TextView(a);
        t.setText(text);
        t.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, a.getResources().getDimension(R.dimen.player_text));
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.CENTER);
        int px = (int) (18 * dp), py = (int) (8 * dp);
        t.setPadding(px, py, px, py);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        if (row.getChildCount() > 0) lp.setMarginStart((int) (12 * dp));
        row.addView(t, lp);
        ctls.add(t);
        actions.add(action);
        t.setOnClickListener(x -> { act(action); poke(); });
    }

    /** Highlights the chosen button (white pill for words, a light circle and bigger for icons). */
    private void paint() {
        for (int i = 0; i < ctls.size(); i++) {
            View v = ctls.get(i);
            boolean on = "controls".equals(zone) && i == ctlIndex;
            if (v instanceof ImageView) {
                v.setBackgroundResource(on ? R.drawable.tv_focus_circle : 0);
                v.setAlpha(on ? 1f : 0.75f);
                v.setScaleX(on ? 1.15f : 1f);
                v.setScaleY(on ? 1.15f : 1f);
            } else {
                TextView t = (TextView) v;
                t.setBackgroundResource(on ? R.drawable.tv_pill_on : 0);
                t.setTextColor(on ? 0xFF000000 : 0xFFC8C8C8);
            }
        }
        float k = "bar".equals(zone) ? 1.35f : 1f;
        knob.setScaleX(k);
        knob.setScaleY(k);
    }

    // ---------------------------------------------------------------- showing and hiding
    boolean visible() { return controls.getVisibility() == View.VISIBLE; }

    void show(String newZone) {
        hideIdle();
        if (newZone != null) zone = newZone;
        if (!visible()) {
            controls.setVisibility(View.VISIBLE);
            drawBar(a.now());
        }
        bigPlay.setVisibility(a.isPlaying() ? View.GONE : View.VISIBLE);
        paint();
        poke();
    }

    /** Keeps the controls up a little longer (they stay while paused or scrubbing). */
    void poke() {
        ui.removeCallbacks(hide);
        ui.postDelayed(hide, 5000);
    }

    void hide() {
        controls.setVisibility(View.GONE);
        zone = "bar";
    }

    private void hideIfPlaying() {
        if (scrubbing || !a.isPlaying() || panel.getVisibility() == View.VISIBLE) return;
        hide();
    }

    // ---------------------------------------------------------------- every 250 ms
    void tick(double t) {
        if (!scrubbing && visible()) drawBar(t);
    }

    void onPlayState(boolean playing) {
        playIcon.setImageResource(playing ? R.drawable.tv_pause : R.drawable.tv_play);
        if (visible()) bigPlay.setVisibility(playing ? View.GONE : View.VISIBLE);
    }

    private void drawBar(double t) {
        double d = a.duration;
        int w = track.getWidth();
        if (d <= 0 || w == 0) return;
        double f = Math.max(0, Math.min(1, t / d));
        ViewGroup.LayoutParams lp = played.getLayoutParams();
        lp.width = (int) (w * f);
        played.setLayoutParams(lp);
        knob.setTranslationX((float) (w * f - knob.getWidth() / 2.0));
        time.setText(PlaybackPlan.clock(Math.max(0, d - t)));
    }

    // ---------------------------------------------------------------- play, pause, jump
    private void togglePause() {
        a.togglePlay();
        if (a.isPlaying()) ui.removeCallbacks(idleRun);
        else { ui.removeCallbacks(idleRun); ui.postDelayed(idleRun, 12000); }
        show(null);
    }

    /** Keeps a time inside the video (before its length is known, just above 0). */
    private double clamp(double t) {
        return a.duration > 2 ? Math.max(0, Math.min(a.duration - 2, t)) : Math.max(0, t);
    }

    private void jump(double by) {
        double t = clamp(a.now() + by);
        a.seekTo(t);
        drawBar(t);
        show(null);
    }

    private void act(String action) {
        switch (action) {
            case "play": togglePause(); break;
            case "back10": jump(-10); break;
            case "fwd10": jump(10); break;
            case "tracks": openPanel(); break;
            case "next": a.playNext(); break;
            case "episodes": a.openEpisodes(); break;
            default: break;
        }
    }

    // ---------------------------------------------------------------- scrubbing
    private void scrub(int dir, boolean fast, int repeat) {
        long now = System.currentTimeMillis();
        if (repeat > 0 && now - lastStep < 200) return; // a held key repeats quickly: step at most 5× a second
        lastStep = now;
        if (!scrubbing) {
            scrubbing = true;
            scrubPos = a.now();
            wasPaused = !a.isPlaying();
        }
        ui.removeCallbacks(commit);
        ui.removeCallbacks(hide);
        show("bar");
        ui.removeCallbacks(hide);
        int steps = repeat / 3; // roughly how long it has been held
        double size = steps < 3 ? 10 : steps < 10 ? 30 : 60;
        if (fast) size *= 3;
        scrubPos = clamp(scrubPos + dir * size);
        drawBar(scrubPos);
        showPreview(scrubPos);
    }

    /** Dragging along the bar (touch). */
    private void scrubTo(double t) {
        if (!scrubbing) {
            scrubbing = true;
            wasPaused = !a.isPlaying();
        }
        ui.removeCallbacks(commit);
        show("bar");
        ui.removeCallbacks(hide);
        scrubPos = clamp(t);
        drawBar(scrubPos);
        showPreview(scrubPos);
    }

    private void commitScrub() {
        if (!scrubbing) return;
        ui.removeCallbacks(commit);
        scrubbing = false;
        preview.setVisibility(View.INVISIBLE);
        a.seekTo(scrubPos);
        if (wasPaused && a.isPlaying()) a.togglePlay();
        poke();
    }

    /** The picture at that time from the server's preview sheets (10×10 pictures, one every 10 s). */
    private void showPreview(double t) {
        previewTime.setText(PlaybackPlan.clock(t));
        JSONObject info = tp;
        if (info == null) askTrickplay();
        if (info != null) {
            int interval = Math.max(1, info.optInt("interval", 10));
            int cols = info.optInt("cols", 10), rows = info.optInt("rows", 10);
            int n = Math.min(Math.max(0, (int) (t / interval)), info.optInt("count", 1) - 1);
            int per = cols * rows;
            int s = n / per, idx = n % per;
            int w = info.optInt("width", 240), h = info.optInt("height", 135);
            if (s == sheetIndex && sheet != null) {
                int x = (idx % cols) * w, y = (idx / cols) * h;
                if (x + w <= sheet.getWidth() && y + h <= sheet.getHeight()) previewImg.setImageBitmap(Bitmap.createBitmap(sheet, x, y, w, h));
            } else {
                loadSheet(s, t);
            }
            previewImg.setVisibility(View.VISIBLE);
        } else {
            previewImg.setVisibility(View.GONE);
        }
        preview.setVisibility(View.VISIBLE);
        // Above the knob, kept on screen.
        preview.post(() -> {
            View box = (View) preview.getParent();
            double d = a.duration;
            float f = d > 0 ? (float) (scrubPos / d) : 0;
            float x = track.getWidth() * f - preview.getWidth() / 2f;
            preview.setTranslationX(Math.max(0, Math.min(box.getWidth() - preview.getWidth(), x)));
        });
    }

    private void askTrickplay() {
        long now = System.currentTimeMillis();
        if (now - tpAskedAt < 30000) return; // made on the server the first time a video is opened
        tpAskedAt = now;
        final String url = a.base + "/api/items/" + a.item.optString("id") + "/trickplay";
        a.io.execute(() -> {
            try {
                JSONObject j = Net.getJson(url);
                if (j.optBoolean("ready")) a.runOnUiThread(() -> tp = j);
            } catch (Exception ignored) { }
        });
    }

    private void loadSheet(int s, double t) {
        if (sheetWanted == s) return;
        sheetWanted = s;
        final String url = a.base + "/api/items/" + a.item.optString("id") + "/trickplay/" + s + ".jpg";
        a.io.execute(() -> {
            try {
                byte[] b = Net.getBytes(url);
                Bitmap bm = BitmapFactory.decodeByteArray(b, 0, b.length);
                a.runOnUiThread(() -> {
                    if (sheetWanted != s || bm == null) return;
                    sheet = bm;
                    sheetIndex = s;
                    if (scrubbing) showPreview(scrubPos);
                });
            } catch (Exception ignored) { }
        });
    }

    // ---------------------------------------------------------------- Up Next
    /** At the credits (or the end): the next episode, after a 10-second countdown when autoplay is on. */
    void showUpNext(JSONObject n, boolean ask) {
        if (n == null) return;
        stillWatching = ask;
        nextKind.setText(ask ? a.getString(R.string.still_watching)
            : (a.getString(R.string.next_episode).toUpperCase(Locale.ROOT) + "  ·  S" + n.optInt("season") + ":E" + n.optInt("episode")));
        nextTitle.setText(n.optString("title"));
        nextThumb.setImageDrawable(null);
        final String url = a.base + "/api/art/thumb/" + n.optString("id") + "?v=" + n.optString("artV", "");
        a.io.execute(() -> {
            try {
                byte[] b = Net.getBytes(url);
                Bitmap bm = BitmapFactory.decodeByteArray(b, 0, b.length);
                if (bm != null) a.runOnUiThread(() -> nextThumb.setImageBitmap(bm));
            } catch (Exception ignored) { }
        });
        upNextIndex = 0;
        count = 10;
        hide();
        ui.removeCallbacks(fadeRun);
        upNext.animate().cancel();
        upNext.setAlpha(1f);
        upNext.setVisibility(View.VISIBLE);
        stopCountdown();
        countingDown = !ask && a.autoplayNext;
        if (countingDown) ui.postDelayed(countRun, 1000);
        // Without a countdown, the card fades like the skip buttons (Next Episode is also under the bar).
        else if (!ask && a.skipFade > 0) ui.postDelayed(fadeRun, a.skipFade * 1000L);
        paintUpNext();
    }

    private void paintUpNext() {
        String first = stillWatching ? a.getString(R.string.continue_watching)
            : countingDown ? a.getString(R.string.next_episode_in, count) : a.getString(R.string.next_episode);
        String second = stillWatching ? a.getString(R.string.back_to_browsing) : a.getString(R.string.watch_credits_btn);
        nextBtn0.setText(first);
        nextBtn1.setText(second);
        TextView[] b = {nextBtn0, nextBtn1};
        for (int i = 0; i < 2; i++) {
            boolean on = i == upNextIndex;
            b[i].setBackgroundResource(on ? R.drawable.tv_pill_on : R.drawable.tv_pill_off);
            b[i].setTextColor(on ? 0xFF000000 : 0xFFFFFFFF);
        }
    }

    private void countdownTick() {
        if (!countingDown) return;
        count--;
        if (count <= 0) { stopCountdown(); autoNext(); return; }
        paintUpNext();
        ui.postDelayed(countRun, 1000);
    }

    private void stopCountdown() {
        countingDown = false;
        ui.removeCallbacks(countRun);
    }

    /** The next episode starting by itself: after three in a row, ask whether anyone's still watching. */
    private void autoNext() {
        if (autoNexts >= 3) { showUpNext(a.item.optJSONObject("next"), true); return; }
        autoNexts++;
        a.playNext();
    }

    private void fadeUpNext() {
        if (upNext.getVisibility() != View.VISIBLE || countingDown || stillWatching) return;
        upNext.animate().alpha(0f).setDuration(600).withEndAction(() -> { dismissUpNext(); upNext.setAlpha(1f); }).start();
    }

    private void dismissUpNext() {
        ui.removeCallbacks(fadeRun);
        stopCountdown();
        upNext.setVisibility(View.GONE);
    }

    /** The end of the video. */
    void onEnded() {
        JSONObject n = a.item.optJSONObject("next");
        if (n == null || !a.hasNext() || !a.autoplayNext) { a.finish(); return; }
        if (upNext.getVisibility() == View.VISIBLE && stillWatching) return;
        stopCountdown();
        upNext.setVisibility(View.GONE);
        autoNext();
    }

    // ---------------------------------------------------------------- paused for a while
    private void showIdle() {
        if (a.isPlaying() || panel.getVisibility() == View.VISIBLE || upNext.getVisibility() == View.VISIBLE) return;
        JSONObject it = a.item;
        boolean isEp = "episode".equals(it.optString("type"));
        ((TextView) a.findViewById(R.id.tv_idle_title)).setText(isEp ? it.optString("showTitle") : it.optString("title"));
        ((TextView) a.findViewById(R.id.tv_idle_sub)).setText(isEp ? "S" + it.optInt("season") + ":E" + it.optInt("episode") + "  " + it.optString("title") : "");
        ((TextView) a.findViewById(R.id.tv_idle_overview)).setText(it.optString("overview"));
        // Who's in it.
        JSONArray cast = it.optJSONArray("cast");
        StringBuilder who = new StringBuilder();
        for (int i = 0; cast != null && i < Math.min(6, cast.length()); i++) {
            JSONObject c = cast.optJSONObject(i);
            if (who.length() > 0) who.append("  ·  ");
            who.append(c.optString("name"));
            if (!c.isNull("character") && !c.optString("character").isEmpty()) who.append(" (").append(c.optString("character")).append(')');
        }
        ((TextView) a.findViewById(R.id.tv_idle_cast)).setText(who.length() > 0 ? a.getString(R.string.with_cast, who) : "");
        hide();
        idle.setVisibility(View.VISIBLE);
    }

    private void hideIdle() { idle.setVisibility(View.GONE); }

    // ---------------------------------------------------------------- Audio & Subtitles
    private void openPanel() {
        panelCols.removeAllViews();
        cols.clear();
        picks.clear();
        chosen.clear();
        JSONObject it = a.item;
        JSONArray audio = it.optJSONArray("audioTracks");
        if (audio != null && audio.length() > 1) {
            List<String> labels = new ArrayList<>();
            for (int i = 0; i < audio.length(); i++) labels.add(audio.optJSONObject(i).optString("label"));
            addColumn(a.getString(R.string.audio), labels, a.audioIndex, a::selectAudio);
        }
        JSONArray subs = it.optJSONArray("subtitles");
        if (subs != null && subs.length() > 0) {
            List<String> labels = new ArrayList<>();
            labels.add(a.getString(R.string.off));
            int on = 0;
            for (int i = 0; i < subs.length(); i++) {
                labels.add(subs.optJSONObject(i).optString("label"));
                if (subs.optJSONObject(i).optString("id").equals(a.subId)) on = i + 1;
            }
            addColumn(a.getString(R.string.subtitles), labels, on, i -> a.chooseSubtitle(i == 0 ? null : subs.optJSONObject(i - 1).optString("id")));
        }
        List<String> qIds = a.qualityIds();
        if (qIds.size() > 1) addColumn(a.getString(R.string.quality), a.qualityLabels(), Math.max(0, qIds.indexOf(a.quality)), i -> a.applyQuality(qIds.get(i)));
        List<String> speeds = new ArrayList<>();
        int speedAt = 2;
        for (int i = 0; i < PlayerActivity.SPEEDS.length; i++) {
            float sp = PlayerActivity.SPEEDS[i];
            speeds.add(sp == 1f ? a.getString(R.string.normal) : (sp + "×").replace(".0×", "×"));
            if (sp == a.speed) speedAt = i;
        }
        addColumn(a.getString(R.string.speed), speeds, speedAt, i -> a.setSpeed(PlayerActivity.SPEEDS[i]));
        if (Build.VERSION.SDK_INT >= 28) {
            List<String> sound = new ArrayList<>();
            sound.add(a.getString(R.string.normal));
            sound.add(a.getString(R.string.night_mode));
            addColumn(a.getString(R.string.sound), sound, a.nightMode ? 1 : 0, i -> a.setNight(i == 1));
        }
        if (cols.isEmpty()) return;
        panelCol = cols.size() > 1 && subs != null && subs.length() > 0 && audio != null && audio.length() > 1 ? 1 : 0;
        panelRow = chosen.get(panelCol);
        hide();
        panel.setVisibility(View.VISIBLE);
        paintPanel();
    }

    private void addColumn(String heading, List<String> labels, int selected, Pick pick) {
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams((int) ((tv ? 250 : 190) * dp), ViewGroup.LayoutParams.MATCH_PARENT);
        if (!cols.isEmpty()) clp.setMarginStart((int) (20 * dp));
        TextView h = new TextView(a);
        h.setText(heading);
        h.setTextSize(20);
        h.setTypeface(Typeface.DEFAULT_BOLD);
        h.setTextColor(0xFFFFFFFF);
        h.setPadding(0, 0, 0, (int) (14 * dp));
        col.addView(h);
        List<TextView> rows = new ArrayList<>();
        final int colIndex = cols.size();
        for (String l : labels) {
            TextView t = new TextView(a);
            final int row = rows.size();
            t.setOnClickListener(x -> pickRow(colIndex, row));
            t.setText(l);
            t.setTextSize(16);
            t.setSingleLine(true);
            t.setEllipsize(android.text.TextUtils.TruncateAt.END);
            int p = (int) (12 * dp);
            t.setPadding(p, (int) (9 * dp), p, (int) (9 * dp));
            col.addView(t);
            rows.add(t);
        }
        panelCols.addView(col, clp);
        cols.add(rows);
        picks.add(pick);
        chosen.add(Math.max(0, Math.min(selected, labels.size() - 1)));
    }

    private void paintPanel() {
        for (int c = 0; c < cols.size(); c++) {
            List<TextView> rows = cols.get(c);
            for (int r = 0; r < rows.size(); r++) {
                TextView t = rows.get(r);
                boolean focus = c == panelCol && r == panelRow;
                boolean picked = r == chosen.get(c);
                String label = t.getText().toString().replaceFirst("^✓ {2}", "");
                t.setText(picked ? "✓  " + label : label);
                t.setBackgroundResource(focus ? R.drawable.tv_pill_on : 0);
                t.setTextColor(focus ? 0xFF000000 : picked ? 0xFFFFFFFF : 0xFFB0B0B0);
                t.setTypeface(picked || focus ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            }
        }
    }

    /** A tapped (or OK'd) choice in the panel. */
    private void pickRow(int c, int r) {
        panelCol = c;
        panelRow = r;
        if (chosen.get(c) != r) {
            chosen.set(c, r);
            picks.get(c).pick(r);
        }
        paintPanel();
    }

    private void closePanel() {
        panel.setVisibility(View.GONE);
        show("controls");
    }

    private boolean panelKey(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP: if (panelRow > 0) panelRow--; break;
            case KeyEvent.KEYCODE_DPAD_DOWN: if (panelRow < cols.get(panelCol).size() - 1) panelRow++; break;
            case KeyEvent.KEYCODE_DPAD_LEFT:
                if (panelCol > 0) { panelCol--; panelRow = Math.min(chosen.get(panelCol), cols.get(panelCol).size() - 1); }
                break;
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                if (panelCol < cols.size() - 1) { panelCol++; panelRow = Math.min(chosen.get(panelCol), cols.get(panelCol).size() - 1); }
                break;
            case KeyEvent.KEYCODE_DPAD_CENTER: case KeyEvent.KEYCODE_ENTER:
                pickRow(panelCol, panelRow);
                return true;
            default: return false;
        }
        paintPanel();
        return true;
    }

    // ---------------------------------------------------------------- keys
    private static boolean isOk(int code) { return code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER; }

    private static boolean isScrubKey(int code) {
        return code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT
            || code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD || code == KeyEvent.KEYCODE_MEDIA_REWIND;
    }

    /** Returns true when the key was used. Back is left to the activity (it leaves) unless a panel is open. */
    boolean onKey(KeyEvent e) {
        int code = e.getKeyCode();
        if (e.getAction() == KeyEvent.ACTION_UP) {
            if (scrubbing && isScrubKey(code)) {
                // Released: jump there after a moment (another press keeps scrubbing).
                ui.removeCallbacks(commit);
                ui.postDelayed(commit, 900);
                return true;
            }
            return isOk(code) || isScrubKey(code) || code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN;
        }
        if (e.getAction() != KeyEvent.ACTION_DOWN) return false;
        autoNexts = 0;
        int repeat = e.getRepeatCount();

        if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_ESCAPE) {
            if (panel.getVisibility() == View.VISIBLE) { closePanel(); return true; }
            return false;
        }
        if (a.item == null) return false;
        if (panel.getVisibility() == View.VISIBLE) return panelKey(code);

        if (idle.getVisibility() == View.VISIBLE) {
            hideIdle();
            if (isOk(code) || code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_MEDIA_PLAY) togglePause();
            else show(null);
            return true;
        }

        if (upNext.getVisibility() == View.VISIBLE) {
            switch (code) {
                case KeyEvent.KEYCODE_DPAD_UP: case KeyEvent.KEYCODE_DPAD_DOWN:
                case KeyEvent.KEYCODE_DPAD_LEFT: case KeyEvent.KEYCODE_DPAD_RIGHT:
                    upNextIndex = 1 - upNextIndex;
                    paintUpNext();
                    return true;
                default:
                    if (isOk(code)) {
                        if (upNextIndex == 0) { stopCountdown(); a.playNext(); }
                        else if (stillWatching) a.finish();
                        else dismissUpNext();
                        return true;
                    }
            }
        }

        switch (code) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: case KeyEvent.KEYCODE_SPACE: togglePause(); return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY: if (!a.isPlaying()) togglePause(); else show(null); return true;
            case KeyEvent.KEYCODE_MEDIA_PAUSE: if (a.isPlaying()) togglePause(); else show(null); return true;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: scrub(1, true, repeat); return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND: scrub(-1, true, repeat); return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT: if (a.hasNext()) a.playNext(); return true;
            default: break;
        }

        if (!visible()) {
            if ((isOk(code) || code == KeyEvent.KEYCODE_DPAD_UP) && a.skipShowing()) a.skipNow();
            else if (isOk(code)) togglePause();
            else if (code == KeyEvent.KEYCODE_DPAD_LEFT) scrub(-1, false, repeat);
            else if (code == KeyEvent.KEYCODE_DPAD_RIGHT) scrub(1, false, repeat);
            else if (code == KeyEvent.KEYCODE_DPAD_DOWN) show("controls");
            else if (code == KeyEvent.KEYCODE_DPAD_UP) show("bar");
            else return false;
            return true;
        }

        if ("bar".equals(zone)) {
            if (code == KeyEvent.KEYCODE_DPAD_LEFT) scrub(-1, false, repeat);
            else if (code == KeyEvent.KEYCODE_DPAD_RIGHT) scrub(1, false, repeat);
            else if (isOk(code)) { if (scrubbing) commitScrub(); else togglePause(); }
            else if (code == KeyEvent.KEYCODE_DPAD_DOWN) { if (scrubbing) commitScrub(); show("controls"); }
            else if (code == KeyEvent.KEYCODE_DPAD_UP) { if (a.skipShowing()) a.skipNow(); else hide(); }
            else return false;
            return true;
        }

        // The buttons under the bar.
        if (code == KeyEvent.KEYCODE_DPAD_LEFT) { if (ctlIndex > 0) ctlIndex--; show(null); }
        else if (code == KeyEvent.KEYCODE_DPAD_RIGHT) { if (ctlIndex < ctls.size() - 1) ctlIndex++; show(null); }
        else if (code == KeyEvent.KEYCODE_DPAD_UP) show("bar");
        else if (code == KeyEvent.KEYCODE_DPAD_DOWN) show(null);
        else if (isOk(code)) { act(actions.get(ctlIndex)); poke(); }
        else return false;
        return true;
    }

    void release() { ui.removeCallbacksAndMessages(null); }
}
