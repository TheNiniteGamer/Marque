package app.marquee.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Phone notifications: every half hour or so (when there's a connection), asks the server for this
 * person's new notifications (new episodes of shows they watch, requests that have arrived) and shows
 * them. Tapping one opens that page in the app.
 */
public final class NotifyJob extends JobService {
    private static final int JOB_ID = 41;
    private static final String CHANNEL = "updates";
    static final String ACTION_OPEN = "app.marquee.client.OPEN_LINK";

    /** From MainActivity on phones; harmless to call again. */
    static void schedule(Context c) {
        if (Prefs.notifiedUpTo(c) == 0) Prefs.setNotifiedUpTo(c, System.currentTimeMillis()); // nothing from before
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null || js.getPendingJob(JOB_ID) != null) return;
        js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, NotifyJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(30 * 60_000L)
            .setPersisted(false)
            .build());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        String base = Prefs.server(this);
        if (base == null) return false;
        String cookie = null;
        try { cookie = CookieManager.getInstance().getCookie(base); } catch (Exception ignored) { }
        if (cookie == null) return false; // not signed in
        Net.refreshCookie(base);
        new Thread(() -> {
            try { check(base); } catch (Exception ignored) { } // offline: next time
            jobFinished(params, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) { return true; }

    private void check(String base) throws Exception {
        long since = Prefs.notifiedUpTo(this);
        JSONArray items = Net.getJson(base + "/api/notifications?since=" + since).optJSONArray("items");
        if (items == null || items.length() == 0) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.updates_channel), NotificationManager.IMPORTANCE_DEFAULT));
        long newest = since;
        int shown = 0;
        for (int i = 0; i < items.length(); i++) {
            JSONObject n = items.getJSONObject(i);
            newest = Math.max(newest, n.optLong("at"));
            if (n.optBoolean("read") || shown >= 5) continue;
            shown++;
            Intent open = new Intent(this, MainActivity.class).setAction(ACTION_OPEN)
                .setData(Uri.parse("marquee-link:" + n.optString("id"))).putExtra("link", n.optString("link", "#/"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, n.optString("id").hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : legacy();
            b.setSmallIcon(android.R.drawable.ic_media_play).setContentTitle(n.optString("title"))
                .setContentText(n.optString("body")).setAutoCancel(true).setContentIntent(pi).setWhen(n.optLong("at")).setShowWhen(true);
            try { nm.notify(n.optString("id").hashCode(), b.build()); } catch (Exception ignored) { } // notifications turned off
        }
        Prefs.setNotifiedUpTo(this, newest);
    }

    @SuppressWarnings("deprecation")
    private Notification.Builder legacy() { return new Notification.Builder(this); }
}
