package com.gemini.klipperraker;

import android.app.Activity;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

public class MainActivity extends Activity {
    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private static final int FILE_CHOOSER_REQUEST_CODE = 101;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        SharedPreferences prefs = getSharedPreferences("klipper_prefs", Context.MODE_PRIVATE);
        LocalBridgeServer.socksPort = prefs.getInt("socks_port", 25344);
        LocalBridgeServer.ensureStarted();
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        Window window = getWindow();
        if (window != null) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                window.setStatusBarColor(Color.parseColor("#0B1120"));
                window.setNavigationBarColor(Color.parseColor("#0B1120"));
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0B1120"));
        webView.setFitsSystemWindows(true);
        setContentView(webView);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setAllowFileAccessFromFileURLs(true);
        ws.setAllowUniversalAccessFromFileURLs(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setTextZoom(100);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.addJavascriptInterface(new NativeBridge(this), "AndroidBridge");

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                enqueueNativeDownload(url, "timelapse_" + System.currentTimeMillis() + ".mp4");
            }
        });

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage consoleMessage) {
                android.util.Log.e("KlipperConsole", consoleMessage.message() + " -- From line "
                                   + consoleMessage.lineNumber() + " of "
                                   + consoleMessage.sourceId());
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        request.grant(request.getResources());
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "Select G-Code File"), FILE_CHOOSER_REQUEST_CODE);
                } catch (Exception e) {
                    MainActivity.this.filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.loadUrl("file:///android_asset/index.html");

        setupNetworkMonitoring();

        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.cancel(1001);
            }
        } catch (Exception ignored) {}
    }

    private android.net.ConnectivityManager.NetworkCallback networkCallback;
    private long lastNetworkNotify = 0;
    private volatile boolean lastKnownWifi = false;

    private void setupNetworkMonitoring() {
        lastKnownWifi = isWifiConnectedInternal(this);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                final android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm == null) return;

                // Listen specifically to Wi-Fi transport availability and loss.
                // Do NOT listen to onCapabilitiesChanged on default network, which triggers on signal fluctuations and AdGuard tunnels.
                android.net.NetworkRequest wifiReq = new android.net.NetworkRequest.Builder()
                        .addTransportType(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                        .build();

                networkCallback = new android.net.ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(android.net.Network network) {
                        checkAndNotifyNetworkChange();
                    }

                    @Override
                    public void onLost(android.net.Network network) {
                        checkAndNotifyNetworkChange();
                    }
                };
                cm.registerNetworkCallback(wifiReq, networkCallback);
            } catch (Exception ignored) {
            }
        }
    }

    private synchronized void checkAndNotifyNetworkChange() {
        boolean currentWifi = isWifiConnectedInternal(this);
        if (currentWifi == lastKnownWifi) {
            return; // Mode has not actually changed, ignore transient signal/routing updates.
        }
        lastKnownWifi = currentWifi;
        long now = System.currentTimeMillis();
        if (now - lastNetworkNotify < 1500) return;
        lastNetworkNotify = now;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView != null) {
                    webView.evaluateJavascript("window.onNetworkStateChanged && window.onNetworkStateChanged();", null);
                }
            }
        });
    }

    public static boolean isWifiConnectedInternal(Context ctx) {
        try {
            if (ctx == null) return false;
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;

            // 1. Android Auto & Cellular Priority Check:
            // When Wireless Android Auto is active, the phone connects to the car's Wi-Fi radio (which has NO internet).
            // Android simultaneously routes all internet traffic over Cellular (TRANSPORT_CELLULAR).
            // If the primary active network is Cellular, we are in Remote / Cellular mode!
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                android.net.Network activeNet = cm.getActiveNetwork();
                if (activeNet != null) {
                    android.net.NetworkCapabilities caps = cm.getNetworkCapabilities(activeNet);
                    if (caps != null) {
                        if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) &&
                            !caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) {
                            return false;
                        }
                    }
                }
            }

            // 2. Check if there is an active Wi-Fi connection with Internet capability.
            // Android Auto Wi-Fi does NOT have NET_CAPABILITY_INTERNET or NET_CAPABILITY_VALIDATED.
            boolean hasInternetWifi = false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                android.net.Network activeNet = cm.getActiveNetwork();
                if (activeNet != null) {
                    android.net.NetworkCapabilities caps = cm.getNetworkCapabilities(activeNet);
                    if (caps != null && caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) &&
                        caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                        hasInternetWifi = true;
                    }
                }
            } else {
                android.net.NetworkInfo activeInfo = cm.getActiveNetworkInfo();
                if (activeInfo != null && activeInfo.isConnected() && activeInfo.getType() == android.net.ConnectivityManager.TYPE_WIFI) {
                    hasInternetWifi = true;
                }
            }

            if (!hasInternetWifi) {
                return false;
            }

            // 3. We are on a Wi-Fi network with internet. Now verify if it is our Home Subnet (192.168.1.0/24)
            for (java.util.Enumeration<java.net.NetworkInterface> en = java.net.NetworkInterface.getNetworkInterfaces(); en != null && en.hasMoreElements(); ) {
                java.net.NetworkInterface intf = en.nextElement();
                String name = intf.getName().toLowerCase();
                if (name.startsWith("wlan") || name.startsWith("eth") || name.startsWith("wifi")) {
                    for (java.util.Enumeration<java.net.InetAddress> enumIp = intf.getInetAddresses(); enumIp.hasMoreElements(); ) {
                        java.net.InetAddress addr = enumIp.nextElement();
                        if (!addr.isLoopbackAddress() && addr instanceof java.net.Inet4Address) {
                            String host = addr.getHostAddress();
                            if (host != null && host.startsWith("192.168.1.")) {
                                return true;
                            }
                        }
                    }
                }
            }

            return false;
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.evaluateJavascript("window.onAppBackground && window.onAppBackground();", null);
            webView.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.evaluateJavascript("window.onAppForeground && window.onAppForeground();", null);
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (networkCallback != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {}
        }
    }

    private void startMonitorService() {
        try {
            Intent svc = new Intent(this, PrintMonitorService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(svc);
            } else {
                startService(svc);
            }
        } catch (Exception ignored) {
        }
    }

    private void stopMonitorService() {
        try {
            Intent svc = new Intent(this, PrintMonitorService.class);
            svc.setAction("STOP");
            startService(svc);
        } catch (Exception ignored) {
        }
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.cancel(1001);
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    private long lastBackPressTime = 0;

    @Override
    public void onBackPressed() {
        if (webView != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            webView.evaluateJavascript("(function(){ return window.handleAndroidBack ? window.handleAndroidBack() : 'NONE'; })()", new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if (value != null && value.contains("HANDLED")) {
                        return;
                    }
                    long now = System.currentTimeMillis();
                    if (now - lastBackPressTime < 2000) {
                        MainActivity.super.onBackPressed();
                    } else {
                        lastBackPressTime = now;
                        Toast.makeText(MainActivity.this, "Swipe back again to exit Klipperraker Pro", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        } else {
            super.onBackPressed();
        }
    }

    private final java.util.concurrent.ExecutorService httpExecutor = java.util.concurrent.Executors.newCachedThreadPool();

    public class NativeBridge {
        private final Context ctx;

        NativeBridge(Context c) {
            this.ctx = c;
        }

        @JavascriptInterface
        public void nativeHttpAsync(final String reqId, final String method, final String urlStr, final String headersJson, final String postBody) {
            httpExecutor.execute(new Runnable() {
                @Override
                public void run() {
                    final String res = nativeHttp(method, urlStr, headersJson, postBody);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (webView != null) {
                                String script = "window.__onNativeHttpResult && window.__onNativeHttpResult("
                                        + org.json.JSONObject.quote(reqId) + ", "
                                        + org.json.JSONObject.quote(res) + ");";
                                webView.evaluateJavascript(script, null);
                            }
                        }
                    });
                }
            });
        }

        @JavascriptInterface
        public void fetchImageBase64Async(final String reqId, final String urlStr) {
            httpExecutor.execute(new Runnable() {
                @Override
                public void run() {
                    final String res = fetchImageBase64(urlStr);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (webView != null) {
                                String script = "window.__onNativeImageResult && window.__onNativeImageResult("
                                        + org.json.JSONObject.quote(reqId) + ", "
                                        + org.json.JSONObject.quote(res) + ");";
                                webView.evaluateJavascript(script, null);
                            }
                        }
                    });
                }
            });
        }

        @JavascriptInterface
        public boolean isWifiConnected() {
            return isWifiConnectedInternal(ctx);
        }

        private String executeHttpRequest(String method, String urlStr, String headersJson, String postBody, java.net.Proxy proxy, int timeoutMs) {
            try {
                java.net.URL url = new java.net.URL(urlStr);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection(proxy);
                conn.setRequestMethod(method != null ? method.toUpperCase() : "GET");
                conn.setConnectTimeout(timeoutMs);
                conn.setReadTimeout(timeoutMs + 4000);
                conn.setDoInput(true);
                if (headersJson != null && !headersJson.trim().isEmpty()) {
                    org.json.JSONObject hdrs = new org.json.JSONObject(headersJson);
                    java.util.Iterator<String> keys = hdrs.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        conn.setRequestProperty(k, hdrs.getString(k));
                    }
                }
                if (postBody != null && !postBody.isEmpty()) {
                    conn.setDoOutput(true);
                    java.io.OutputStream os = conn.getOutputStream();
                    os.write(postBody.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    os.flush();
                    os.close();
                }
                int code = conn.getResponseCode();
                java.io.InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
                String responseBody = "";
                if (is != null) {
                    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) != -1) {
                        baos.write(buf, 0, n);
                    }
                    responseBody = baos.toString("UTF-8");
                    is.close();
                }
                org.json.JSONObject out = new org.json.JSONObject();
                out.put("status", code);
                out.put("body", responseBody);
                return out.toString();
            } catch (Exception e) {
                try {
                    org.json.JSONObject err = new org.json.JSONObject();
                    err.put("status", 0);
                    err.put("error", e.getMessage() != null ? e.getMessage() : e.toString());
                    return err.toString();
                } catch (Exception ignored) {
                    return "{\"status\":0,\"error\":\"unknown\"}";
                }
            }
        }

        @JavascriptInterface
        public String nativeHttp(String method, String urlStr, String headersJson, String postBody) {
            boolean isWifi = isWifiConnected();
            java.net.Proxy proxy = isWifi ? java.net.Proxy.NO_PROXY : new java.net.Proxy(java.net.Proxy.Type.SOCKS, new java.net.InetSocketAddress("127.0.0.1", LocalBridgeServer.socksPort));
            String res = executeHttpRequest(method, urlStr, headersJson, postBody, proxy, isWifi ? 3000 : 8000);

            // Resilient fallback: If direct connection failed while on Wi-Fi (e.g. Android Auto or foreign Wi-Fi),
            // immediately retry through the local WireGuard SOCKS proxy!
            if (isWifi && (res == null || res.contains("\"status\":0"))) {
                java.net.Proxy socksProxy = new java.net.Proxy(java.net.Proxy.Type.SOCKS, new java.net.InetSocketAddress("127.0.0.1", LocalBridgeServer.socksPort));
                String fallbackRes = executeHttpRequest(method, urlStr, headersJson, postBody, socksProxy, 8000);
                if (fallbackRes != null && !fallbackRes.contains("\"status\":0")) {
                    return fallbackRes;
                }
            }
            return res;
        }

        private String executeFetchImage(String urlStr, java.net.Proxy proxy, int timeoutMs) {
            try {
                java.net.URL url = new java.net.URL(urlStr);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection(proxy);
                conn.setConnectTimeout(timeoutMs);
                conn.setReadTimeout(timeoutMs + 2000);
                int code = conn.getResponseCode();
                if (code == 200) {
                    java.io.InputStream is = conn.getInputStream();
                    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) != -1) {
                        baos.write(buf, 0, n);
                    }
                    is.close();
                    String b64 = android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP);
                    return "data:image/jpeg;base64," + b64;
                }
            } catch (Exception ignored) {}
            return "";
        }

        @JavascriptInterface
        public String fetchImageBase64(String urlStr) {
            boolean isWifi = isWifiConnected();
            java.net.Proxy proxy = isWifi ? java.net.Proxy.NO_PROXY : new java.net.Proxy(java.net.Proxy.Type.SOCKS, new java.net.InetSocketAddress("127.0.0.1", LocalBridgeServer.socksPort));
            String res = executeFetchImage(urlStr, proxy, isWifi ? 2500 : 6000);
            if (isWifi && (res == null || res.isEmpty())) {
                java.net.Proxy socksProxy = new java.net.Proxy(java.net.Proxy.Type.SOCKS, new java.net.InetSocketAddress("127.0.0.1", LocalBridgeServer.socksPort));
                return executeFetchImage(urlStr, socksProxy, 6000);
            }
            return res;
        }

        @JavascriptInterface
        public String getPrintersJson() {
            SharedPreferences prefs = ctx.getSharedPreferences("klipper_prefs", Context.MODE_PRIVATE);
            return prefs.getString("printers_json", "");
        }

        @JavascriptInterface
        public void savePrintersJson(String json) {
            SharedPreferences prefs = ctx.getSharedPreferences("klipper_prefs", Context.MODE_PRIVATE);
            prefs.edit().putString("printers_json", json).apply();
        }

        @JavascriptInterface
        public boolean isBackgroundMonitorEnabled() {
            SharedPreferences prefs = ctx.getSharedPreferences("klipper_prefs", Context.MODE_PRIVATE);
            return prefs.getBoolean("bg_monitor", true);
        }

        @JavascriptInterface
        public void setBackgroundMonitorEnabled(boolean enabled) {
            SharedPreferences prefs = ctx.getSharedPreferences("klipper_prefs", Context.MODE_PRIVATE);
            prefs.edit().putBoolean("bg_monitor", enabled).apply();
            if (enabled) {
                startMonitorService();
            } else {
                stopMonitorService();
            }
        }

        @JavascriptInterface
        public void setPrintActive(final boolean active) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    SharedPreferences prefs = ctx.getSharedPreferences("klipper_prefs", Context.MODE_PRIVATE);
                    if (!prefs.getBoolean("bg_monitor", true)) {
                        stopMonitorService();
                        return;
                    }
                    if (active) {
                        startMonitorService();
                    } else {
                        stopMonitorService();
                    }
                }
            });
        }

        @JavascriptInterface
        public void setKeepScreenOn(final boolean keepOn) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (keepOn) {
                        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    } else {
                        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                }
            });
        }

        @JavascriptInterface
        public void sendLocalNotification(String title, String body) {
            try {
                NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm == null) return;
                String chId = "klipper_alert_channel";
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    NotificationChannel ch = new NotificationChannel(chId, "Print Status Alerts", NotificationManager.IMPORTANCE_HIGH);
                    nm.createNotificationChannel(ch);
                }
                Intent i = new Intent(ctx, MainActivity.class);
                PendingIntent pi = PendingIntent.getActivity(ctx, 2, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? new Notification.Builder(ctx, chId)
                        : new Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH);
                b.setContentTitle(title)
                 .setContentText(body)
                 .setSmallIcon(android.R.drawable.ic_dialog_info)
                 .setContentIntent(pi)
                 .setAutoCancel(true);
                nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void showToast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void downloadFile(final String url, final String fileName) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    enqueueNativeDownload(url, fileName);
                }
            });
        }

        @JavascriptInterface
        public String getAppVersionInfo() {
            try {
                android.content.pm.PackageInfo pInfo = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
                org.json.JSONObject obj = new org.json.JSONObject();
                long vCode = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) ? pInfo.getLongVersionCode() : pInfo.versionCode;
                obj.put("versionCode", vCode);
                obj.put("versionName", pInfo.versionName != null ? pInfo.versionName : "1.0.0");
                return obj.toString();
            } catch (Exception e) {
                return "{\"versionCode\":1,\"versionName\":\"1.0.0\"}";
            }
        }

        @JavascriptInterface
        public void downloadAndInstallApk(final String downloadUrl, final String callbackId) {
            httpExecutor.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        java.net.URL url = new java.net.URL(downloadUrl);
                        java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                        conn.setInstanceFollowRedirects(true);
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(30000);
                        conn.setRequestProperty("User-Agent", "Klipperraker-Pro-Updater");

                        int status = conn.getResponseCode();
                        if (status == java.net.HttpURLConnection.HTTP_MOVED_TEMP || status == java.net.HttpURLConnection.HTTP_MOVED_PERM || status == 307 || status == 308) {
                            String newUrl = conn.getHeaderField("Location");
                            conn.disconnect();
                            url = new java.net.URL(newUrl);
                            conn = (java.net.HttpURLConnection) url.openConnection();
                            conn.setConnectTimeout(15000);
                            conn.setReadTimeout(30000);
                            conn.setRequestProperty("User-Agent", "Klipperraker-Pro-Updater");
                            status = conn.getResponseCode();
                        }

                        if (status < 200 || status >= 400) {
                            notifyUpdateProgress(callbackId, 0, 0, 0, "HTTP Error " + status);
                            return;
                        }

                        long totalBytes = conn.getContentLength();
                        java.io.InputStream in = conn.getInputStream();
                        java.io.File outFile = new java.io.File(ctx.getCacheDir(), "update.apk");
                        java.io.FileOutputStream out = new java.io.FileOutputStream(outFile);

                        byte[] buffer = new byte[16384];
                        long downloaded = 0;
                        int read;
                        long lastReport = 0;

                        while ((read = in.read(buffer)) != -1) {
                            out.write(buffer, 0, read);
                            downloaded += read;
                            long now = System.currentTimeMillis();
                            if (now - lastReport > 250 || downloaded == totalBytes) {
                                lastReport = now;
                                int pct = (totalBytes > 0) ? (int) ((downloaded * 100) / totalBytes) : -1;
                                notifyUpdateProgress(callbackId, downloaded, totalBytes, pct, "DOWNLOADING");
                            }
                        }

                        out.flush();
                        out.close();
                        in.close();
                        conn.disconnect();

                        notifyUpdateProgress(callbackId, downloaded, totalBytes, 100, "READY");
                        triggerInstallApk(callbackId);

                    } catch (final Exception e) {
                        notifyUpdateProgress(callbackId, 0, 0, 0, "ERROR: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
                    }
                }
            });
        }

        @JavascriptInterface
        public void triggerInstallApk(final String callbackId) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        java.io.File apkFile = new java.io.File(ctx.getCacheDir(), "update.apk");
                        if (!apkFile.exists()) {
                            notifyUpdateProgress(callbackId, 0, 0, 0, "ERROR: update.apk not found");
                            return;
                        }

                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            if (!ctx.getPackageManager().canRequestPackageInstalls()) {
                                Intent allowIntent = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                                allowIntent.setData(Uri.parse("package:" + ctx.getPackageName()));
                                allowIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                ctx.startActivity(allowIntent);
                                notifyUpdateProgress(callbackId, 100, 100, 100, "PERMISSION_REQUIRED");
                                return;
                            }
                        }

                        Intent intent = new Intent(Intent.ACTION_VIEW);
                        Uri apkUri = Uri.parse("content://" + ApkProvider.AUTHORITY + "/update.apk");
                        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        ctx.startActivity(intent);

                        notifyUpdateProgress(callbackId, 100, 100, 100, "INSTALLING");
                    } catch (Exception e) {
                        notifyUpdateProgress(callbackId, 0, 0, 0, "INSTALL_FAILED: " + e.getMessage());
                    }
                }
            });
        }

        private void notifyUpdateProgress(final String cbId, final long downloaded, final long total, final int pct, final String status) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (webView != null) {
                        String js = "window.__onUpdateDownloadProgress && window.__onUpdateDownloadProgress("
                                + org.json.JSONObject.quote(cbId) + ", "
                                + downloaded + ", "
                                + total + ", "
                                + pct + ", "
                                + org.json.JSONObject.quote(status) + ");";
                        webView.evaluateJavascript(js, null);
                    }
                }
            });
        }

        @JavascriptInterface
        public int getSocksPort() {
            SharedPreferences prefs = ctx.getSharedPreferences("klipper_prefs", Context.MODE_PRIVATE);
            return prefs.getInt("socks_port", 25344);
        }

        @JavascriptInterface
        public void setSocksPort(int port) {
            SharedPreferences prefs = ctx.getSharedPreferences("klipper_prefs", Context.MODE_PRIVATE);
            prefs.edit().putInt("socks_port", port).apply();
            LocalBridgeServer.socksPort = port;
        }
    }

    private void enqueueNativeDownload(String url, String fileName) {
        try {
            String safeName = fileName.replaceAll("[^a-zA-Z0-9._\\-]", "_");
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle(safeName);
            req.setDescription("Downloading from Klipperraker Pro...");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeName);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) {
                dm.enqueue(req);
                Toast.makeText(this, "Downloading " + safeName + " to Downloads...", Toast.LENGTH_SHORT).show();
            }
        } catch (Exception e) {
            try {
                Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                startActivity(browserIntent);
            } catch (Exception ignored) {
            }
        }
    }
}
