package app.marquee.client;

import android.app.Activity;
import android.app.SearchManager;
import android.app.DownloadManager;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.speech.RecognizerIntent;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

/**
 * The Marquee web interface in a web view, plus a bridge so videos open in the native player
 * (window.MarqueeAndroid.play) and the user can switch servers. On a TV (the Android TV app, or
 * this app on a TV) the interface runs in TV mode, moved around with the remote.
 */
public class MainActivity extends Activity {
    private static final int REQ_FILE = 1;
    private static final int REQ_PLAYER = 2;
    private static final int REQ_VOICE = 3;

    private WebView web;
    private View errorView;
    private TextView errorText;
    private String base;
    private ValueCallback<Uri[]> fileCallback;
    private boolean mainFrameFailed;
    private boolean tv;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        base = Prefs.server(this);
        if (base == null) {
            startActivity(new Intent(this, ServerActivity.class));
            finish();
            return;
        }
        tv = isTv();
        setContentView(R.layout.activity_main);
        web = findViewById(R.id.web);
        errorView = findViewById(R.id.error);
        errorText = findViewById(R.id.error_text);
        ((Button) findViewById(R.id.retry)).setOnClickListener(v -> { errorView.setVisibility(View.GONE); web.loadUrl(startUrl()); });
        ((Button) findViewById(R.id.change_server)).setOnClickListener(v -> switchServer());
        findViewById(R.id.offline_downloads).setOnClickListener(v -> openDownloads());

        CookieManager.getInstance().setAcceptCookie(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " MarqueeAndroid/" + appVersion() + (tv ? " MarqueeTV" : ""));
        web.addJavascriptInterface(new Bridge(this), "MarqueeAndroid");
        web.setWebViewClient(new Client(this));
        web.setWebChromeClient(new Chrome(this));
        web.setDownloadListener(this::download);

