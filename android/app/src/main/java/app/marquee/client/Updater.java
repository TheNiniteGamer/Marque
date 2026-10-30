package app.marquee.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

/**
 * Updates the app from the Marquee server it's connected to. The server keeps the latest builds in
 * /downloads, with their versions in /downloads/apps.json (written by build.sh). An update is
 * downloaded into Android's package installer, which asks the user to confirm. The first time,
 * Android also asks to allow Marquee to install apps.
 *
 * Some phones quietly stop Android's install screen from opening, so if it hasn't appeared after a
 * few seconds (or the install fails) a message offers the browser instead, which installs the
 * update the way the app was first installed.
 */
final class Updater {
    /** How long Android's install screen may take to appear while Marquee is on screen. */
    private static final long SCREEN_WAIT_MS = 10000;
    /** After that screen, how long the install may take to finish (it closes Marquee) or fail. */
    private static final long INSTALL_WAIT_MS = 30000;
    // The installer's underlying result (not in the public API): -115 is a cancelled install, where
    // Play Protect blocking one is -22, though both are reported as STATUS_FAILURE_ABORTED.
    private static final String EXTRA_LEGACY_STATUS = "android.content.pm.extra.LEGACY_STATUS";
    private static final int INSTALL_FAILED_ABORTED = -115;
    private static final Handler main = new Handler(Looper.getMainLooper());

    /** An update waiting for "install unknown apps" to be allowed in Settings. */
    private static String pendingUrl;
    private static boolean running;

    // The update handed to Android (main thread only): its session and download address; Android's
    // confirmation, until Marquee is on screen to open it; whether that was opened, and whether it
    // then covered Marquee (so the install screen is up); a failure to report when Marquee is back.
    private static int session = -1;
    private static String sessionUrl;
    private static Intent confirm;
    private static boolean confirmOpened, screenShown;
    private static String failure, failureUrl;
    /** MainActivity while it's on screen (see resume and pause). */
    private static Activity visible;
    private static final Runnable watchdog = Updater::stalled;

    private Updater() {}

    /** "android" for the phone app, "androidtv" for the TV one (same code, different package). */
    private static String key(Context c) { return c.getPackageName().endsWith(".tv") ? "androidtv" : "android"; }

