package com.teamilkman.casenotes;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/** The packaged shell only needs the device-configured address; no server is reachable here. */
@RunWith(AndroidJUnit4.class)
public class OfflineShellTest {

    private static final String HOST = "shell.test";

    @Test public void offlineColdStartAndActivityRecreationDisplayShellAndPersistedCopies() throws Exception {
        ConnectivityManager network = ApplicationProvider.getApplicationContext().getSystemService(ConnectivityManager.class);
        assertNull("Run this test with all emulator networks disabled", network.getActiveNetwork());
        // First run only asks for the server address; the shell it serves comes from the APK.
        SharedPreferences preferences = ApplicationProvider.getApplicationContext()
            .getSharedPreferences("case-notes", Context.MODE_PRIVATE);
        assertTrue(preferences.edit().putString("shell-host", HOST).commit());
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            WebView web = awaitShell(scenario);
            awaitCondition(web, "!!window.DB && !!document.querySelector('.app-header')");
            // Synthetic data stays entirely in emulator IndexedDB; no server writes.
            eval(web, fixture());
            awaitCondition(web, "window.__seeded===true");
            eval(web, "location.hash='#/cases/android-qa'");
            // A recreated activity must show the same offline copy, not a blank page.
            scenario.recreate();
            web = awaitShell(scenario);
            awaitCondition(web, "!!window.DB && document.body.innerText.includes('合成离线记录')");
            assertEquals("true", eval(web, "DB.connection.offline"));
            assertEquals("true", eval(web, "location.origin==='https://" + HOST + "' && location.pathname.startsWith('/__app__/')"));
            assertEquals("true", eval(web, "document.documentElement.scrollWidth<=innerWidth"));
        }
    }

    private static WebView view(ActivityScenario<MainActivity> scenario) {
        AtomicReference<WebView> web = new AtomicReference<>(null);
        scenario.onActivity(activity -> {
            View child = ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
            web.set(child instanceof WebView ? (WebView) child : null);
        });
        return web.get();
    }

    private static int progress(WebView web) {
        AtomicInteger value = new AtomicInteger(-1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try { value.set(web.getProgress()); } catch (Throwable ignored) { }
        });
        return value.get();
    }

    /**
     * Waits for the shell document without touching the renderer, re-reading the activity's
     * current WebView because renderer recovery and recreation both replace it.
     */
    private static WebView awaitShell(ActivityScenario<MainActivity> scenario) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 120000;
        WebView web = null;
        while (SystemClock.elapsedRealtime() < deadline) {
            web = view(scenario);
            if (web != null && progress(web) == 100) return web;
            Thread.sleep(250);
        }
        fail("Shell document never finished loading (webview=" + (web != null) + ", progress=" + (web == null ? -1 : progress(web)) + ")");
        return null;
    }

    private static String fixture() throws Exception {
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("offline-cache-fixture.js")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();byte[] buffer = new byte[4096];int count;
            while ((count = in.read(buffer)) != -1) bytes.write(buffer, 0, count);
            return bytes.toString("UTF-8");
        }
    }

    private static void awaitCondition(WebView web, String expression) throws Exception {
        // This guest renders slowly and the whole check runs offline, so allow a long budget.
        long deadline = SystemClock.elapsedRealtime() + 90000;
        while (true) {
            if ("true".equals(eval(web, expression))) return;
            if (SystemClock.elapsedRealtime() > deadline) {
                fail("Offline page condition never held: " + expression + "; " + eval(web,
                    "JSON.stringify({url:location.href,ready:document.readyState,seedError:window.__seedError," +
                    "logged:typeof window.DB,body:document.body.innerText.slice(0,400)})"));
            }
            Thread.sleep(250);
        }
    }

    /** A missing callback means the renderer is wedged; fail here instead of queuing more work. */
    private static String eval(WebView web, String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>(null); CountDownLatch done = new CountDownLatch(1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> web.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        if (!done.await(30, TimeUnit.SECONDS)) fail("JavaScript callback timed out for: " + script.substring(0, Math.min(60, script.length())));
        return result.get();
    }
}
