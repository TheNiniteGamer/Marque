package app.marquee.client;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Android's package installer answering about an update (see Updater.commit). Not exported. */
public final class UpdateReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        Updater.onStatus(c, intent);
    }
}
