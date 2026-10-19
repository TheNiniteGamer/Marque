package app.marquee.client;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Hands the home screen the pictures for Continue Watching (see WatchNext). The launcher can't sign
 * in to Marquee, so the app saves each picture and shares it from here; nothing else is readable.
 */
public final class ArtProvider extends ContentProvider {
    static File dir(Context c) {
        File d = new File(c.getCacheDir(), "watchnext");
        d.mkdirs();
        return d;
    }

    static Uri uri(Context c, String name) {
        return new Uri.Builder().scheme("content").authority(c.getPackageName() + ".art").appendPath(name).build();
    }

    @Override public boolean onCreate() { return true; }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || !name.matches("[A-Za-z0-9_-]+\\.jpg") || !"r".equals(mode)) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(new File(dir(getContext()), name), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public String getType(Uri uri) { return "image/jpeg"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}
