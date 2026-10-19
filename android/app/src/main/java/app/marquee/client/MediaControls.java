package app.marquee.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;

/**
 * The player as Android sees it: a media session, so headphone and Bluetooth buttons, the media
 * controls in the notification shade / lock screen, Android TV's remote and "Hey Google, pause"
 * work; and a notification with play/pause, back 10 s and ahead 10 s (e.g. in picture-in-picture).
 */
final class MediaControls {
    private static final String CHANNEL = "playback";
    private static final int NOTIFICATION_ID = 7;
    private static final String ACTION = "app.marquee.client.MEDIA";

    private final PlayerActivity a;
    private final MediaSession session;
    private final NotificationManager nm;
    private final Receiver receiver;
    private String title = "", subtitle = "";
    private Bitmap art;
    private boolean lastPlaying;
    private long lastPosition = -1, lastPush;

    MediaControls(PlayerActivity a) {
        this.a = a;
        session = new MediaSession(a, "Marquee");
        session.setCallback(new Callback(a));
        session.setActive(true);
        nm = a.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, a.getString(R.string.playback_channel), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        // The notification's buttons on Android 12 and older (newer versions use the session itself).
        receiver = new Receiver(a);
        IntentFilter f = new IntentFilter(ACTION);
        if (Build.VERSION.SDK_INT >= 33) a.registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED);
        else a.registerReceiver(receiver, f);
    }

    /** A new video: its titles and picture (the picture loads in the background). */
    void setItem(String title, String subtitle, double duration, String artUrl) {
        this.title = title;
        this.subtitle = subtitle;
        art = null;
        publishMetadata(duration);
        lastPosition = -1;
        if (artUrl != null) {
            a.io.execute(() -> {
                try {
                    byte[] b = Net.getBytes(artUrl);
                    Bitmap bm = BitmapFactory.decodeByteArray(b, 0, b.length);
                    a.runOnUiThread(() -> { art = bm; publishMetadata(duration); notifyNow(lastPlaying); });
                } catch (Exception ignored) { }
            });
        }
    }

    private void publishMetadata(double duration) {
        MediaMetadata.Builder m = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, (long) (duration * 1000));
        if (art != null) m.putBitmap(MediaMetadata.METADATA_KEY_ART, art);
        session.setMetadata(m.build());
    }

    /** Called a few times a second: tells Android when playing / paused changes, and the position now and then. */
    void update(boolean playing, double seconds) {
        long pos = (long) (seconds * 1000);
        long now = System.currentTimeMillis();
        if (playing == lastPlaying && lastPosition >= 0 && now - lastPush < 5000 && Math.abs(pos - lastPosition) < 3000) return;
        lastPlaying = playing;
        lastPosition = pos;
        lastPush = now;
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_FAST_FORWARD | PlaybackState.ACTION_REWIND
            | PlaybackState.ACTION_STOP | (a.hasNext() ? PlaybackState.ACTION_SKIP_TO_NEXT : 0);
        session.setPlaybackState(new PlaybackState.Builder().setActions(actions)
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, pos, playing ? a.speed : 0f).build());
        notifyNow(playing);
    }

    private void notifyNow(boolean playing) {
        if (nm == null) return;
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(a, CHANNEL) : legacyBuilder();
        b.setSmallIcon(playing ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause)
            .setContentTitle(title).setContentText(subtitle).setOngoing(playing).setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(PendingIntent.getActivity(a, 0, new Intent(a, PlayerActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
            .addAction(action(android.R.drawable.ic_media_rew, a.getString(R.string.back_10), "rew", 1))
            .addAction(action(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                a.getString(playing ? R.string.pause : R.string.play), "toggle", 2))
            .addAction(action(android.R.drawable.ic_media_ff, a.getString(R.string.ahead_10), "ff", 3))
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        if (art != null) b.setLargeIcon(art);
        try { nm.notify(NOTIFICATION_ID, b.build()); } catch (Exception ignored) { } // notifications turned off
    }

    @SuppressWarnings("deprecation")
    private Notification.Builder legacyBuilder() { return new Notification.Builder(a); }

    private Notification.Action action(int icon, String label, String what, int code) {
        Intent i = new Intent(ACTION).setPackage(a.getPackageName()).putExtra("what", what);
        PendingIntent pi = PendingIntent.getBroadcast(a, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(a, icon), label, pi).build();
    }

    void release() {
        try { a.unregisterReceiver(receiver); } catch (Exception ignored) { }
        if (nm != null) nm.cancel(NOTIFICATION_ID);
        session.setActive(false);
        session.release();
    }

    /** Headphones, Bluetooth, the lock screen, the TV remote, the Assistant. */
    static final class Callback extends MediaSession.Callback {
        private final PlayerActivity a;
        Callback(PlayerActivity a) { this.a = a; }
        @Override public void onPlay() { if (!a.isPlaying()) a.togglePlay(); }
        @Override public void onPause() { if (a.isPlaying()) a.togglePlay(); }
        @Override public void onSeekTo(long ms) { a.seekTo(ms / 1000.0); }
        @Override public void onFastForward() { a.seekTo(a.now() + 10); }
        @Override public void onRewind() { a.seekTo(a.now() - 10); }
        @Override public void onSkipToNext() { if (a.hasNext()) a.playNext(); }
        @Override public void onStop() { a.finish(); }
    }

    /** The notification's buttons. */
    static final class Receiver extends BroadcastReceiver {
        private final PlayerActivity a;
        Receiver(PlayerActivity a) { this.a = a; }
        @Override public void onReceive(Context c, Intent i) {
            String what = i.getStringExtra("what");
            if ("toggle".equals(what)) a.togglePlay();
            else if ("rew".equals(what)) a.seekTo(a.now() - 10);
            else if ("ff".equals(what)) a.seekTo(a.now() + 10);
        }
    }
}
