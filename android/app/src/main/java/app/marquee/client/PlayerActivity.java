package app.marquee.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PictureInPictureParams;
import android.content.res.Configuration;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Rational;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.ProgressBar;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.VideoView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native video player. Plays files directly when the phone can decode them, otherwise asks the
 * server to convert them on the fly (same /transcode endpoint the web player uses). A lower quality
 * can be chosen, which plays the server's adaptive (HLS) stream through Android's own player.
 */
public class PlayerActivity extends Activity {
    static final String EXTRA_REQUEST = "request";
    private static final float[] SPEEDS = {0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f};

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private VideoView video;
    private View controls;
    private ProgressBar spinner;
    private SeekBar seek;
    private TextView title, subtitle, time, subs;
    private ImageButton playPause, next, audioBtn, qualityBtn;
    private Button skipIntro;

    private String base;
    private JSONObject item;
    private boolean direct;
    private boolean directCapable;  // the phone can play the original file
    private int burn = -1;          // picture subtitle track the server draws into the video, or -1
    private boolean hls;           // playing the adaptive stream (quality other than "original")
    private String quality = "original";
    private String qualityPref;
    private JSONObject playback;   // signed link + streaming session from /playback
    private JSONObject intro;
    private boolean autoSkipIntro, autoSkipped;
    private double offset;       // seconds: where a converted stream starts in the real timeline
    private double pendingSeek;  // seconds: seek to this once a direct stream is ready
    private double duration;
    private int audioIndex;
    private String subId;
    private List<Vtt.Cue> cues = new ArrayList<>();
    private MediaPlayer mp;
    private float speed = 1f;
    private boolean dragging, autoplayNext = true, subsOn;
    private long lastReport;
    private AlertDialog upNext;
    private boolean pipUsed;

