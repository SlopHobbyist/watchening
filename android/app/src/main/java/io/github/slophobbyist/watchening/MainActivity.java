package io.github.slophobbyist.watchening;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoSession.NavigationDelegate;
import org.mozilla.geckoview.GeckoSession.PermissionDelegate;
import org.mozilla.geckoview.GeckoSession.PromptDelegate;
import org.mozilla.geckoview.GeckoSessionSettings;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.StorageController;
import org.mozilla.geckoview.WebRequestError;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * The whole app: a full-screen GeckoView showing the Watchening site.
 *
 * The site knows it's in the app from the "WatcheningTV/<version>" token at
 * the end of the user agent, and asks the app for things by navigating to
 * watchening-app:<action> (see {@link #appAction}):
 *   watchening-app:reload  clear the caches and reload the page
 *   watchening-app:server  change the server address
 */
public class MainActivity extends Activity {
    private static final String TAG = "Watchening";
    private static final String SCHEME = "watchening-app:";
    private static final String PREF_SERVER = "server";
    private static final int REQ_PERMS = 1;

    /** One per process: GeckoRuntime.create can only be called once. */
    private static GeckoRuntime sRuntime;

    private GeckoView mView;
    private GeckoSession mSession;
    private SharedPreferences mPrefs;
    private boolean mCanGoBack;
    private long mLastBack;
    private PermissionDelegate.Callback mPermCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        mPrefs = getSharedPreferences("watchening", MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        mView = new GeckoView(this);
        mView.setBackgroundColor(0xff000000);
        setContentView(mView);
        hideSystemBars();

        mSession = new GeckoSession(new GeckoSessionSettings.Builder()
                .userAgentOverride(GeckoSession.getDefaultUserAgent() + " WatcheningTV/" + BuildConfig.VERSION_NAME)
                .suspendMediaWhenInactive(true)
                .build());
        mSession.setNavigationDelegate(new Navigation());
        mSession.setPermissionDelegate(new Permissions());
        mSession.setPromptDelegate(new Prompts());
        mSession.setContentDelegate(new GeckoSession.ContentDelegate() {
            @Override
            public void onCrash(GeckoSession session) { restartSession(); }

            @Override
            public void onKill(GeckoSession session) { restartSession(); }
        });
        mSession.open(runtime(this));
        mView.setSession(mSession);

        Extensions.ensure(sRuntime, () -> runOnUiThread(() -> {
            // freshly installed: reload so YouTube embeds already on the page get it
            if (server() != null) mSession.reload();
        }));

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }

        String url = server();
        if (url == null) askServer(true);
        else mSession.loadUri(url);
    }

    /**
     * Gecko preferences. Mobile Gecko stretches the layout viewport to fit
     * content that overflows it (innerHeight 780 on a 540-high screen), and
     * the site sizes itself from innerHeight, so it came out too big and cut
     * off. A TV wants the desktop behaviour: the viewport is the screen.
     */
    private static final String GECKO_CONFIG = "prefs:\n"
            + "  dom.meta-viewport.enabled: false\n"
            + "  apz.allow_zooming: false\n";

    private static GeckoRuntime runtime(Context ctx) {
        if (sRuntime == null) {
            File config = new File(ctx.getFilesDir(), "geckoview-config.yaml");
            try (FileOutputStream out = new FileOutputStream(config)) {
                out.write(GECKO_CONFIG.getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                Log.w(TAG, "couldn't write " + config, e);
            }
            sRuntime = GeckoRuntime.create(ctx.getApplicationContext(), new GeckoRuntimeSettings.Builder()
                    .configFilePath(config.getAbsolutePath())
                    .consoleOutput(BuildConfig.DEBUG)
                    .remoteDebuggingEnabled(BuildConfig.DEBUG)
                    .doubleTapZoomingEnabled(false)
                    .inputAutoZoomEnabled(false)
                    .build());
        }
        return sRuntime;
    }

    private void restartSession() {
        runOnUiThread(() -> {
            mSession.close();
            mSession.open(sRuntime);
            mView.setSession(mSession);
            String url = server();
            if (url != null) mSession.loadUri(url);
        });
    }

    // ------------------------------------------------------------- server

    /** The saved server address, or the one built in, or null to ask. */
    private String server() {
        String s = mPrefs.getString(PREF_SERVER, BuildConfig.DEFAULT_URL);
        return s == null || s.isEmpty() ? null : s;
    }

    /** "tv.example.com" → "https://tv.example.com/" */
    static String normalize(String s) {
        s = s.trim();
        if (s.isEmpty()) return null;
        if (!s.matches("(?i)^https?://.*")) s = "https://" + s;
        Uri u = Uri.parse(s);
        if (u.getHost() == null || u.getHost().isEmpty()) return null;
        if (u.getPath() == null || u.getPath().isEmpty()) s += "/";
        return s;
    }

    private void askServer(boolean first) {
        EditText field = new EditText(this);
        field.setSingleLine(true);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setImeOptions(EditorInfo.IME_ACTION_DONE);
        field.setHint("tv.example.com");
        String cur = server();
        if (cur != null) field.setText(cur);

        AlertDialog d = new AlertDialog.Builder(this)
                .setTitle("Watchening server")
                .setMessage("The address you open Watchening at, such as https://tv.example.com or http://192.168.1.20:8080")
                .setView(field)
                .setCancelable(!first)
                .setPositiveButton("Open", null)
                .setNegativeButton(first ? "Exit" : "Cancel", (x, y) -> { if (first) finish(); })
                .create();
        d.setOnShowListener(x -> d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String url = normalize(field.getText().toString());
            if (url == null) { field.setError("Enter an address"); return; }
            mPrefs.edit().putString(PREF_SERVER, url).apply();
            d.dismiss();
            mSession.loadUri(url);
        }));
        field.setOnEditorActionListener((v, id, e) -> {
            d.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            return true;
        });
        d.show();
    }

    // -------------------------------------------------------------- actions

    /** watchening-app:<action>, from the site's Settings or the error page. */
    private void appAction(String uri) {
        String action = uri.substring(SCHEME.length()).replaceFirst("^/+", "").toLowerCase(Locale.ROOT);
        Log.i(TAG, "app action " + action);
        switch (action) {
            case "reload": reload(); break;
            case "server": askServer(false); break;
            default: Log.w(TAG, "unknown app action " + action);
        }
    }

    /** Clear the network and image caches (not cookies or site storage, so
     *  sign-in and settings stay) and reload, skipping the cache. */
    private void reload() {
        Toast.makeText(this, "Clearing cache…", Toast.LENGTH_SHORT).show();
        sRuntime.getStorageController().clearData(StorageController.ClearFlags.ALL_CACHES)
                .accept(v -> reloadNow(), e -> { Log.w(TAG, "clearData failed", e); reloadNow(); });
    }

    private void reloadNow() {
        runOnUiThread(() -> mSession.reload(GeckoSession.LOAD_FLAGS_BYPASS_CACHE));
    }

    /** The remote's Back: the page's history first (the site keeps an entry
     *  there to catch Back), then press twice to leave. */
    private void back() {
        if (mCanGoBack) { mSession.goBack(); return; }
        long now = System.currentTimeMillis();
        if (now - mLastBack < 2000) { finish(); return; }
        mLastBack = now;
        Toast.makeText(this, "Press Back again to exit", Toast.LENGTH_SHORT).show();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { back(); } // Android 12 and older

    private boolean openOutside(String uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (ActivityNotFoundException | SecurityException e) {
            Log.i(TAG, "nothing opens " + uri);
            return false;
        }
    }

    // ------------------------------------------------------------ lifecycle

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemBars();
        mSession.setActive(true);
    }

    @Override
    protected void onPause() {
        mSession.setActive(false);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        mSession.close();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) hideSystemBars();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != REQ_PERMS || mPermCallback == null) return;
        PermissionDelegate.Callback cb = mPermCallback;
        mPermCallback = null;
        for (int r : results) if (r != PackageManager.PERMISSION_GRANTED) { cb.reject(); return; }
        cb.grant();
    }

    // ------------------------------------------------------------ delegates

    private boolean sameServer(String uri) {
        String s = server();
        if (s == null || uri == null) return false;
        Uri a = Uri.parse(s), b = Uri.parse(uri);
        return a.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost()) && a.getPort() == b.getPort();
    }

    private class Navigation implements NavigationDelegate {
        @Override
        public void onCanGoBack(GeckoSession session, boolean canGoBack) { mCanGoBack = canGoBack; }

        @Override
        public GeckoResult<AllowOrDeny> onLoadRequest(GeckoSession session, LoadRequest req) {
            String uri = req.uri;
            if (uri.regionMatches(true, 0, SCHEME, 0, SCHEME.length())) {
                // only our site or our error page may ask
                String from = req.triggerUri;
                if (from == null || from.startsWith("data:") || from.startsWith("about:") || sameServer(from)) {
                    runOnUiThread(() -> appAction(uri));
                } else {
                    Log.w(TAG, "ignored " + uri + " from " + from);
                }
                return GeckoResult.deny();
            }
            String lower = uri.toLowerCase(Locale.ROOT);
            boolean web = lower.startsWith("http:") || lower.startsWith("https:")
                    || lower.startsWith("data:") || lower.startsWith("about:") || lower.startsWith("blob:");
            if (!web) { // intent:, market:, mailto: ...
                runOnUiThread(() -> openOutside(uri));
                return GeckoResult.deny();
            }
            if (req.target == TARGET_WINDOW_NEW) { // window.open, target=_blank: hand it to a browser
                runOnUiThread(() -> {
                    if (!openOutside(uri)) Toast.makeText(MainActivity.this, uri, Toast.LENGTH_LONG).show();
                });
                return GeckoResult.deny();
            }
            return GeckoResult.allow();
        }

        @Override
        public GeckoResult<String> onLoadError(GeckoSession session, String uri, WebRequestError error) {
            return GeckoResult.fromValue(errorPage(uri, error));
        }
    }

    /** Shown when the server can't be reached: Retry, or change the address. */
    private static String errorPage(String uri, WebRequestError error) {
        String where = uri == null ? "" : Uri.parse(uri).getHost();
        String html = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
                + "<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;"
                + "background:#1f456b;color:#fff;font:20px sans-serif;text-align:center}"
                + "h1{font-size:28px;margin:0 0 12px}p{margin:0 24px 28px;opacity:.85}"
                + "a{display:inline-block;margin:0 10px;padding:12px 28px;border-radius:6px;background:#173f6b;color:#fff;"
                + "text-decoration:none;border:3px solid #6c7d97}a:focus{border-color:#ffd800;background:#21486f;outline:none}</style>"
                + "<h1>Can't reach Watchening</h1><p>" + escape(where) + " didn't answer (error " + error.code + ").</p>"
                + "<div><a href='watchening-app:reload' id=r>Try Again</a><a href='watchening-app:server'>Change Server</a></div>"
                + "<script>const a=[...document.querySelectorAll('a')];a[0].focus();"
                + "addEventListener('keydown',e=>{const i=a.indexOf(document.activeElement);"
                + "if(e.key==='ArrowRight'||e.key==='ArrowDown'){a[Math.min(i+1,a.length-1)].focus();e.preventDefault()}"
                + "if(e.key==='ArrowLeft'||e.key==='ArrowUp'){a[Math.max(i-1,0)].focus();e.preventDefault()}});</script>";
        return "data:text/html;base64," + Base64.encodeToString(html.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    }

    private static String escape(String s) {
        return s == null ? "" : s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private class Permissions implements PermissionDelegate {
        @Override
        public GeckoResult<Integer> onContentPermissionRequest(GeckoSession session, ContentPermission perm) {
            switch (perm.permission) {
                case PERMISSION_AUTOPLAY_AUDIBLE:     // channels start playing on their own
                case PERMISSION_AUTOPLAY_INAUDIBLE:
                case PERMISSION_MEDIA_KEY_SYSTEM_ACCESS:
                case PERMISSION_PERSISTENT_STORAGE:
                case PERMISSION_STORAGE_ACCESS:       // YouTube embeds' cookies
                case PERMISSION_LOCAL_NETWORK_ACCESS: // a server or Plex on the home network
                case PERMISSION_LOCAL_DEVICE_ACCESS:
                    return GeckoResult.fromValue(ContentPermission.VALUE_ALLOW);
                default:
                    return GeckoResult.fromValue(ContentPermission.VALUE_DENY);
            }
        }

        /** Voice search asks for the microphone. */
        @Override
        public void onMediaPermissionRequest(GeckoSession session, String uri, MediaSource[] video,
                                             MediaSource[] audio, MediaCallback callback) {
            if (audio == null || audio.length == 0 || !sameServer(uri)) { callback.reject(); return; }
            callback.grant(null, audio[0]);
        }

        @Override
        public void onAndroidPermissionsRequest(GeckoSession session, String[] perms, Callback callback) {
            if (perms == null || perms.length == 0) { callback.grant(); return; }
            if (mPermCallback != null) mPermCallback.reject();
            mPermCallback = callback;
            requestPermissions(perms, REQ_PERMS);
        }
    }

    /** A prompt's answer: the first one given wins (a button, then the dismiss that follows it). */
    private static class Answer extends GeckoResult<PromptDelegate.PromptResponse> {
        private boolean mDone;

        void give(PromptDelegate.PromptResponse r) {
            if (mDone) return;
            mDone = true;
            complete(r);
        }
    }

    /** The page's alert(), confirm() and prompt(), as TV dialogs. */
    private class Prompts implements PromptDelegate {
        @Override
        public GeckoResult<PromptResponse> onAlertPrompt(GeckoSession session, AlertPrompt p) {
            GeckoResult<PromptResponse> r = new GeckoResult<>();
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle(p.title).setMessage(p.message)
                    .setPositiveButton("OK", null)
                    .setOnDismissListener(d -> r.complete(p.dismiss()))
                    .show();
            return r;
        }

        @Override
        public GeckoResult<PromptResponse> onButtonPrompt(GeckoSession session, ButtonPrompt p) {
            Answer r = new Answer();
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle(p.title).setMessage(p.message)
                    .setPositiveButton("OK", (d, w) -> r.give(p.confirm(ButtonPrompt.Type.POSITIVE)))
                    .setNegativeButton("Cancel", (d, w) -> r.give(p.confirm(ButtonPrompt.Type.NEGATIVE)))
                    .setOnDismissListener(d -> r.give(p.dismiss()))
                    .show();
            return r;
        }

        @Override
        public GeckoResult<PromptResponse> onTextPrompt(GeckoSession session, TextPrompt p) {
            Answer r = new Answer();
            EditText field = new EditText(MainActivity.this);
            field.setSingleLine(true);
            if (p.defaultValue != null) field.setText(p.defaultValue);
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle(p.title).setMessage(p.message).setView(field)
                    .setPositiveButton("OK", (d, w) -> r.give(p.confirm(field.getText().toString())))
                    .setNegativeButton("Cancel", null)
                    .setOnDismissListener(d -> r.give(p.dismiss()))
                    .show();
            return r;
        }

        @Override
        public GeckoResult<PromptResponse> onBeforeUnloadPrompt(GeckoSession session, BeforeUnloadPrompt p) {
            return GeckoResult.fromValue(p.confirm(AllowOrDeny.ALLOW));
        }
    }
}