        String asked = searchQuery(getIntent());
        String play = WatchNext.playId(getIntent());
        String link = linkOf(getIntent());
        if (state != null) web.restoreState(state);
        else if (play != null) web.loadUrl(startUrl() + "#/play/" + play);
        else if (link != null) web.loadUrl(startUrl() + link);
        else web.loadUrl(asked != null ? startUrl() + "#/search?q=" + Uri.encode(asked) : startUrl());
        if (tv) web.requestFocus();
        // A newer app on the server? (Asks once per version; Account → Check for updates any time.)
        if (state == null) Updater.check(this, base, false);
        // Phones: new episodes and requests as notifications (Android 13+ asks once whether that's OK).
        if (!tv) {
            NotifyJob.schedule(this);
            if (Build.VERSION.SDK_INT >= 33 && !Prefs.askedNotifications(this)
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                Prefs.setAskedNotifications(this);
                requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 7);
            }
        }
    }

    /** A phone notification tapped (see NotifyJob): the page it's about, e.g. "#/show/abc". */
    private static String linkOf(Intent i) {
        if (i == null || !NotifyJob.ACTION_OPEN.equals(i.getAction())) return null;
        String link = i.getStringExtra("link");
        return link != null && link.matches("#/[A-Za-z0-9_/?=&%.-]*") ? link : null;
    }

    /** "Hey Google, search Marquee for …" (or the system search) opening the app. */
    private static String searchQuery(Intent i) {
        if (i == null || i.getAction() == null) return null;
        if (!Intent.ACTION_SEARCH.equals(i.getAction()) && !"com.google.android.gms.actions.SEARCH_ACTION".equals(i.getAction())) return null;
        String q = i.getStringExtra(SearchManager.QUERY);
        return q != null && !q.trim().isEmpty() ? q.trim() : null;
    }

    private void showSearch(String q) {
        if (web != null) web.evaluateJavascript("window.marqueeVoiceResult && window.marqueeVoiceResult(" + org.json.JSONObject.quote(q) + ")", null);
    }

    /** Listens with Android's speech recogniser (on a TV: the Google app's voice search). */
    void startVoice() {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, getString(R.string.voice_prompt))
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        try {
            startActivityForResult(i, REQ_VOICE);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.voice_unavailable, Toast.LENGTH_LONG).show();
        }
    }

    // The remote's search key starts voice search.
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getKeyCode() == KeyEvent.KEYCODE_SEARCH && web != null && errorView.getVisibility() != View.VISIBLE) {
            if (e.getAction() == KeyEvent.ACTION_UP) startVoice();
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    void openDownloads() { startActivity(new Intent(this, DownloadsActivity.class)); }

    private String startUrl() { return base + (tv ? "/?tv=1" : "/"); }

    private boolean isTv() {
        UiModeManager ui = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        return getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK)
            || (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION);
    }

    private String appVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "1"; }
    }

    private boolean sameServer(Uri u) {
        Uri b = Uri.parse(base);
        return b.getScheme().equals(u.getScheme()) && b.getHost().equalsIgnoreCase(u.getHost()) && b.getPort() == u.getPort();
    }

    private void switchServer() {
        Prefs.clearServer(this);
        startActivity(new Intent(this, ServerActivity.class));
        finish();
    }

    private void download(String url, String userAgent, String contentDisposition, String mimeType, long length) {
        try {
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url))
                .addRequestHeader("User-Agent", userAgent)
                .setTitle(name)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) r.addRequestHeader("Cookie", cookie);
            // Android 10+ can save to Downloads without a permission; older versions use the app's folder.
            if (Build.VERSION.SDK_INT >= 29) r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            else r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
            getSystemService(DownloadManager.class).enqueue(r);
            Toast.makeText(this, getString(R.string.downloading, name), Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        } else if (requestCode == REQ_VOICE) {
            java.util.ArrayList<String> heard = data != null ? data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS) : null;
            if (resultCode == RESULT_OK && heard != null && !heard.isEmpty()) showSearch(heard.get(0));
        } else if (requestCode == REQ_PLAYER && web != null) {
            // Let the page refresh progress / Continue Watching.
            web.evaluateJavascript("window.dispatchEvent(new Event('marquee-native-closed'))", null);
            // "Episodes" in the TV player: open the show's page.
            String hash = data != null ? data.getStringExtra("openHash") : null;
            if (hash != null && hash.startsWith("#/")) web.evaluateJavascript("location.hash = " + org.json.JSONObject.quote(hash), null);
        }
    }

    // Back first closes what's open on the page (a pop-up, a menu), then goes back a page; on the
    // home page it leaves the app.
    @Override
    public void onBackPressed() {
        if (web == null || errorView.getVisibility() == View.VISIBLE) { super.onBackPressed(); return; }
        web.evaluateJavascript("window.marqueeBack ? String(window.marqueeBack()) : 'none'", v -> {
            if ("\"true\"".equals(v)) return;
            if ("\"none\"".equals(v) && web.canGoBack()) web.goBack();
            else finish();
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String q = searchQuery(intent);
        if (q != null) showSearch(q);
        // A Continue Watching card on the TV's home screen.
        String play = WatchNext.playId(intent);
        if (play != null && web != null) web.evaluateJavascript("location.hash = '#/play/" + play + "'", null);
        String link = linkOf(intent);
        if (link != null && web != null) web.evaluateJavascript("location.hash = " + org.json.JSONObject.quote(link), null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        Updater.resume(this);
        if (web != null) WatchNext.sync(this, base);
        if (web != null && !tv) OfflineStore.resume(this, base);
    }

    @Override
    protected void onPause() {
        Updater.pause(this);
        if (web != null) web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // Static nested classes (not inner/anonymous ones) on purpose: the dex tool in Android build-tools 34
    // crashes on inner classes compiled by Java 21. Lambdas are fine.
    static final class Client extends WebViewClient {
        private final MainActivity a;
        Client(MainActivity a) { this.a = a; }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (a.sameServer(u)) return false;
            // Links to other sites (GitHub, TMDB...) open in the browser.
            try { a.startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            a.mainFrameFailed = false;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            a.mainFrameFailed = true;
            a.errorText.setText(a.getString(R.string.cant_reach, a.base));
            a.errorView.setVisibility(View.VISIBLE);
            a.findViewById(R.id.offline_downloads).setVisibility(!a.tv && !OfflineStore.list(a).isEmpty() ? View.VISIBLE : View.GONE);
        }

        // The page's renderer crashed, or the system closed it to free memory (TVs have little): open
        // the app again at the home page instead of the whole app closing.
        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            android.util.Log.w("Marquee", "Web page renderer gone (crashed: " + detail.didCrash() + ")");
            a.web = null; // (unusable now)
            view.destroy();
            a.startActivity(new Intent(a, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION));
            a.finish();
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!a.mainFrameFailed) a.errorView.setVisibility(View.GONE);
            CookieManager.getInstance().flush();
            Net.refreshCookie(a.base);
        }
    }

    static final class Chrome extends WebChromeClient {
        private final MainActivity a;
        Chrome(MainActivity a) { this.a = a; }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (a.fileCallback != null) a.fileCallback.onReceiveValue(null);
            a.fileCallback = callback;
            try {
                a.startActivityForResult(params.createIntent(), REQ_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                a.fileCallback = null;
                return false;
            }
        }
    }

    /** Called from the page's JavaScript (on a background thread). */
    static final class Bridge {
        private final MainActivity a;
        Bridge(MainActivity a) { this.a = a; }

        @JavascriptInterface
        public void play(String requestJson) {
            a.runOnUiThread(() -> a.startActivityForResult(
                new Intent(a, PlayerActivity.class).putExtra(PlayerActivity.EXTRA_REQUEST, requestJson), REQ_PLAYER));
        }

        @JavascriptInterface
        public void changeServer() {
            a.runOnUiThread(a::switchServer);
        }

        @JavascriptInterface
        public String version() {
            return a.appVersion();
        }

        /** Downloads for watching offline: on phones (a TV is always online). */
        @JavascriptInterface
        public boolean offlineDownloads() { return !a.tv; }

        /** The download button on a title. */
        @JavascriptInterface
        public void download(String id) {
            if (id != null && id.matches("[A-Za-z0-9_-]+")) a.runOnUiThread(() -> OfflineStore.choose(a, a.base, id));
        }

        /** "Download season": a JSON list of episode ids. */
        @JavascriptInterface
        public void downloadMany(String idsJson) {
            java.util.List<String> ids = new java.util.ArrayList<>();
            try {
                org.json.JSONArray arr = new org.json.JSONArray(idsJson);
                for (int i = 0; i < arr.length() && ids.size() < 100; i++) if (arr.getString(i).matches("[A-Za-z0-9_-]+")) ids.add(arr.getString(i));
            } catch (Exception ignored) { }
            if (!ids.isEmpty()) a.runOnUiThread(() -> OfflineStore.chooseMany(a, a.base, ids));
        }

        /** Downloads in the menu. */
        @JavascriptInterface
        public void openDownloads() {
            a.runOnUiThread(a::openDownloads);
        }

        /** The mic button by the search box. */
        @JavascriptInterface
        public void voiceSearch() {
            a.runOnUiThread(a::startVoice);
        }

        /** Account → Check for updates. */
        @JavascriptInterface
        public void checkUpdates() {
            a.runOnUiThread(() -> Updater.check(a, a.base, true));
        }
    }
}
