package com.teamilkman.casenotes;

import android.net.Uri;
import android.webkit.WebResourceResponse;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** The APK serves its own shell offline for the configured host and leaves private routes on the network. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class BundledShellTest {

    private static final String HOST = "shell.test";
    private static final String HOME = "https://" + HOST + BundledShell.PREFIX;

    private static BundledShell shell() {
        return new BundledShell(RuntimeEnvironment.getApplication().getAssets(), HOST);
    }

    private static String body(WebResourceResponse response) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = response.getData()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
        }
        return out.toString("UTF-8");
    }

    @Test
    public void servesPackagedDocumentsAndAssetsFromTheApk() throws Exception {
        BundledShell shell = shell();
        assertEquals(HOME, shell.home());
        WebResourceResponse home = shell.intercept(Uri.parse(HOME), "GET");
        assertNotNull(home);
        assertEquals(200, home.getStatusCode());
        assertEquals("text/html", home.getMimeType());
        assertTrue(body(home).toLowerCase().contains("<!doctype html"));
        WebResourceResponse module = shell.intercept(Uri.parse(HOME + "web/vendor/dexie.mjs"), "GET");
        assertNotNull(module);
        assertEquals("text/javascript", module.getMimeType());
    }

    @Test
    public void privateRoutesForeignHostsAndWritesStayOnTheNetwork() {
        BundledShell shell = shell();
        for (String url : new String[]{
                "https://" + HOST + "/api/session",
                "https://" + HOST + "/api/web/save-notes",
                "https://" + HOST + "/mcp",
                "https://" + HOST + "/health",
                "http://" + HOST + BundledShell.PREFIX + "index.html",
                "https://" + HOST + ":8443" + BundledShell.PREFIX + "index.html",
                "https://other.test" + BundledShell.PREFIX + "index.html"}) {
            assertNull(url, shell.intercept(Uri.parse(url), "GET"));
        }
        assertNull(shell.intercept(Uri.parse(HOME + "index.html"), "POST"));
    }

    @Test
    public void unlistedPathsNeverEscapeTheBundledManifest() {
        BundledShell shell = shell();
        WebResourceResponse unknown = shell.intercept(Uri.parse(HOME + "missing.js"), "GET");
        assertNotNull(unknown);
        assertEquals(404, unknown.getStatusCode());
        assertEquals(404, shell.intercept(Uri.parse(HOME + "../api/session"), "GET").getStatusCode());
    }

    @Test
    public void configuredAddressAcceptsAPastedUrlAndRejectsJunk() {
        assertEquals("example.com", MainActivity.normalizeHost("  Example.COM  "));
        assertEquals("example.com", MainActivity.normalizeHost("https://example.com/__app__/"));
        assertEquals("example.com", MainActivity.normalizeHost("example.com:8443"));
        assertNull(MainActivity.normalizeHost(""));
        assertNull(MainActivity.normalizeHost("https://"));
        assertNull(MainActivity.normalizeHost("localhost"));
        assertNull(MainActivity.normalizeHost("bad host"));
    }
}
