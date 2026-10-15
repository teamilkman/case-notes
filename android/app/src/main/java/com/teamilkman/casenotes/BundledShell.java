package com.teamilkman.casenotes;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * APK-owned public resources: no network or clock dependency, no private responses.
 * The host is configured on the device, so the APK itself carries no server address.
 */
final class BundledShell {
    static final String PREFIX = "/__app__/";
    private final AssetManager assets;
    private final String host;
    private final Set<String> files = new HashSet<>();

    BundledShell(AssetManager assets, String host) {
        this.assets = assets;
        this.host = host;
        try (InputStream in = assets.open("shell/shell-files.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096]; int count;
            while ((count = in.read(buffer)) != -1) bytes.write(buffer, 0, count);
            JSONArray manifest = new JSONArray(bytes.toString("UTF-8"));
            for (int i = 0; i < manifest.length(); i++) files.add(manifest.getString(i));
        } catch (Exception error) {
            throw new IllegalStateException("APK is missing its public shell", error);
        }
    }

    String host() { return host; }

    /** Absolute URL of the bundled document for the configured host. */
    String home() { return "https://" + host + PREFIX; }

    boolean sameOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && host.equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    WebResourceResponse intercept(Uri uri, String method) {
        if (!"GET".equals(method) || !sameOrigin(uri)) return null;
        String path = uri.getPath();
        if (path == null || !path.startsWith(PREFIX)) return null;
        String file = path.substring(PREFIX.length());
        if (file.isEmpty()) file = "index.html";
        if (!files.contains(file)) return missing();
        try {
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
            return new WebResourceResponse(mime(file), "UTF-8", 200, "OK", headers, assets.open("shell/" + file));
        } catch (IOException error) { return missing(); }
    }

    private static WebResourceResponse missing() {
        byte[] bytes = "应用资源缺失，请更新应用。".getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, new ByteArrayInputStream(bytes));
    }

    private static String mime(String file) {
        if (file.endsWith(".html")) return "text/html";
        if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript";
        if (file.endsWith(".css")) return "text/css";
        if (file.endsWith(".svg")) return "image/svg+xml";
        if (file.endsWith(".png")) return "image/png";
        if (file.endsWith(".ico")) return "image/x-icon";
        if (file.endsWith(".webmanifest")) return "application/manifest+json";
        return "application/octet-stream";
    }
}