    // (Lambdas and static classes only: build-tools 34's dex tool crashes on anonymous classes from Java 21.)
    private final Runnable tick = this::tickLoop;
    private final Runnable hideControls = () -> { if (video.isPlaying()) setControls(false); };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_player);
        immersive();
        base = Prefs.server(this);
        Net.refreshCookie(base);
        video = findViewById(R.id.video);
        controls = findViewById(R.id.controls);
        spinner = findViewById(R.id.spinner);
        seek = findViewById(R.id.seek);
        title = findViewById(R.id.title);
        subtitle = findViewById(R.id.subtitle);
        time = findViewById(R.id.time);
        subs = findViewById(R.id.subs);
        playPause = findViewById(R.id.play_pause);
        next = findViewById(R.id.next);
        audioBtn = findViewById(R.id.audio);
        qualityBtn = findViewById(R.id.quality);
        skipIntro = findViewById(R.id.skip_intro);
        qualityBtn.setOnClickListener(v -> chooseQuality());
        skipIntro.setOnClickListener(v -> { if (intro != null) seekTo(intro.optDouble("end")); skipIntro.setVisibility(View.GONE); });

        findViewById(R.id.back).setOnClickListener(v -> finish());
        findViewById(R.id.root).setOnClickListener(v -> setControls(controls.getVisibility() != View.VISIBLE));
        playPause.setOnClickListener(v -> { togglePlay(); poke(); });
        findViewById(R.id.rewind).setOnClickListener(v -> { seekTo(now() - 10); poke(); });
        findViewById(R.id.forward).setOnClickListener(v -> { seekTo(now() + 30); poke(); });
        findViewById(R.id.subs_btn).setOnClickListener(v -> chooseSubtitles());
        findViewById(R.id.speed).setOnClickListener(v -> chooseSpeed());
        audioBtn.setOnClickListener(v -> chooseAudio());
        next.setOnClickListener(v -> playNext());
        findViewById(R.id.pip).setOnClickListener(v -> enterPip());
        if (Build.VERSION.SDK_INT < 26 || !getPackageManager().hasSystemFeature("android.software.picture_in_picture")) findViewById(R.id.pip).setVisibility(View.GONE);

        seek.setOnSeekBarChangeListener(new SeekListener(this));

        video.setOnPreparedListener(this::onPrepared);
        video.setOnCompletionListener(m -> onEnded());
        video.setOnErrorListener((m, what, extra) -> onPlaybackError());
        video.setOnInfoListener((m, what, extra) -> {
            if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START) spinner.setVisibility(View.VISIBLE);
            else if (what == MediaPlayer.MEDIA_INFO_BUFFERING_END || what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) spinner.setVisibility(View.GONE);
            return false;
        });

        try {
            JSONObject req = new JSONObject(getIntent().getStringExtra(EXTRA_REQUEST));
            autoplayNext = req.optBoolean("autoplayNext", true);
            subsOn = req.optBoolean("subsOn", false);
            autoSkipIntro = req.optBoolean("autoSkipIntro", false);
            qualityPref = req.optString("quality", "");
            load(req.getString("id"), req.optDouble("start", 0));
        } catch (Exception e) {
            finish();
        }
    }

    private void tickLoop() {
        update();
        ui.postDelayed(tick, 250);
    }

    static final class SeekListener implements SeekBar.OnSeekBarChangeListener {
        private final PlayerActivity a;
        SeekListener(PlayerActivity a) { this.a = a; }
        @Override public void onProgressChanged(SeekBar s, int p, boolean user) { if (user) a.time.setText(a.label(p)); }
        @Override public void onStartTrackingTouch(SeekBar s) { a.dragging = true; a.ui.removeCallbacks(a.hideControls); }
        @Override public void onStopTrackingTouch(SeekBar s) { a.dragging = false; a.seekTo(s.getProgress()); a.poke(); }
    }

    // ---------------------------------------------------------------- loading
    private void load(String id, double start) {
        spinner.setVisibility(View.VISIBLE);
        io.execute(() -> {
            try {
                JSONObject it = Net.getJson(base + "/api/items/" + id);
                JSONObject pb = null;
                try { pb = Net.getJson(base + "/api/items/" + id + "/playback"); } catch (Exception ignored) { } // older servers
                final JSONObject p = pb;
                runOnUiThread(() -> begin(it, p, start));
            } catch (Exception e) {
                runOnUiThread(() -> fail(e.getMessage()));
            }
        });
    }

    private void begin(JSONObject it, JSONObject pb, double start) {
        item = it;
        playback = pb;
        intro = it.optJSONObject("intro");
        autoSkipped = false;
        skipIntro.setVisibility(View.GONE);
        duration = it.optDouble("duration", 0);
        seek.setMax((int) Math.max(1, duration));
        boolean isEp = "episode".equals(it.optString("type"));
        title.setText(it.optString("title"));
        String sub = isEp ? it.optString("showTitle") + epLabel(it) : (it.optInt("year", 0) > 0 ? String.valueOf(it.optInt("year")) : "");
        subtitle.setText(sub);
        next.setVisibility(it.optJSONObject("next") != null ? View.VISIBLE : View.GONE);
        audioBtn.setVisibility(it.optJSONArray("audioTracks") != null && it.optJSONArray("audioTracks").length() > 1 ? View.VISIBLE : View.GONE);
        audioIndex = 0;

        JSONObject media = it.optJSONObject("media");
        JSONObject v = media != null ? media.optJSONObject("video") : null;
        JSONArray audio = media != null ? media.optJSONArray("audio") : null;
        String aCodec = audio != null && audio.length() > 0 ? audio.optJSONObject(0).optString("codec", null) : null;
        burn = -1;
        directCapable = media != null && PlaybackPlan.canDirectPlay(it.optString("fileName"),
            v != null ? v.optString("codec", null) : null, v != null ? v.optString("profile", null) : null, aCodec, decoders());
        direct = directCapable;
        JSONArray qs = qualities();
        qualityBtn.setVisibility(qs.length() > 0 ? View.VISIBLE : View.GONE);
        quality = qs.length() > 0 ? PlaybackPlan.defaultQuality(qualityPref, Uri.parse(base).getHost()) : "original";
        // Away from home the server's admin may have capped the quality: the original isn't offered then.
        if ("original".equals(quality) && qs.length() > 0 && !originalAllowed()) quality = "auto";
        if (!"original".equals(quality) && !"auto".equals(quality) && !hasQuality(qs, quality)) quality = qs.optJSONObject(0).optString("id");
        hls = !"original".equals(quality);

        subId = null;
        cues = new ArrayList<>();
        subs.setText("");
        JSONArray list = it.optJSONArray("subtitles");
        if (subsOn && list != null && list.length() > 0) {
            // Text subtitles first: picture ones (Blu-ray / DVD) need the video converted.
            String lang = Locale.getDefault().getLanguage();
            JSONObject pick = null;
            for (int pass = 0; pass < 2 && pick == null; pass++) {
                for (int i = 0; i < list.length() && pick == null; i++) {
                    JSONObject candidate = list.optJSONObject(i);
                    String l = candidate.optString("lang", "");
                    if (candidate.has("burn") == (pass == 1) && !l.isEmpty() && l.toLowerCase(Locale.ROOT).startsWith(lang)) pick = candidate;
                }
            }
            if (pick == null) pick = list.optJSONObject(0);
            setSubtitles(pick.optString("id"), false);
        }
        open(start);
        ui.removeCallbacks(tick);
        ui.post(tick);
        setControls(true);
    }

    private JSONArray qualities() {
        JSONArray qs = playback != null ? playback.optJSONArray("qualities") : null;
        return qs != null ? qs : new JSONArray();
    }

    private boolean originalAllowed() { return playback == null || playback.optBoolean("originalAllowed", true); }

    private static boolean hasQuality(JSONArray qs, String id) {
        for (int i = 0; i < qs.length(); i++) if (id.equals(qs.optJSONObject(i).optString("id"))) return true;
        return false;
    }

    /** Positions in direct and adaptive streams are the file's own; a converted stream restarts instead. */
    private boolean seekable() { return direct || hls; }

    private static String epLabel(JSONObject it) {
        if (it.isNull("season") && it.isNull("episode")) return "";
        return " · S" + it.optInt("season") + " · E" + it.optInt("episode");
    }

    /** Decoders this phone has, as MIME types. */
    private static Set<String> decoders() {
        Set<String> out = new HashSet<>();
        for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
            if (info.isEncoder()) continue;
            for (String t : info.getSupportedTypes()) out.add(t.toLowerCase(Locale.ROOT));
        }
        return out;
    }

    private void open(double t) {
        t = Math.max(0, duration > 0 ? Math.min(t, duration - 2) : t);
        spinner.setVisibility(View.VISIBLE);
        String id = item.optString("id");
        if (hls) {
            offset = 0;
            pendingSeek = t;
            String url = base + PlaybackPlan.hlsPath(id, playback.optString("sid"), audioIndex, quality, playback.optString("token")) + burnQuery();
            video.setVideoURI(Uri.parse(url), Net.headers(url));
        } else if (direct) {
            offset = 0;
            pendingSeek = t;
            String url = base + "/api/items/" + id + "/stream";
            video.setVideoURI(Uri.parse(url), Net.headers(url));
        } else {
            final double want = t;
            io.execute(() -> {
                double start = want;
                try { start = Net.getJson(base + "/api/items/" + id + "/seekpoint?t=" + fmt(want) + burnQuery()).optDouble("start", want); } catch (Exception ignored) { }
                final double s = start;
                runOnUiThread(() -> {
                    offset = s;
                    pendingSeek = 0;
                    String url = base + "/api/items/" + id + "/transcode?start=" + fmt(want) + "&audio=" + audioIndex + burnQuery();
                    video.setVideoURI(Uri.parse(url), Net.headers(url));
                });
            });
        }
    }

    private String burnQuery() { return burn >= 0 ? "&burn=" + burn : ""; }

    private static String fmt(double d) { return String.format(Locale.ROOT, "%.3f", d); }

    private void onPrepared(MediaPlayer m) {
        mp = m;
        applySpeed();
        if (seekable() && pendingSeek > 0) video.seekTo((int) (pendingSeek * 1000));
        if (direct && !hls && audioIndex > 0) selectDirectAudio(audioIndex);
        video.start();
        spinner.setVisibility(View.GONE);
        updatePlayIcon();
        poke();
    }

    private boolean onPlaybackError() {
        if (hls && item != null && originalAllowed()) {
            Toast.makeText(this, R.string.adaptive_failed, Toast.LENGTH_SHORT).show();
            double at = now();
            hls = false;
            quality = "original";
            open(at);
            return true;
        }
        if (direct && item != null) {
            // The phone couldn't play the original file: let the server convert it.
            Toast.makeText(this, R.string.switching_to_convert, Toast.LENGTH_SHORT).show();
            double at = now();
            direct = directCapable = false;
            open(at);
            return true;
        }
        fail(getString(R.string.playback_error));
        return true;
    }

    private void fail(String message) {
        spinner.setVisibility(View.GONE);
        if (isFinishing()) return;
        new AlertDialog.Builder(this).setTitle(R.string.cant_play).setMessage(message)
            .setPositiveButton(android.R.string.ok, (d, w) -> finish()).setOnCancelListener(d -> finish()).show();
    }

    // ---------------------------------------------------------------- playback
    private double now() { return offset + video.getCurrentPosition() / 1000.0; }

    private void seekTo(double t) {
        if (item == null) return;
        t = Math.max(0, duration > 0 ? Math.min(t, duration - 1) : t);
        if (seekable()) video.seekTo((int) (t * 1000));
        else open(t); // a converted stream can only start over from a new position
    }

    private void togglePlay() {
        if (video.isPlaying()) { video.pause(); report(); } else video.start();
        updatePlayIcon();
    }

    private void updatePlayIcon() {
        playPause.setImageResource(video.isPlaying() ? R.drawable.ic_pause : R.drawable.ic_play);
    }

    private void update() {
        if (item == null) return;
        double t = now();
        if (!dragging) {
            seek.setProgress((int) t);
            time.setText(label(t));
        }
        int buffered = video.getBufferPercentage();
        if (seekable() && duration > 0) seek.setSecondaryProgress((int) (duration * buffered / 100));
        subs.setText(cues.isEmpty() ? "" : Vtt.textAt(cues, (long) (t * 1000)));
        updateIntro(t);
        updatePlayIcon();
        if (video.isPlaying() && System.currentTimeMillis() - lastReport > 10000) report();
    }

    // "Skip Intro" while the theme song plays, or skip it automatically once if the user asked for that.
    private void updateIntro(double t) {
        boolean in = intro != null && PlaybackPlan.inIntro(t, intro.optDouble("start", 0), intro.optDouble("end", 0));
        if (in && autoSkipIntro && !autoSkipped && video.isPlaying()) {
            autoSkipped = true;
            seekTo(intro.optDouble("end"));
            Toast.makeText(this, R.string.intro_skipped, Toast.LENGTH_SHORT).show();
            in = false;
        }
        skipIntro.setVisibility(in ? View.VISIBLE : View.GONE);
    }

    private String label(double t) { return PlaybackPlan.clock(t) + " / " + PlaybackPlan.clock(duration); }

    private void report() {
        if (item == null) return;
        lastReport = System.currentTimeMillis();
        final String url = base + "/api/items/" + item.optString("id") + "/progress";
        final double pos = now();
        io.execute(() -> {
            try { Net.postJson(url, new JSONObject().put("position", pos)); } catch (Exception ignored) { }
        });
    }

    private void onEnded() {
        if (item == null) return;
        final String url = base + "/api/items/" + item.optString("id") + "/progress";
        io.execute(() -> {
            try { Net.postJson(url, new JSONObject().put("position", duration)); } catch (Exception ignored) { }
        });
        JSONObject n = item.optJSONObject("next");
        if (n == null) { finish(); return; }
        if (!autoplayNext) { showUpNext(n, -1); return; }
        showUpNext(n, 10);
    }

    private void showUpNext(JSONObject n, int seconds) {
        String name = "S" + n.optInt("season") + " · E" + n.optInt("episode") + " — " + n.optString("title");
        upNext = new AlertDialog.Builder(this).setTitle(R.string.up_next).setMessage(name)
            .setPositiveButton(R.string.play_now, (d, w) -> playNext())
            .setNegativeButton(R.string.close, (d, w) -> finish())
            .setOnCancelListener(d -> finish()).show();
        if (seconds > 0) countdown(seconds);
    }

    private void countdown(int left) {
        if (upNext == null || !upNext.isShowing()) return;
        upNext.setTitle(getString(R.string.up_next_in, left));
        if (left <= 0) { upNext.dismiss(); playNext(); return; }
        ui.postDelayed(() -> countdown(left - 1), 1000);
    }

    private void playNext() {
        if (upNext != null) upNext.dismiss();
        JSONObject n = item != null ? item.optJSONObject("next") : null;
        if (n == null) return;
        report();
        video.stopPlayback();
        load(n.optString("id"), 0);
    }

    // ---------------------------------------------------------------- choices
    private void chooseSubtitles() {
        JSONArray list = item != null ? item.optJSONArray("subtitles") : null;
        if (list == null || list.length() == 0) { Toast.makeText(this, R.string.no_subtitles, Toast.LENGTH_SHORT).show(); return; }
        String[] labels = new String[list.length() + 1];
        labels[0] = getString(R.string.off);
        int checked = 0;
        for (int i = 0; i < list.length(); i++) {
            labels[i + 1] = list.optJSONObject(i).optString("label");
            if (list.optJSONObject(i).optString("id").equals(subId)) checked = i + 1;
        }
        new AlertDialog.Builder(this).setTitle(R.string.subtitles).setSingleChoiceItems(labels, checked, (d, which) -> {
            d.dismiss();
            setSubtitles(which == 0 ? null : list.optJSONObject(which - 1).optString("id"), true);
        }).show();
    }

    private void setSubtitles(String id, boolean reopen) {
        subId = id;
        cues = new ArrayList<>();
        subs.setText("");
        // Picture subtitles are drawn into the video by the server, so switching them changes the stream.
        int newBurn = -1;
        JSONArray list = item.optJSONArray("subtitles");
        for (int i = 0; id != null && list != null && i < list.length(); i++) {
            JSONObject sub = list.optJSONObject(i);
            if (id.equals(sub.optString("id")) && sub.has("burn")) newBurn = sub.optInt("burn");
        }
        if (newBurn != burn) {
            burn = newBurn;
            direct = directCapable && burn < 0;
            if (reopen) open(now());
        }
        if (id == null || burn >= 0) return;
        // Cues are fetched in the file's own timeline, so they line up in both direct and converted mode.
        final String url = base + "/api/items/" + item.optString("id") + "/subtitles/" + id;
        io.execute(() -> {
            try {
                List<Vtt.Cue> c = Vtt.parse(Net.getText(url));
                runOnUiThread(() -> { if (id.equals(subId)) cues = c; });
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, R.string.subtitles_failed, Toast.LENGTH_SHORT).show());
            }
        });
    }

    private void chooseSpeed() {
        String[] labels = new String[SPEEDS.length];
        int checked = 2;
        for (int i = 0; i < SPEEDS.length; i++) {
            labels[i] = SPEEDS[i] == 1f ? getString(R.string.normal) : (SPEEDS[i] + "×").replace(".0×", "×");
            if (SPEEDS[i] == speed) checked = i;
        }
        new AlertDialog.Builder(this).setTitle(R.string.speed).setSingleChoiceItems(labels, checked, (d, which) -> {
            d.dismiss();
            speed = SPEEDS[which];
            applySpeed();
        }).show();
    }

    private void applySpeed() {
        if (mp == null) return;
        try {
            boolean wasPlaying = video.isPlaying();
            PlaybackParams p = mp.getPlaybackParams().setSpeed(speed);
            mp.setPlaybackParams(p);
            if (!wasPlaying) video.pause();
        } catch (Exception ignored) { }
    }

    private void chooseAudio() {
        JSONArray tracks = item != null ? item.optJSONArray("audioTracks") : null;
        if (tracks == null) return;
        String[] labels = new String[tracks.length()];
        for (int i = 0; i < tracks.length(); i++) labels[i] = tracks.optJSONObject(i).optString("label");
        new AlertDialog.Builder(this).setTitle(R.string.audio).setSingleChoiceItems(labels, audioIndex, (d, which) -> {
            d.dismiss();
            audioIndex = which;
            if (direct && !hls) selectDirectAudio(which);
            else open(now());
        }).show();
    }

    private void chooseQuality() {
        JSONArray qs = qualities();
        if (qs.length() == 0) return;
        int first = originalAllowed() ? 1 : 0; // slots before "Auto"
        String[] ids = new String[qs.length() + 1 + first];
        String[] labels = new String[ids.length];
        if (first == 1) { ids[0] = "original"; labels[0] = getString(R.string.quality_original); }
        ids[first] = "auto"; labels[first] = getString(R.string.quality_auto);
        int checked = 0;
        for (int i = 0; i < qs.length(); i++) {
            ids[i + first + 1] = qs.optJSONObject(i).optString("id");
            labels[i + first + 1] = qs.optJSONObject(i).optString("label");
        }
        for (int i = 0; i < ids.length; i++) if (ids[i].equals(quality)) checked = i;
        new AlertDialog.Builder(this).setTitle(R.string.quality).setSingleChoiceItems(labels, checked, (d, which) -> {
            d.dismiss();
            if (ids[which].equals(quality)) return;
            double at = now();
            quality = ids[which];
            hls = !"original".equals(quality);
            open(at);
        }).show();
    }

    private void selectDirectAudio(int index) {
        if (mp == null) return;
        try {
            MediaPlayer.TrackInfo[] info = mp.getTrackInfo();
            int n = 0;
            for (int i = 0; i < info.length; i++) {
                if (info[i].getTrackType() != MediaPlayer.TrackInfo.MEDIA_TRACK_TYPE_AUDIO) continue;
                if (n++ == index) { mp.selectTrack(i); return; }
            }
        } catch (Exception e) {
            // Fall back to letting the server pick the track.
            direct = directCapable = false;
            open(now());
        }
    }

    // ---------------------------------------------------------------- chrome
    private void setControls(boolean show) {
        controls.setVisibility(show ? View.VISIBLE : View.GONE);
        if (show) poke();
        else immersive();
    }

    private void poke() {
        ui.removeCallbacks(hideControls);
        ui.postDelayed(hideControls, 3500);
    }

    @SuppressWarnings("deprecation")
    private void immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    private void enterPip() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            int w = mp != null && mp.getVideoWidth() > 0 ? mp.getVideoWidth() : 16;
            int h = mp != null && mp.getVideoHeight() > 0 ? mp.getVideoHeight() : 9;
            double r = (double) w / h;
            if (r > 2.39) { w = 239; h = 100; } else if (r < 1 / 2.39) { w = 100; h = 239; }
            enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(new Rational(w, h)).build());
        } catch (Exception ignored) { }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (video.isPlaying() && getPackageManager().hasSystemFeature("android.software.picture_in_picture")) enterPip();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPip, newConfig);
        controls.setVisibility(inPip ? View.GONE : View.VISIBLE);
        if (inPip) pipUsed = true;
    }

    @Override
    protected void onResume() {
        super.onResume();
        pipUsed = false; // back to full screen
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (!isInPictureInPictureMode()) {
            if (video.isPlaying()) video.pause();
            report();
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        report();
        if (video.isPlaying()) video.pause();
        // The picture-in-picture window was closed: playback is over.
        if (pipUsed) finish();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (item != null && video.getCurrentPosition() > 0) report();
        video.stopPlayback();
        // Stop the server's conversion right away instead of waiting for it to time out.
        if (playback != null && hls) {
            final String url = base + "/api/hls/" + playback.optString("sid");
            new Thread(() -> Net.delete(url)).start();
        }
        io.shutdown();
        super.onDestroy();
    }
}
