package app.marquee.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PictureInPictureParams;
import android.app.UiModeManager;
import android.content.Intent;
import android.content.pm.PackageManager;
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
import android.os.SystemClock;
import android.util.Rational;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.ImageView;
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
 * Native video player, the same on phones and TVs (controls: PlayerControls). Plays files directly when the phone can decode them, otherwise asks the
 * server to convert them on the fly (same /transcode endpoint the web player uses). A lower quality
 * can be chosen, which plays the server's adaptive (HLS) stream through Android's own player.
 */
public class PlayerActivity extends Activity {
    static final String EXTRA_REQUEST = "request";
    static final float[] SPEEDS = {0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f};

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final String clientId = "android-" + Long.toHexString(System.nanoTime());
    final ExecutorService io = Executors.newSingleThreadExecutor();

    private VideoView video;
    private View controls;
    private ProgressBar spinner;
    private TextView title, subtitle, subs;
    private Button skipIntro;

    String base;
    JSONObject item;
    // The controls, worked by touch on a phone and by the remote on a TV (like the Roku channel).
    private boolean tv;
    private PlayerControls controlsUi;
    private MediaControls mediaControls; // headphones, Bluetooth, notification / lock screen, Assistant
    private boolean direct;
    private boolean directCapable;  // the phone can play the original file
    private int burn = -1;          // picture subtitle track the server draws into the video, or -1
    private boolean hls;           // playing the adaptive stream (quality other than "original")
    String quality = "original";
    private String qualityPref;
    private JSONObject playback;   // signed link + streaming session from /playback
    private JSONObject intro, credits, recap;
    private boolean autoSkipIntro, autoSkipped, creditsShown;
    // Skip Intro / Skip Credits fade after skipFade seconds (0 = stay); they come back with the controls.
    int skipFade = 10;
    // Night mode: speech lifted, loud scenes evened out (Android 9+, on the player's own sound).
    boolean nightMode;
    // Watching a download (see OfflineStore): the file on the phone, no server needed.
    private boolean offline;
    private java.io.File offlineFile;
    private boolean nextOffline;   // the next episode is downloaded too
    private android.media.audiofx.DynamicsProcessing night;
    private int nightSession;
    private String skipPart;
    private long skipSince;
    private boolean skipFading;
    private double offset;       // seconds: where a converted stream starts in the real timeline
    private double pendingSeek;  // seconds: seek to this once a direct stream is ready
    private double loadingAt = -1; // seconds: where the stream being opened starts (-1 once it plays)
    double duration;
    int audioIndex;
    String subId;
    private List<Vtt.Cue> cues = new ArrayList<>();
    private MediaPlayer mp;
    float speed = 1f;
    private boolean subsOn;
    private String subLang = "", audioLang = "";   // the account's languages (Account → Playback)
    boolean autoplayNext = true;
    private long lastReport;
    private boolean pipUsed;
    private String askedVersion;   // a version picked on the film's page
    private int screenHeight = 1080;
    // Riding out a server restart (an update): where it was, and whether it was playing.
    private boolean reconnecting, resumePaused, lastPlaying, stallChecked, sourceFailed;
    private double lastGood = -1;
    private long reconnectStarted, bufferingSince;
    private TextView reconnectMsg;

    // (Lambdas and static classes only: build-tools 34's dex tool crashes on anonymous classes from Java 21.)
    private final Runnable tick = this::tickLoop;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        tv = isTvDevice();
        setContentView(R.layout.activity_player);
        immersive();
        base = Prefs.server(this);
        Net.refreshCookie(base);
        video = findViewById(R.id.video);
        controls = findViewById(R.id.controls);
        spinner = findViewById(R.id.spinner);
        reconnectMsg = findViewById(R.id.reconnect_msg);
        title = findViewById(R.id.title);
        subtitle = findViewById(R.id.subtitle);
        subs = findViewById(R.id.subs);
        skipIntro = findViewById(R.id.skip_intro);
        skipIntro.setOnClickListener(v -> {
            if ("credits".equals(skipPart)) { finish(); return; } // leaving in the credits counts as watched
            if ("recap".equals(skipPart) && recap != null) { seekTo(recap.optDouble("end")); skipIntro.setVisibility(View.GONE); return; }
            if (intro != null) seekTo(intro.optDouble("end"));
            skipIntro.setVisibility(View.GONE);
        });

