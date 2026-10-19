package app.marquee.client;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ListView;
import android.widget.TextView;

import java.net.Inet4Address;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** First screen: type the server address or find servers on the Wi-Fi. */
public class ServerActivity extends Activity {
    private final ExecutorService io = Executors.newCachedThreadPool();
    private EditText address;
    private TextView status;
    private Button connect, find;
    private final List<String> rows = new ArrayList<>();
    private final List<String> urls = new ArrayList<>();
    private ArrayAdapter<String> adapter;
    private boolean scanning;
    private ListView list;
    private int foundCount;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_server);
        address = findViewById(R.id.address);
        status = findViewById(R.id.status);
        connect = findViewById(R.id.connect);
        find = findViewById(R.id.find);
        list = findViewById(R.id.servers);
        adapter = new ArrayAdapter<>(this, R.layout.item_server, R.id.label, rows);
        list.setAdapter(adapter);
        list.setOnItemClickListener((parent, view, pos, id) -> tryConnect(urls.get(pos)));

        String last = Prefs.server(this);
        if (last != null) address.setText(last);
        for (String r : Prefs.recent(this)) addRow(r, "Recent: " + r);

        connect.setOnClickListener(v -> {
            String url = ServerAddress.normalize(address.getText().toString());
            if (url == null) { status.setText(R.string.bad_address); return; }
            tryConnect(url);
        });
        address.setOnEditorActionListener((TextView v, int action, KeyEvent e) -> {
            if (action == EditorInfo.IME_ACTION_GO) { connect.performClick(); return true; }
            return false;
        });
        find.setOnClickListener(v -> scan());
        // Look for servers straight away; on a TV, start on the list rather than the address box.
        if (getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK)) find.requestFocus();
        scan();
    }

    /** A server found on the network goes to the top of the list (replacing a "Recent" row for it). */
    private void addFound(Discovery.Found f) {
        int at = urls.indexOf(f.url);
        if (at >= 0) { urls.remove(at); rows.remove(at); }
        urls.add(foundCount, f.url);
        rows.add(foundCount, f.label());
        foundCount++;
        adapter.notifyDataSetChanged();
        // The first one found gets the focus, so OK on the remote connects.
        if (foundCount == 1 && !address.hasFocus()) { list.requestFocus(); list.setSelection(0); }
    }

    private void addRow(String url, String label) {
        if (urls.contains(url)) return;
        urls.add(url);
        rows.add(label);
        adapter.notifyDataSetChanged();
    }

    private void tryConnect(String url) {
        status.setText(getString(R.string.connecting, url));
        connect.setEnabled(false);
        io.execute(() -> {
            Discovery.Found f = Discovery.probe(url, 5000);
            runOnUiThread(() -> {
                connect.setEnabled(true);
                if (f == null) { status.setText(getString(R.string.no_server, url)); return; }
                Prefs.setServer(this, url);
                startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK));
                finish();
            });
        });
    }

    private void scan() {
        if (scanning) return;
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        Network net = cm.getActiveNetwork();
        LinkProperties lp = net != null ? cm.getLinkProperties(net) : null;
        LinkAddress v4 = null;
        if (lp != null) for (LinkAddress a : lp.getLinkAddresses()) if (a.getAddress() instanceof Inet4Address) { v4 = a; break; }
        if (v4 == null) { status.setText(R.string.need_wifi); return; }
        List<String> hosts = Discovery.subnetHosts(v4.getAddress().getAddress(), v4.getPrefixLength());
        scanning = true;
        foundCount = 0;
        find.setEnabled(false);
        status.setText(R.string.searching);
        io.execute(() -> {
            List<Discovery.Found> found = Discovery.scan(hosts, ServerAddress.DEFAULT_PORT, 700, f -> runOnUiThread(() -> addFound(f)));
            runOnUiThread(() -> {
                scanning = false;
                find.setEnabled(true);
                status.setText(found.isEmpty() ? getString(R.string.none_found) : getString(R.string.found_n, found.size()));
            });
        });
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        super.onDestroy();
    }
}
