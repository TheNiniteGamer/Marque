package app.marquee.client;

import android.app.Activity;
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

        if (state != null) web.restoreState(state);
        else web.loadUrl(startUrl());
        if (tv) web.requestFocus();
    }

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
        } else if (requestCode == REQ_PLAYER && web != null) {
            // Let the page refresh progress / Continue Watching.
            web.evaluateJavascript("window.dispatchEvent(new Event('marquee-native-closed'))", null);
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
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
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
    }
}