        controlsUi = new PlayerControls(this, tv);
        mediaControls = new MediaControls(this);
        // Phones: a back arrow and picture-in-picture at the top (a TV remote has its own Back).
        View back = findViewById(R.id.back), pip = findViewById(R.id.pip);
        back.setOnClickListener(v -> finish());
        pip.setOnClickListener(v -> enterPip());
        if (tv) back.setVisibility(View.GONE);
        if (tv || Build.VERSION.SDK_INT < 26 || !getPackageManager().hasSystemFeature("android.software.picture_in_picture")) pip.setVisibility(View.GONE);

        video.setOnPreparedListener(this::onPrepared);
        video.setOnCompletionListener(m -> onEnded());
        video.setOnErrorListener((m, what, extra) -> onPlaybackError());
        video.setOnInfoListener((m, what, extra) -> {
            if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START) { spinner.setVisibility(View.VISIBLE); bufferingSince = System.currentTimeMillis(); }
            else if (what == MediaPlayer.MEDIA_INFO_BUFFERING_END || what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) { spinner.setVisibility(View.GONE); bufferingSince = 0; stallChecked = false; }
            return false;
        });

        try {
            JSONObject req = new JSONObject(getIntent().getStringExtra(EXTRA_REQUEST));
            autoplayNext = req.optBoolean("autoplayNext", true);
            subsOn = req.optBoolean("subsOn", false);
            subLang = req.optString("subLang", "");
            audioLang = req.optString("audioLang", "");
            styleSubtitles(req.optString("subSize", "medium"), req.optString("subStyle", "box"));
            autoSkipIntro = req.optBoolean("autoSkipIntro", false);
            skipFade = req.optInt("skipFade", 10);
            nightMode = req.optBoolean("nightMode", false);
            offline = req.optBoolean("offline", false);
            qualityPref = req.optString("quality", "");
            askedVersion = req.isNull("version") ? null : req.optString("version", null);
            screenHeight = maxScreenHeight();
            load(req.getString("id"), req.optDouble("start", 0));
        } catch (Exception e) {
            finish();
        }
    }

    private void tickLoop() {
        update();
        ui.postDelayed(tick, 250);
    }

    // ---------------------------------------------------------------- loading
    /** start: seconds, or -1 for where this download was left off. */
    private void load(String id, double start) {
        if (offline) {
            JSONObject e = OfflineStore.get(this, id);
            JSONObject it = e != null ? e.optJSONObject("item") : null;
            if (it == null || !OfflineStore.isDone(this, id)) { fail(getString(R.string.offline_gone)); return; }
            offlineFile = OfflineStore.file(this, e);
            double at = start >= 0 ? start : e.optDouble("position", 0);
            if (at > it.optDouble("duration", 0) - 30) at = 0; // finished last time: from the start
            begin(it, null, at);
            return;
        }
        spinner.setVisibility(View.VISIBLE);
        io.execute(() -> {
            try {
                JSONObject first = Net.getJson(base + "/api/items/" + id);
                // Bedtime, or today's screen time used up (set by an admin for this profile).
                JSONObject block = first.optJSONObject("watchBlock");
                if (block != null) { runOnUiThread(() -> screenTimeStop(block)); return; }
                // A film with several versions: the one asked for, else the best this device plays.
                String vid = pickVersion(first);
                final JSONObject it = vid != null && !vid.equals(first.optString("id")) ? Net.getJson(base + "/api/items/" + vid) : first;
                JSONObject pb = null;
                try { pb = Net.getJson(base + "/api/items/" + it.optString("id") + "/playback"); } catch (Exception ignored) { } // older servers
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
        credits = it.optJSONObject("credits");
        recap = it.optJSONObject("recap");
        autoSkipped = creditsShown = false;
        lastGood = -1;
        bufferingSince = 0;
        sourceFailed = false;
        skipPart = null;
        skipIntro.setVisibility(View.GONE);
        duration = it.optDouble("duration", 0);
        boolean isEp = "episode".equals(it.optString("type"));
        title.setText(it.optString("title"));
        String sub = isEp ? it.optString("showTitle") + epLabel(it) : (it.optInt("year", 0) > 0 ? String.valueOf(it.optInt("year")) : "");
        subtitle.setText(sub);
        if (isEp) {
            // The show big, then "S1:E3  Episode title"
            title.setText(it.optString("showTitle"));
            subtitle.setText("S" + it.optInt("season") + ":E" + it.optInt("episode") + "  " + it.optString("title"));
        }
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
        quality = qs.length() > 0 ? PlaybackPlan.defaultQuality(qualityPref, Uri.parse(base).getHost()) : "original";
        // Away from home the server's admin may have capped the quality: the original isn't offered then.
        if ("original".equals(quality) && qs.length() > 0 && !originalAllowed()) quality = "auto";
        if (!"original".equals(quality) && !"auto".equals(quality) && !hasQuality(qs, quality)) quality = qs.optJSONObject(0).optString("id");
        hls = !"original".equals(quality);
        if (offlineFile != null) {
            directCapable = direct = true;
            quality = "original";
            hls = false;
            JSONObject n = it.optJSONObject("next");
            nextOffline = n != null && OfflineStore.isDone(this, n.optString("id"));
        }

        subId = null;
        cues = new ArrayList<>();
        showSubtitle("");
        JSONArray list = it.optJSONArray("subtitles");
        // The languages last picked for this show win (e.g. Japanese with English subtitles).
        JSONObject pref = it.optJSONObject("tracks");
        String prefAudio = pref != null && !pref.isNull("audio") ? pref.optString("audio") : null;
        String prefSubs = pref != null && !pref.isNull("subs") ? pref.optString("subs") : null;
        JSONArray tracks = it.optJSONArray("audioTracks");
        for (int i = 0; prefAudio != null && tracks != null && i < tracks.length(); i++) {
            if (prefAudio.equals(tracks.optJSONObject(i).optString("lang"))) { audioIndex = i; break; }
        }
        // Otherwise the account's languages (Account → Playback), when the title has them.
        for (int i = 0; prefAudio == null && !audioLang.isEmpty() && tracks != null && i < tracks.length(); i++) {
            if (PlaybackPlan.sameLang(tracks.optJSONObject(i).optString("lang"), audioLang)) { audioIndex = i; break; }
        }
        JSONObject langSub = prefSubs == null && !subLang.isEmpty() ? bestSub(list, c -> PlaybackPlan.sameLang(c.optString("lang"), subLang)) : null;
        boolean subsChosen = true;
        if (langSub != null) {
            setSubtitles(langSub.optString("id"), false);
        } else if (prefSubs != null && !"off".equals(prefSubs) && list != null) {
            JSONObject pick = bestSub(list, c -> prefSubs.equals(c.optString("lang")));
            if (pick != null) setSubtitles(pick.optString("id"), false);
            else subsChosen = false;
        } else if (subsOn && prefSubs == null && list != null && list.length() > 0) {
            String lang = Locale.getDefault().getLanguage();
            JSONObject pick = bestSub(list, c -> { String l = c.optString("lang", ""); return !l.isEmpty() && l.toLowerCase(Locale.ROOT).startsWith(lang); });
            if (pick == null) pick = list.optJSONObject(0);
            setSubtitles(pick.optString("id"), false);
        } else {
            subsChosen = false;
        }
        // Subtitles off: a "forced" track in the language being listened to still shows (just the
        // bits in another language, as the film intends).
        String heard = tracks != null && audioIndex < tracks.length() ? tracks.optJSONObject(audioIndex).optString("lang", "") : "";
        JSONObject forced = !subsChosen && !heard.isEmpty() ? bestSub(list, c -> c.optBoolean("forced") && !c.has("burn") && PlaybackPlan.sameLang(c.optString("lang"), heard)) : null;
        if (forced != null) setSubtitles(forced.optString("id"), false);
        controlsUi.onBegin();
        String art = base + "/api/art/" + (isEp ? "thumb" : "backdrop") + "/" + it.optString("id") + "?v=" + it.optString("artV", "");
        mediaControls.setItem(title.getText().toString(), subtitle.getText().toString(), duration, offlineFile != null ? null : art);
        open(start);
        ui.removeCallbacks(tick);
        ui.post(tick);
        setControls(true);
    }

    /**
     * The best subtitles that `ok` accepts: full ones before "forced" ones (just the foreign-language
     * bits), text before pictures (Blu-ray / DVD ones need the video converted).
     */
    static JSONObject bestSub(JSONArray list, java.util.function.Predicate<JSONObject> ok) {
        for (int pass = 0; list != null && pass < 4; pass++) {
            for (int i = 0; i < list.length(); i++) {
                JSONObject c = list.optJSONObject(i);
                if (c.has("burn") == (pass >= 2) && c.optBoolean("forced") == (pass % 2 == 1) && ok.test(c)) return c;
            }
        }
        return null;
    }

    JSONArray qualities() {
        JSONArray qs = playback != null ? playback.optJSONArray("qualities") : null;
        return qs != null ? qs : new JSONArray();
    }

    boolean originalAllowed() { return playback == null || playback.optBoolean("originalAllowed", true); }

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
    static Set<String> decoders() {
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
        loadingAt = t;
        lastReport = System.currentTimeMillis(); // (the first report waits until it has had a chance to start)
        String id = item.optString("id");
        if (offlineFile != null) {
            offset = 0;
            pendingSeek = t;
            video.setVideoURI(Uri.fromFile(offlineFile));
            return;
        }
        // A file that can't be played as it is comes through the adaptive stream at its best quality:
        // Android's player can't be relied on with the server's one-piece converted stream (an MP4
        // sent as it's made, with no length), which failed on some MKVs. (Servers without adaptive
        // streaming still send that one.)
        if (!hls && !direct && qualities().length() > 0) {
            hls = true;
            // The original picture unconverted when the server can (only the sound is converted:
            // an MKV with DTS sound, say), else the best quality.
            quality = playback != null && playback.optBoolean("remux") && burn < 0 && !sourceFailed ? "source" : qualities().optJSONObject(0).optString("id");
        }
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
                    String url = base + "/api/items/" + id + "/transcode?start=" + fmt(want) + "&audio=" + audioIndex
                        + (playback == null || playback.optString("sid").isEmpty() ? "" : "&sid=" + playback.optString("sid")) + burnQuery();
                    video.setVideoURI(Uri.parse(url), Net.headers(url));
                });
            });
        }
    }

    /** Subtitle size and look (Account → Playback): a dark box (as before), an outline, or yellow. */
    private void styleSubtitles(String size, String style) {
        float scale = "small".equals(size) ? 0.8f : "large".equals(size) ? 1.3f : "xlarge".equals(size) ? 1.6f : 1f;
        subs.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.player_subs) * scale);
        if ("box".equals(style)) return;
        subs.setBackground(null);
        subs.setShadowLayer(8f, 0f, 0f, 0xFF000000);
        if ("yellow".equals(style)) subs.setTextColor(0xFFFFE14D);
    }

    private static String str(JSONObject o, String key) { return o.isNull(key) ? null : o.optString(key, null); }

    /**
     * Which copy of a film to play (null: it has only one): the one picked on its page; else the
     * best this device plays as it is that isn't bigger than its screen (a 4K one on a 4K TV, the
     * 1080p one on a phone or a 1080p TV); else the smallest it plays as it is; else the smallest.
     * Away from home, the smallest it plays as it is.
     */
    private String pickVersion(JSONObject it) {
        JSONArray vs = it.optJSONArray("versions");
        if (vs == null || vs.length() < 2) return null;
        String asked = askedVersion;
        askedVersion = null; // (only for the first film; the next one is chosen afresh)
        for (int i = 0; asked != null && i < vs.length(); i++) if (asked.equals(vs.optJSONObject(i).optString("id"))) return asked;
        boolean away = !"original".equals(PlaybackPlan.defaultQuality(qualityPref, Uri.parse(base).getHost()));
        Set<String> dec = decoders();
        JSONObject fits = null, direct = null, smallest = null;
        for (int i = 0; i < vs.length(); i++) {
            JSONObject v = vs.optJSONObject(i);
            int h = v.optInt("height", 0);
            boolean asIs = PlaybackPlan.canDirectPlay(str(v, "fileName"), str(v, "videoCodec"), str(v, "profile"), str(v, "audioCodec"), dec);
            if (asIs && h <= screenHeight * 1.05 && (fits == null || h > fits.optInt("height", 0))) fits = v;
            if (asIs && (direct == null || h < direct.optInt("height", 0))) direct = v;
            if (smallest == null || h < smallest.optInt("height", 0)) smallest = v;
        }
        JSONObject pick = away ? (direct != null ? direct : smallest) : fits != null ? fits : direct != null ? direct : smallest;
        return pick.optString("id");
    }

    /** The tallest picture this screen (or the TV it's plugged into) shows. */
    private int maxScreenHeight() {
        int h = 0;
        try {
            for (android.view.Display.Mode m : getWindowManager().getDefaultDisplay().getSupportedModes()) h = Math.max(h, Math.min(m.getPhysicalWidth(), m.getPhysicalHeight()));
        } catch (Exception ignored) { }
        return h > 0 ? h : 1080;
    }

    private String burnQuery() { return burn >= 0 ? "&burn=" + burn : ""; }

    private static String fmt(double d) { return String.format(Locale.ROOT, "%.3f", d); }

    private void onPrepared(MediaPlayer m) {
        mp = m;
        applySpeed();
        applyNight();
        if (seekable() && pendingSeek > 0) video.seekTo((int) (pendingSeek * 1000));
        loadingAt = -1;
        if (direct && !hls && audioIndex > 0) selectDirectAudio(audioIndex);
        video.start();
        if (resumePaused) { resumePaused = false; video.pause(); }
        spinner.setVisibility(View.GONE);
        updatePlayIcon();
        poke();
    }

    private boolean onPlaybackError() {
        if (reconnecting) return true;
        if (offlineFile != null || item == null) return playbackFailed();
        // The server may just be restarting (into an update): then wait for it instead.
        io.execute(() -> {
            boolean up = serverUp();
            runOnUiThread(() -> { if (isFinishing()) return; if (up) playbackFailed(); else reconnect(); });
        });
        return true;
    }

    private boolean serverUp() {
        try { return Net.getJson(base + "/api/health").optBoolean("ok", false); } catch (Exception e) { return false; }
    }

    /** Waits (up to a minute and a half) for the server to come back, then carries on where it was. */
    private void reconnect() {
        if (reconnecting || isFinishing() || item == null) return;
        reconnecting = true;
        reconnectStarted = System.currentTimeMillis();
        resumePaused = !lastPlaying;
        if (lastGood < 0) lastGood = Math.max(0, now());
        video.stopPlayback();
        mp = null;
        spinner.setVisibility(View.VISIBLE);
        reconnectMsg.setVisibility(View.VISIBLE);
        ui.postDelayed(this::reconnectAttempt, 2000);
    }

    private void reconnectAttempt() {
        if (isFinishing()) return;
        final String id = item.optString("id");
        io.execute(() -> {
            boolean up = serverUp();
            JSONObject pb = null;
            // A restarted server has forgotten its streaming sessions: ask for fresh links.
            if (up) try { pb = Net.getJson(base + "/api/items/" + id + "/playback"); } catch (Exception ignored) { }
            final JSONObject p = pb;
            runOnUiThread(() -> {
                if (isFinishing()) return;
                if (up) {
                    if (p != null) playback = p;
                    reconnecting = false;
                    reconnectMsg.setVisibility(View.GONE);
                    open(lastGood);
                } else if (System.currentTimeMillis() - reconnectStarted < 90_000) {
                    ui.postDelayed(this::reconnectAttempt, 2000);
                } else {
                    reconnecting = false;
                    reconnectMsg.setVisibility(View.GONE);
                    fail(getString(R.string.server_gone));
                }
            });
        });
    }

    private boolean playbackFailed() {
        if (item == null) { fail(getString(R.string.playback_error)); return true; }
        double at = now();
        if (hls && "source".equals(quality)) {
            // The unconverted picture didn't play: the server converts it.
            sourceFailed = true;
            hls = false;
            open(at);
            return true;
        }
        if (hls && directCapable && burn < 0 && originalAllowed()) {
            // The adaptive stream didn't play: try the file as it is.
            Toast.makeText(this, R.string.adaptive_failed, Toast.LENGTH_SHORT).show();
            hls = false;
            direct = true;
            quality = "original";
            open(at);
            return true;
        }
        if (direct && !hls) {
            // The TV or phone couldn't play the original file: let the server convert it.
            Toast.makeText(this, R.string.switching_to_convert, Toast.LENGTH_SHORT).show();
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
    // (While a stream is opening, the player says 0: the position is where it's going to start.)
    double now() { return loadingAt >= 0 ? loadingAt : offset + video.getCurrentPosition() / 1000.0; }

    void seekTo(double t) {
        if (item == null) return;
        t = Math.max(0, duration > 0 ? Math.min(t, duration - 1) : t);
        if (seekable()) video.seekTo((int) (t * 1000));
        else open(t); // a converted stream can only start over from a new position
    }

    boolean isPlaying() { return video.isPlaying(); }

    boolean hasNext() {
        JSONObject n = item != null ? item.optJSONObject("next") : null;
        return n != null && (!offline || nextOffline);
    }

    void togglePlay() {
        if (video.isPlaying()) { video.pause(); report(); } else video.start();
        updatePlayIcon();
    }

    private void updatePlayIcon() { controlsUi.onPlayState(video.isPlaying()); }

    private void update() {
        if (item == null || reconnecting) return;
        double t = now();
        if (video.isPlaying()) lastGood = t;
        lastPlaying = video.isPlaying() || bufferingSince > 0;
        // Stuck loading for a while: if the server has gone away, wait for it rather than spin forever.
        if (bufferingSince > 0 && !stallChecked && offlineFile == null && System.currentTimeMillis() - bufferingSince > 10_000) {
            stallChecked = true;
            io.execute(() -> { boolean up = serverUp(); runOnUiThread(() -> { if (!up && !isFinishing()) reconnect(); }); });
        }
        controlsUi.tick(t);
        mediaControls.update(video.isPlaying(), t);
        showSubtitle(cues.isEmpty() ? "" : Vtt.textAt(cues, (long) (t * 1000)));
        updateIntro(t);
        updatePlayIcon();
        if (System.currentTimeMillis() - lastReport > 10000) report(); // also while paused
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
        // "Up next" as soon as the end credits start (offline: only when the next one is downloaded too).
        JSONObject n = hasNext() ? item.optJSONObject("next") : null;
        // A film's end credits get "Skip Credits" instead.
        boolean inCredits = credits != null && n == null && duration > 0 && t >= credits.optDouble("start") && t < duration - 2;
        boolean inRecap = recap != null && t >= recap.optDouble("start") && t < recap.optDouble("end") - 1;
        String part = inRecap ? "recap" : in ? "intro" : inCredits ? "credits" : null;
        if (part == null ? skipPart != null : !part.equals(skipPart)) {
            skipPart = part;
            skipSince = SystemClock.elapsedRealtime();
            if (part != null) skipIntro.setText(inRecap ? R.string.skip_recap : in ? R.string.skip_intro : R.string.skip_credits);
        }
        boolean show = part != null && (skipFade <= 0 || SystemClock.elapsedRealtime() - skipSince < skipFade * 1000L
            || controls.getVisibility() == View.VISIBLE);
        if (show) {
            if (skipFading) { skipIntro.animate().cancel(); skipFading = false; }
            skipIntro.setAlpha(1f);
            skipIntro.setVisibility(View.VISIBLE);
        } else if (part == null) {
            skipIntro.setVisibility(View.GONE);
        } else if (skipIntro.getVisibility() == View.VISIBLE && !skipFading) {
            skipFading = true;
            skipIntro.animate().alpha(0f).setDuration(600).withEndAction(() -> {
                skipFading = false;
                skipIntro.setVisibility(View.GONE);
                skipIntro.setAlpha(1f);
            }).start();
        }
        if (credits != null && n != null && !creditsShown && !controlsUi.scrubbing() && t >= credits.optDouble("start") && t < credits.optDouble("start") + 30) {
            creditsShown = true;
            controlsUi.showUpNext(n, false);
        }
    }

    /** The subtitle line; the box (with its dark background) is hidden when there's nothing to show. */
    private void showSubtitle(String text) {
        if (text == null) text = "";
        if (!text.contentEquals(subs.getText())) subs.setText(text);
        subs.setVisibility(text.isEmpty() ? View.GONE : View.VISIBLE);
    }


    private void markWatched() {
        if (offline) { OfflineStore.savePosition(this, item.optString("id"), duration); return; }
        final String url = base + "/api/items/" + item.optString("id") + "/watched";
        io.execute(() -> {
            try { Net.postJson(url, new JSONObject().put("watched", true)); } catch (Exception ignored) { }
        });
    }

    private void report() { report(false); }

    // Saves the resume position and tells the server's Activity page what's playing.
    private void report(boolean stopped) {
        if (item == null || reconnecting) return;
        lastReport = System.currentTimeMillis();
        if (offline) { OfflineStore.savePosition(this, item.optString("id"), now()); return; }
        final String url = base + "/api/items/" + item.optString("id") + "/progress";
        final double pos = now();
        final boolean paused = !video.isPlaying();
        final String mode = hls ? "hls" : direct ? "direct" : "transcode";
        final String q = hls ? quality : null;
        io.execute(() -> {
            try {
                JSONObject r = Net.postForJson(url, new JSONObject().put("position", pos).put("paused", paused).put("mode", mode)
                    .put("quality", q).put("client", clientId).put("stopped", stopped));
                // Bedtime has started, or today's screen time is used up: stop with a message.
                JSONObject stop = stopped ? null : r.optJSONObject("stop");
                if (stop != null) runOnUiThread(() -> screenTimeStop(stop));
            } catch (Exception ignored) { }
        });
    }

    private boolean screenTimeShown;
    private void screenTimeStop(JSONObject b) {
        if (screenTimeShown || isFinishing()) return;
        screenTimeShown = true;
        spinner.setVisibility(View.GONE);
        try { video.pause(); } catch (Exception ignored) { }
        new AlertDialog.Builder(this)
            .setTitle("bedtime".equals(b.optString("reason")) ? R.string.bedtime : "admin".equals(b.optString("reason")) ? R.string.stopped_by_admin : R.string.enough_today)
            .setMessage(b.optString("message"))
            .setPositiveButton(android.R.string.ok, (d, w) -> finish()).setOnCancelListener(d -> finish()).show();
    }

    private void onEnded() {
        if (item == null || reconnecting) return;
        // A stream that stops well before the end may just be the server restarting.
        if (offlineFile == null && duration > 0 && lastGood >= 0 && lastGood < duration - 60) {
            io.execute(() -> { boolean up = serverUp(); runOnUiThread(() -> { if (isFinishing()) return; if (up) ended(); else reconnect(); }); });
            return;
        }
        ended();
    }

    private void ended() {
        if (offline) { OfflineStore.savePosition(this, item.optString("id"), duration); controlsUi.onEnded(); return; }
        final String url = base + "/api/items/" + item.optString("id") + "/progress";
        io.execute(() -> {
            try { Net.postJson(url, new JSONObject().put("position", duration)); } catch (Exception ignored) { }
        });
        controlsUi.onEnded();
    }

    void playNext() {
        JSONObject n = item != null ? item.optJSONObject("next") : null;
        if (n == null || !hasNext()) return;
        if (credits != null && now() >= credits.optDouble("start") - 1) markWatched(); // left during the credits
        else report();
        video.stopPlayback();
        load(n.optString("id"), offline ? -1 : 0);
    }

    // ---------------------------------------------------------------- choices

    /** From the TV's Audio & Subtitles panel (null = off). */
    void chooseSubtitle(String id) {
        setSubtitles(id, true);
        rememberTracks();
    }

    /** Episodes: the show remembers the sound and subtitle languages picked. */
    private void rememberTracks() {
        if (item == null || !"episode".equals(item.optString("type"))) return;
        JSONArray tracks = item.optJSONArray("audioTracks");
        JSONObject a = tracks != null ? tracks.optJSONObject(audioIndex) : null;
        String subs = "off";
        JSONArray list = item.optJSONArray("subtitles");
        for (int i = 0; subId != null && list != null && i < list.length(); i++) {
            if (subId.equals(list.optJSONObject(i).optString("id"))) subs = list.optJSONObject(i).optString("lang", null);
        }
        final String url = base + "/api/items/" + item.optString("id") + "/tracks";
        final JSONObject body = new JSONObject();
        try {
            body.put("audio", a != null && !a.isNull("lang") ? a.optString("lang") : JSONObject.NULL);
            body.put("subs", subs != null ? subs : JSONObject.NULL);
        } catch (Exception ignored) { }
        io.execute(() -> Net.putJson(url, body));
    }

    private void setSubtitles(String id, boolean reopen) {
        subId = id;
        cues = new ArrayList<>();
        showSubtitle("");
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
        final java.io.File local = offline ? OfflineStore.subtitle(this, item.optString("id"), id) : null;
        io.execute(() -> {
            try {
                String text = local != null ? new String(java.nio.file.Files.readAllBytes(local.toPath()), java.nio.charset.StandardCharsets.UTF_8) : Net.getText(url);
                List<Vtt.Cue> c = Vtt.parse(text);
                runOnUiThread(() -> { if (id.equals(subId)) cues = c; });
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, R.string.subtitles_failed, Toast.LENGTH_SHORT).show());
            }
        });
    }


    /** From the Audio & Subtitles panel; the account remembers it for every player. */
    void setNight(boolean on) {
        nightMode = on;
        applyNight();
        final String url = base + "/api/auth/prefs";
        io.execute(() -> {
            try { Net.putJson(url, new JSONObject().put("nightMode", on)); } catch (Exception ignored) { }
        });
    }

    /** Each new video has its own sound session, so the effect is set up again for it. */
    private void applyNight() {
        if (Build.VERSION.SDK_INT < 28 || mp == null) return;
        try {
            int session = mp.getAudioSessionId();
            if (night != null && nightSession != session) { night.release(); night = null; }
            if (night == null && nightMode) {
                night = new android.media.audiofx.DynamicsProcessing(0, session, nightConfig());
                nightSession = session;
            }
            if (night != null) night.setEnabled(nightMode);
        } catch (Exception e) {
            night = null; // the device doesn't offer it: plain sound
        }
    }

    @android.annotation.TargetApi(28)
    private static android.media.audiofx.DynamicsProcessing.Config nightConfig() {
        android.media.audiofx.DynamicsProcessing.Config c = new android.media.audiofx.DynamicsProcessing.Config.Builder(
            android.media.audiofx.DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 2, true, 3, true, 1, false, 0, true).build();
        // Less rumble, more voice.
        c.setPreEqBandAllChannelsTo(0, new android.media.audiofx.DynamicsProcessing.EqBand(true, 150, -6));
        c.setPreEqBandAllChannelsTo(1, new android.media.audiofx.DynamicsProcessing.EqBand(true, 4000, 4));
        c.setPreEqBandAllChannelsTo(2, new android.media.audiofx.DynamicsProcessing.EqBand(true, 20000, 0));
        // Quiet parts up, loud parts down.
        android.media.audiofx.DynamicsProcessing.MbcBand b = new android.media.audiofx.DynamicsProcessing.MbcBand(true, 20000, 8, 220, 4, -30, 6, -90, 1, 0, 8);
        c.setMbcBandAllChannelsTo(0, b);
        c.setLimiterAllChannelsTo(new android.media.audiofx.DynamicsProcessing.Limiter(true, true, 0, 2, 150, 10, -2, 0));
        return c;
    }

    /** From the Audio & Subtitles panel. */
    void setSpeed(float s) {
        speed = s;
        applySpeed();
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


    void selectAudio(int which) {
        audioIndex = which;
        rememberTracks();
        if (direct && !hls) selectDirectAudio(which);
        else open(now());
    }

    /** Quality choices as ids ("original", "auto", "720p"…) and labels, in the same order. */
    List<String> qualityIds() {
        List<String> ids = new ArrayList<>();
        JSONArray qs = qualities();
        if (qs.length() == 0) return ids;
        if (originalAllowed()) ids.add("original");
        ids.add("auto");
        for (int i = 0; i < qs.length(); i++) ids.add(qs.optJSONObject(i).optString("id"));
        return ids;
    }

    List<String> qualityLabels() {
        List<String> labels = new ArrayList<>();
        JSONArray qs = qualities();
        if (qs.length() == 0) return labels;
        if (originalAllowed()) labels.add(getString(R.string.quality_original));
        labels.add(getString(R.string.quality_auto));
        for (int i = 0; i < qs.length(); i++) labels.add(qs.optJSONObject(i).optString("label"));
        return labels;
    }

    void applyQuality(String id) {
        if (id.equals(quality)) return;
        double at = now();
        quality = id;
        hls = !"original".equals(quality);
        open(at);
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

    // ---------------------------------------------------------------- remote and keyboard
    // Centre (or space) plays and pauses, left/right jump back 10 s / ahead 30 s while the controls
    // are hidden (when they show, the arrows move between the buttons), plus the media keys.
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (controlsUi.onKey(event)) return true;
        return super.dispatchKeyEvent(event);
    }

    boolean skipShowing() { return skipIntro.getVisibility() == View.VISIBLE && skipIntro.getAlpha() > 0.5f; }

    void skipNow() { skipIntro.performClick(); }

    /** The show's episode list, in the app's own pages. */
    void openEpisodes() {
        setResult(RESULT_OK, new Intent().putExtra("openHash", "#/show/" + item.optString("showId")));
        finish();
    }

    private boolean isTvDevice() {
        UiModeManager m = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        return getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK)
            || (m != null && m.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION);
    }

    // ---------------------------------------------------------------- chrome
    private void setControls(boolean show) {
        if (show) controlsUi.show(null);
        else { controlsUi.hide(); immersive(); }
    }

    private void poke() {
        controlsUi.poke();
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
        if (inPip) controlsUi.hide(); else controlsUi.show(null);
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
        controlsUi.release();
        mediaControls.release();
        if (night != null) night.release();
        if (item != null && video.getCurrentPosition() > 0) report(true);
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
