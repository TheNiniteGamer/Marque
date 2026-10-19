package app.marquee.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
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
 */
final class Updater {
    static final String ACTION_STATUS = "app.marquee.client.INSTALL_STATUS";

    /** An update waiting for "install unknown apps" to be allowed in Settings. */
    private static String pendingUrl;
    private static boolean running;

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
     * doesn't ask again about a version the user said "Later" to.
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
                if (!manual && Prefs.skippedUpdate(a) == code) return;
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

    /** Downloads the update into the package installer, which then asks to confirm. */
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
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                for (Map.Entry<String, String> h : Net.headers(url).entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
                if (c.getResponseCode() != 200) throw new Exception("The server answered " + c.getResponseCode());
                long size = c.getContentLengthLong();
                PackageInstaller installer = a.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(a.getPackageName());
                int id = installer.createSession(params);
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
                    // The installer reports back to MainActivity (onNewIntent), which shows Android's confirmation.
                    Intent status = new Intent(a, MainActivity.class).setAction(ACTION_STATUS).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    s.commit(PendingIntent.getActivity(a, 0, status, flags).getIntentSender());
                }
            } catch (Exception e) {
                error = e.getMessage();
            } finally {
                if (c != null) c.disconnect();
            }
            final String err = error;
            a.runOnUiThread(() -> {
                running = false;
                progress.dismiss();
                if (err != null) Toast.makeText(a, a.getString(R.string.update_failed, err), Toast.LENGTH_LONG).show();
            });
        }).start();
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

    /** Back from Settings: carry on with the update if installing is now allowed. */
    static void resume(Activity a) {
        if (pendingUrl != null && Build.VERSION.SDK_INT >= 26 && a.getPackageManager().canRequestPackageInstalls()) install(a, pendingUrl);
    }

    /** The package installer's answer (see install). */
    @SuppressWarnings("deprecation")
    static boolean onStatus(Activity a, Intent intent) {
        if (intent == null || !ACTION_STATUS.equals(intent.getAction())) return false;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) a.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } else if (status != PackageInstaller.STATUS_SUCCESS && status != PackageInstaller.STATUS_FAILURE_ABORTED) {
            String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            Toast.makeText(a, a.getString(R.string.update_failed, msg != null ? msg : String.valueOf(status)), Toast.LENGTH_LONG).show();
        }
        return true;
    }
}
