package io.github.slophobbyist.watchening;

import android.util.Log;

import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.WebExtension;
import org.mozilla.geckoview.WebExtensionController;

/**
 * Browser extensions the app installs from addons.mozilla.org on first launch
 * (and again on any launch where they're missing), then keeps up to date.
 * AMO's files are signed by Mozilla, which GeckoView requires.
 *
 * Control Panel for YouTube (https://github.com/insin/control-panel-for-youtube)
 * cleans up the YouTube players that YouTube channels play in.
 */
final class Extensions {
    private static final String TAG = "Watchening";

    private static final String[][] WANTED = {
            // { extension id, AMO download address }
            { "control-panel-for-youtube@jbscript.dev",
              "https://addons.mozilla.org/firefox/downloads/latest/control-panel-for-youtube/latest.xpi" },
    };

    private Extensions() {}

    /** Install what's missing and update the rest; onInstalled runs after a fresh install. */
    static void ensure(GeckoRuntime runtime, Runnable onInstalled) {
        WebExtensionController c = runtime.getWebExtensionController();
        // no one to ask on a TV: accept the extensions' (fixed, known) permissions
        c.setPromptDelegate(new WebExtensionController.PromptDelegate() {
            @Override
            public GeckoResult<WebExtension.PermissionPromptResponse> onInstallPromptRequest(
                    WebExtension ext, String[] perms, String[] origins, String[] dataPerms) {
                boolean ours = false;
                for (String[] w : WANTED) ours |= w[0].equals(ext.id);
                return GeckoResult.fromValue(new WebExtension.PermissionPromptResponse(ours, false, false));
            }

            @Override
            public GeckoResult<AllowOrDeny> onUpdatePrompt(
                    WebExtension ext, String[] perms, String[] origins, String[] dataPerms) {
                return GeckoResult.allow();
            }
        });

        c.list().accept(list -> {
            for (String[] w : WANTED) {
                WebExtension have = null;
                if (list != null) for (WebExtension e : list) if (w[0].equals(e.id)) have = e;
                if (have == null) {
                    Log.i(TAG, "installing " + w[0]);
                    c.install(w[1]).accept(
                            e -> { Log.i(TAG, "installed " + e.id + " " + e.metaData.version); onInstalled.run(); },
                            err -> Log.w(TAG, "couldn't install " + w[0] + " (tries again next launch)", err));
                } else {
                    c.update(have).accept(
                            e -> { if (e != null) Log.i(TAG, "updated " + e.id + " to " + e.metaData.version); },
                            err -> Log.w(TAG, "couldn't update " + w[0], err));
                }
            }
        }, err -> Log.w(TAG, "couldn't list extensions", err));
    }
}
