package com.teamilkman.casenotes;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.SystemClock;
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
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
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
            WebView web = view(scenario); await(web, "!!window.DB && !!document.querySelector('.app-header')");
            // Synthetic data stays entirely in emulator IndexedDB; no server writes.
            eval(web, fixture());
            await(web, "window.__seeded===true");eval(web, "location.hash='#/cases/android-qa'");
            scenario.recreate();web = view(scenario);
            await(web, "!!window.DB && document.body.innerText.includes('合成离线记录')");
            assertEquals("true", eval(web, "DB.connection.offline"));
            assertEquals("true", eval(web, "location.origin==='https://" + HOST + "' && location.pathname.startsWith('/__app__/')"));
            assertEquals("true", eval(web, "document.documentElement.scrollWidth<=innerWidth"));
        }
        try (ActivityScenario<MainActivity> fresh = ActivityScenario.launch(MainActivity.class)) {
            WebView web = view(fresh);await(web, "!!window.DB && !!document.querySelector('.app-header')");
            eval(web, "location.hash='#/cases/android-qa'");await(web, "document.body.innerText.includes('合成离线记录')");
        }
    }

    private static WebView view(ActivityScenario<MainActivity> scenario) {
        AtomicReference<WebView> web = new AtomicReference<>();
        scenario.onActivity(activity -> web.set((WebView) ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0)));
        return web.get();
    }

    private static String fixture() throws Exception {
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("offline-cache-fixture.js")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();byte[] buffer = new byte[4096];int count;
            while ((count = in.read(buffer)) != -1) bytes.write(buffer, 0, count);
            return bytes.toString("UTF-8");
        }
    }

    private static String eval(WebView web, String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> web.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        assertTrue("JavaScript callback timed out", done.await(5, TimeUnit.SECONDS));return result.get();
    }

    private static void await(WebView web, String expression) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 15000;
        while (SystemClock.elapsedRealtime() < deadline) { if ("true".equals(eval(web, expression))) return; Thread.sleep(50); }
        fail("Offline page did not become ready: " + expression + "; " + eval(web,
            "JSON.stringify({url:location.href,seedError:window.__seedError,secure:isSecureContext,body:document.body.innerText.slice(0,600)})"));
    }
}
