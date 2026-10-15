package com.teamilkman.casenotes;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.text.InputType;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

/**
 * A permanent APK shell on a locally configured HTTPS origin; only API requests use the
 * network. The server address is entered on the device and stored there, so the packaged
 * app carries no deployment address.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "case-notes";
    private static final String KEY_HOST = "shell-host";
    private static final String SAVED_URL = "case-notes:url";

    private WebView web;
    private String host;
    private String lastUrl;
    private boolean backPending;
    private long exitBackAt;
    private Toast exitToast;
    private OnBackInvokedCallback systemBack;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33) {
            systemBack = this::handleBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, systemBack);
        }
        host = storedHost();
        if (host == null) showSetup("请输入你自己的服务器域名，例如 example.com。地址只保存在本机，应用内不含任何服务器地址。");
        else showShell(savedInstanceState);
    }

    private SharedPreferences prefs() { return getSharedPreferences(PREFS, MODE_PRIVATE); }

    private String storedHost() {
        String value = prefs().getString(KEY_HOST, "");
        return value == null || value.isEmpty() ? null : value;
    }

    private void showShell(Bundle savedInstanceState) {
        web = new WebView(this);
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        final BundledShell shell = new BundledShell(getAssets(), host);
        // An older root Service Worker may still control this origin. Its network
        // fetches must also resolve the APK namespace without an internet connection.
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return shell.intercept(request.getUrl(), request.getMethod());
            }
        });

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return shell.intercept(request.getUrl(), request.getMethod());
            }
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                lastUrl = url;
                resetExit();
            }
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                // A crashed renderer (memory pressure, driver faults) would otherwise take the
                // whole application down. Drop the dead WebView and rebuild the shell in place.
                if (view != web) return true;
                ViewParent parent = view.getParent();
                if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(view);
                view.destroy();
                web = null;
                runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) showShell(null); });
                return true;
            }
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // The bundled document is served from the APK, so a main-frame failure means
                // the configured address is wrong or unreachable.
                if (request != null && request.isForMainFrame()) showError();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(Uri.parse(url));
            }
        });
        web.setWebChromeClient(new WebChromeClient());

        // restoreState restores history, not display data. Always load the APK
        // document after process recreation, preserving its hash route when possible.
        String savedUrl = savedInstanceState == null ? lastUrl : savedInstanceState.getString(SAVED_URL);
        Uri saved = savedUrl == null ? null : Uri.parse(savedUrl);
        web.loadUrl(saved != null && shell.sameOrigin(saved) && saved.getPath() != null
            && saved.getPath().startsWith(BundledShell.PREFIX) ? savedUrl : shell.home());
    }

    private void showSetup(String message) {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setPadding(56, 120, 56, 56);

        TextView title = new TextView(this);
        title.setText("设置服务器地址");
        title.setTextSize(20f);
        view.addView(title);

        TextView help = new TextView(this);
        help.setText(message);
        help.setTextSize(14f);
        help.setPadding(0, 28, 0, 12);
        view.addView(help);

        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        String current = storedHost();
        if (current != null) input.setText(current);
        view.addView(input);

        Button save = new Button(this);
        save.setText("保存并打开");
        save.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View button) {
                String value = normalizeHost(input.getText().toString());
                if (value == null) { input.setError("请填写正确的域名，例如 example.com"); return; }
                prefs().edit().putString(KEY_HOST, value).apply();
                recreate();
            }
        });
        view.addView(save);

        setContentView(view);
        input.requestFocus();
    }

    private void showError() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setPadding(56, 120, 56, 56);

        TextView title = new TextView(this);
        title.setText("无法打开页面");
        title.setTextSize(20f);
        view.addView(title);

        TextView help = new TextView(this);
        help.setText("无法连接到 " + host + "，请检查域名或网络后重试。");
        help.setTextSize(14f);
        help.setPadding(0, 28, 0, 12);
        view.addView(help);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View button) { recreate(); }
        });
        view.addView(retry);

        Button reset = new Button(this);
        reset.setText("重新设置服务器地址");
        reset.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View button) { showSetup("请输入服务器域名，例如 example.com。"); }
        });
        view.addView(reset);

        setContentView(view);
    }

    /** Accepts a bare host or a pasted URL and returns a hostname, or null when unusable. */
    static String normalizeHost(String raw) {
        if (raw == null) return null;
        String value = raw.trim().toLowerCase();
        if (value.startsWith("https://")) value = value.substring(8);
        else if (value.startsWith("http://")) value = value.substring(7);
        int cut = value.indexOf('/');
        if (cut >= 0) value = value.substring(0, cut);
        cut = value.indexOf(':');
        if (cut >= 0) value = value.substring(0, cut);
        if (value.isEmpty() || value.length() > 253 || value.startsWith(".") || value.endsWith(".")
                || !value.contains(".") || !value.matches("[a-z0-9.-]+")) return null;
        return value;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) outState.putString(SAVED_URL, web.getUrl());
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (backPending) return;
        if (web == null || web.getUrl() == null) { confirmExit(); return; }
        Uri current = Uri.parse(web.getUrl());
        if (host == null || !host.equals(current.getHost())) { confirmExit(); return; }
        backPending = true;
        // No privileged JS bridge: ask the same page hierarchy used by touch and buttons.
        web.evaluateJavascript("window.CaseNotesNavigation ? (window.CaseNotesNavigation.back() ? 'handled' : 'root') : 'unavailable'", result -> {
            backPending = false;
            if (web == null || isFinishing() || isDestroyed()) return;
            if ("\"handled\"".equals(result)) { resetExit(); return; }
            if ("\"root\"".equals(result)) { confirmExit(); return; }
            // While the page initializes, return a child URL to the dashboard.
            String fragment = Uri.parse(web.getUrl() == null ? "" : web.getUrl()).getFragment();
            if (fragment != null && (fragment.startsWith("/cases") || fragment.startsWith("/calendar"))) {
                resetExit();
                web.loadUrl("https://" + host + BundledShell.PREFIX);
            } else confirmExit();
        });
    }

    private boolean handleUrl(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return true;
        if (host != null && host.equals(uri.getHost())) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
        }
        return true;
    }

    private void confirmExit() {
        if (isFinishing() || isDestroyed()) return;
        long now = SystemClock.elapsedRealtime();
        if (exitBackAt != 0 && now - exitBackAt <= 2000) {
            resetExit();
            finish();
            return;
        }
        exitBackAt = now;
        if (exitToast != null) exitToast.cancel();
        exitToast = Toast.makeText(this, "再按一次返回退出", Toast.LENGTH_SHORT);
        exitToast.show();
    }

    private void resetExit() {
        exitBackAt = 0;
        if (exitToast != null) { exitToast.cancel(); exitToast = null; }
    }

    @Override
    protected void onPause() {
        resetExit();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && systemBack != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(systemBack);
        }
        resetExit();
        if (web != null) {
            // Detach before destroying so a recreated Activity starts with no
            // attached renderer left behind by the previous WebView.
            ViewParent parent = web.getParent();
            if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