    @SuppressWarnings("deprecation")
    static long installedCode(Context c) {
        try {
            PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    static String installedName(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    /**
     * Looks for a newer version on the server. `manual` (the Check for updates button) also says when
     * it's up to date or the check failed; the automatic check at start-up stays quiet then, and
     * waits a week before asking again about a version the user said "Later" to.
     */
    static void check(Activity a, String base, boolean manual) {
        if (base == null || running) return;
        new Thread(() -> {
            JSONObject latest = null;
            String error = null;
            try {
                JSONObject all = new JSONObject(Net.getText(base + "/downloads/apps.json"));
                latest = all.optJSONObject(key(a));
                if (latest == null) error = a.getString(R.string.update_no_info);
            } catch (Exception e) {
                error = a.getString(R.string.update_no_info);
            }
            final JSONObject l = latest;
            final String err = error;
            a.runOnUiThread(() -> {
                if (a.isFinishing()) return;
                if (l == null) { if (manual) Toast.makeText(a, err, Toast.LENGTH_LONG).show(); return; }
                long code = l.optLong("versionCode");
                String name = l.optString("versionName");
                if (code <= installedCode(a)) {
                    if (manual) Toast.makeText(a, a.getString(R.string.update_none, installedName(a)), Toast.LENGTH_LONG).show();
                    return;
                }
                if (!manual && Prefs.skippedUpdate(a, code)) return;
                String url = base + "/downloads/" + l.optString("file", "android".equals(key(a)) ? "Marquee.apk" : "Marquee-TV.apk");
                new AlertDialog.Builder(a)
                    .setTitle(R.string.update_title)
                    .setMessage(a.getString(R.string.update_message, name, installedName(a)))
                    .setPositiveButton(R.string.update_now, (d, w) -> install(a, url))
                    .setNegativeButton(R.string.update_later, (d, w) -> Prefs.setSkippedUpdate(a, code))
                    .show();
            });
        }).start();
    }

    /** Downloads the update into the package installer, then hands it to Android (see commit). */
    static void install(Activity a, String url) {
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            pendingUrl = url;
            new AlertDialog.Builder(a)
                .setTitle(R.string.update_allow_title)
                .setMessage(R.string.update_allow_message)
                .setPositiveButton(R.string.update_open_settings, (d, w) -> openInstallSettings(a))
                .setNegativeButton(android.R.string.cancel, (d, w) -> pendingUrl = null)
                .show();
            return;
        }
        pendingUrl = null;
        running = true;
        AlertDialog progress = new AlertDialog.Builder(a).setTitle(R.string.update_title)
            .setMessage(a.getString(R.string.update_downloading, 0)).setCancelable(false).show();
        new Thread(() -> {
            String error = null;
            int id = -1;
            HttpURLConnection c = null;
            PackageInstaller installer = a.getPackageManager().getPackageInstaller();
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                for (Map.Entry<String, String> h : Net.headers(url).entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
                if (c.getResponseCode() != 200) throw new Exception("The server answered " + c.getResponseCode());
                long size = c.getContentLengthLong();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(a.getPackageName());
                id = installer.createSession(params);
                try (PackageInstaller.Session s = installer.openSession(id)) {
                    try (InputStream in = c.getInputStream(); OutputStream out = s.openWrite("marquee.apk", 0, size > 0 ? size : -1)) {
                        byte[] buf = new byte[65536];
                        long done = 0;
                        int n, last = -1;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            done += n;
                            int pct = size > 0 ? (int) (done * 100 / size) : 0;
                            if (pct != last) {
                                last = pct;
                                a.runOnUiThread(() -> progress.setMessage(a.getString(R.string.update_downloading, pct)));
                            }
                        }
                        s.fsync(out);
                    }
                }
            } catch (Exception e) {
                error = e.getMessage();
                if (id >= 0) try { installer.abandonSession(id); } catch (Exception ignored) { }
            } finally {
                if (c != null) c.disconnect();
            }
            final String err = error;
            final int sid = id;
            a.runOnUiThread(() -> {
                running = false;
                try { progress.dismiss(); } catch (Exception ignored) { } // (the app may have been closed meanwhile)
                if (err != null) {
                    report(a, a.getString(R.string.update_failed, err), url);
                } else {
                    commit(a, sid, url);
                }
            });
        }).start();
    }

    /**
     * Hands the downloaded update to Android. Its answer comes back as a broadcast (UpdateReceiver)
     * rather than by opening MainActivity: Android may block an activity opened that way, and then
     * nothing at all would happen. Marquee opens Android's confirmation itself (see onStatus).
     */
    private static void commit(Activity a, int id, String url) {
        abandon(a); // an earlier attempt still waiting
        session = id;
        sessionUrl = url;
        confirm = null;
        confirmOpened = screenShown = false;
        try (PackageInstaller.Session s = a.getPackageManager().getPackageInstaller().openSession(id)) {
            Intent status = new Intent(a, UpdateReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getBroadcast(a, id, status, flags).getIntentSender());
        } catch (Exception e) {
            abandon(a);
            report(a, a.getString(R.string.update_failed, e.getMessage()), url);
            return;
        }
        if (visible == a) main.postDelayed(watchdog, SCREEN_WAIT_MS);
    }

    /** The package installer's answer (see commit), from UpdateReceiver on the main thread. */
    @SuppressWarnings("deprecation")
    static void onStatus(Context c, Intent intent) {
        int id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, session);
        if (session < 0 || id != session) return; // an attempt that's already over
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (visible != null) openConfirm(visible);
            return;
        }
        // The user said no on the install screen: that needs no message.
        boolean cancelled = status == PackageInstaller.STATUS_FAILURE_ABORTED && screenShown
            && intent.getIntExtra(EXTRA_LEGACY_STATUS, INSTALL_FAILED_ABORTED) == INSTALL_FAILED_ABORTED;
        String url = sessionUrl;
        finish();
        if (status == PackageInstaller.STATUS_SUCCESS || cancelled) return;
        String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        String text = c.getString(R.string.update_failed, msg != null && !msg.isEmpty() ? msg : "error " + status);
        if (visible != null) {
            report(visible, text, url);
        } else {
            failure = text;
            failureUrl = url;
        }
    }

    /** Opens Android's "Do you want to update this app?" screen over Marquee. */
    private static void openConfirm(Activity a) {
        Intent i = confirm;
        confirm = null;
        if (i == null) return;
        try {
            a.startActivity(i);
            confirmOpened = true;
        } catch (Exception e) {
            stalled();
        }
    }

    /**
     * The watchdog, while Marquee is on screen: Android's install screen hasn't come up, or it has
     * been and gone with no answer since. Either way, say so and offer the browser.
     */
    private static void stalled() {
        Activity a = visible;
        if (session < 0 || a == null) return;
        String url = sessionUrl;
        if (screenShown) {
            finish(); // (not abandoned: Android may still be installing it)
            report(a, a.getString(R.string.update_unfinished), url);
        } else {
            abandon(a);
            report(a, a.getString(R.string.update_no_screen), url);
        }
    }

    /** Says what went wrong, and offers to install through the browser. */
    private static void report(Activity a, String message, String url) {
        if (a.isFinishing() || a.isDestroyed()) return;
        new AlertDialog.Builder(a)
            .setTitle(R.string.update_title)
            .setMessage(message + "\n\n" + a.getString(R.string.update_try_browser))
            .setPositiveButton(R.string.update_browser, (d, w) -> openInBrowser(a, url))
            .setNegativeButton(R.string.close, null)
            .show();
    }

    /** The browser downloads the update and Android's own installer takes over, as for the first install. */
    private static void openInBrowser(Activity a, String url) {
        try {
            a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            // TVs often have no browser.
            new AlertDialog.Builder(a).setTitle(R.string.update_title).setMessage(a.getString(R.string.update_no_browser, url))
                .setPositiveButton(android.R.string.ok, null).show();
        }
    }

    /** Gives up on the update handed to Android (it's then never shown later). */
    private static void abandon(Context c) {
        if (session < 0) return;
        try { c.getPackageManager().getPackageInstaller().abandonSession(session); } catch (Exception ignored) { }
        finish();
    }

    private static void finish() {
        main.removeCallbacks(watchdog);
        session = -1;
        confirm = null;
    }

    private static void openInstallSettings(Activity a) {
        try {
            a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
        } catch (Exception e) {
            // Some TVs don't have that page: say where the setting is instead.
            new AlertDialog.Builder(a).setTitle(R.string.update_allow_title).setMessage(R.string.update_allow_manual)
                .setPositiveButton(android.R.string.ok, null).show();
        }
    }

    /**
     * MainActivity on screen: carry on with an update that was waiting for it (Android's
     * confirmation to open, or a failure to report), or for "install unknown apps" to be allowed.
     */
    static void resume(Activity a) {
        visible = a;
        if (failure != null) {
            String text = failure;
            failure = null;
            report(a, text, failureUrl);
        }
        if (session >= 0 && !screenShown) openConfirm(a);
        if (session >= 0) {
            // The waits only count while Marquee is on screen.
            main.removeCallbacks(watchdog);
            main.postDelayed(watchdog, screenShown ? INSTALL_WAIT_MS : SCREEN_WAIT_MS);
        }
        if (pendingUrl != null && Build.VERSION.SDK_INT >= 26 && a.getPackageManager().canRequestPackageInstalls()) install(a, pendingUrl);
    }

    /** MainActivity covered: if Android's confirmation was just opened, it's what covered it. */
    static void pause(Activity a) {
        if (visible == a) visible = null;
        main.removeCallbacks(watchdog);
        if (session >= 0 && confirmOpened) screenShown = true;
    }
}
