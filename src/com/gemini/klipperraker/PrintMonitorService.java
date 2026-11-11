package com.gemini.klipperraker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class PrintMonitorService extends Service {
    private static final String CHANNEL_ONGOING = "klipper_monitor_channel";
    private static final String CHANNEL_ALERTS = "klipper_alert_channel";
    private static final int NOTIF_ID_ONGOING = 1001;
    private static int alertNotifId = 2000;

    private Handler handler;
    private ExecutorService executor;
    private boolean running = false;
    private final Map<String, String> lastStates = new HashMap<>();

    private final Runnable pollTask = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    pollPrinters();
                }
            });
            handler.postDelayed(this, 8000);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        SharedPreferences prefs = getSharedPreferences("klipper_prefs", Context.MODE_PRIVATE);
        LocalBridgeServer.socksPort = prefs.getInt("socks_port", 25344);
        LocalBridgeServer.ensureStarted();
        createChannels();
        handler = new Handler(Looper.getMainLooper());
        executor = Executors.newSingleThreadExecutor();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "STOP".equals(intent.getAction())) {
            running = false;
            if (handler != null) handler.removeCallbacksAndMessages(null);
            stopForeground(true);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIF_ID_ONGOING);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            startForeground(NOTIF_ID_ONGOING, buildOngoingNotification("Klipperraker Pro", "Checking printer status...", -1));
            handler.post(pollTask);
        }
        return START_STICKY;
    }

    private boolean isWifiConnected() {
        return MainActivity.isWifiConnectedInternal(this);
    }

    private void pollPrinters() {
        try {
            SharedPreferences prefs = getSharedPreferences("klipper_prefs", Context.MODE_PRIVATE);
            String printersJson = prefs.getString("printers_json", "");
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (printersJson == null || printersJson.isEmpty()) {
                running = false;
                if (handler != null) handler.removeCallbacksAndMessages(null);
                stopForeground(true);
                if (nm != null) nm.cancel(NOTIF_ID_ONGOING);
                stopSelf();
                return;
            }

            JSONArray arr = new JSONArray(printersJson);
            String summaryTitle = "";
            String summaryBody = "";
            int activeProgress = -1;
            boolean anyActivePrint = false;

            Proxy proxy = isWifiConnected() ? Proxy.NO_PROXY : new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", LocalBridgeServer.socksPort));

            for (int i = 0; i < arr.length(); i++) {
                JSONObject p = arr.getJSONObject(i);
                String id = p.optString("id", "p" + i);
                String name = p.optString("name", "Printer");
                String host = p.optString("host", "");
                int port = p.optInt("port", 7125);
                String apiKey = p.optString("apiKey", "");
                if (host.isEmpty()) continue;

                String urlStr = "http://" + host + ":" + port + "/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed";
                HttpURLConnection conn = null;
                try {
                    URL url = new URL(urlStr);
                    try {
                        conn = (HttpURLConnection) url.openConnection(proxy);
                        conn.setConnectTimeout(3000);
                        conn.setReadTimeout(4000);
                        if (apiKey != null && !apiKey.isEmpty()) {
                            conn.setRequestProperty("X-Api-Key", apiKey);
                        }
                        int respCode = conn.getResponseCode();
                        if (respCode != 200 && proxy == Proxy.NO_PROXY) {
                            throw new Exception("Direct connection non-200: " + respCode);
                        }
                    } catch (Exception directEx) {
                        if (proxy == Proxy.NO_PROXY) {
                            if (conn != null) conn.disconnect();
                            Proxy fallbackProxy = new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", LocalBridgeServer.socksPort));
                            conn = (HttpURLConnection) url.openConnection(fallbackProxy);
                            conn.setConnectTimeout(5000);
                            conn.setReadTimeout(5000);
                            if (apiKey != null && !apiKey.isEmpty()) {
                                conn.setRequestProperty("X-Api-Key", apiKey);
                            }
                        } else {
                            throw directEx;
                        }
                    }
                    if (conn.getResponseCode() == 200) {
                        BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                        StringBuilder sb = new StringBuilder();
                        String line;
                        while ((line = br.readLine()) != null) sb.append(line);
                        br.close();

                        JSONObject root = new JSONObject(sb.toString());
                        JSONObject status = root.getJSONObject("result").getJSONObject("status");
                        JSONObject ps = status.optJSONObject("print_stats");
                        JSONObject vsd = status.optJSONObject("virtual_sdcard");
                        JSONObject ext = status.optJSONObject("extruder");
                        JSONObject bed = status.optJSONObject("heater_bed");

                        String state = ps != null ? ps.optString("state", "standby") : "standby";
                        String filename = ps != null ? ps.optString("filename", "") : "";
                        double prog = vsd != null ? vsd.optDouble("progress", 0.0) : 0.0;
                        int pct = (int) Math.round(prog * 100.0);
                        double nozTemp = ext != null ? ext.optDouble("temperature", 0.0) : 0.0;
                        double bedTemp = bed != null ? bed.optDouble("temperature", 0.0) : 0.0;

                        String prevState = lastStates.get(id);
                        if (prevState != null && !prevState.equals(state)) {
                            if ("complete".equalsIgnoreCase(state)) {
                                sendAlertNotification(name + ": Print Complete!", "Finished printing " + filename + " (100%)");
                            } else if ("paused".equalsIgnoreCase(state)) {
                                sendAlertNotification(name + ": Print Paused", "Job " + filename + " paused at " + pct + "%");
                            } else if ("error".equalsIgnoreCase(state)) {
                                sendAlertNotification(name + ": Printer Error!", "Check printer status for " + filename);
                            }
                        }
                        lastStates.put(id, state);

                        if ("printing".equalsIgnoreCase(state) || "paused".equalsIgnoreCase(state)) {
                            anyActivePrint = true;
                            summaryTitle = name + " • " + state.toUpperCase() + " (" + pct + "%)";
                            summaryBody = String.format("%s | Nozzle %.0f°C • Bed %.0f°C", filename, nozTemp, bedTemp);
                            activeProgress = pct;
                        }
                    }
                } catch (Exception ignored) {
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }

            if (!anyActivePrint) {
                running = false;
                if (handler != null) handler.removeCallbacksAndMessages(null);
                stopForeground(true);
                if (nm != null) nm.cancel(NOTIF_ID_ONGOING);
                stopSelf();
                return;
            }

            if (nm != null && running) {
                nm.notify(NOTIF_ID_ONGOING, buildOngoingNotification(summaryTitle, summaryBody, activeProgress));
            }
        } catch (Exception ignored) {
        }
    }

    private Notification buildOngoingNotification(String title, String body, int progress) {
        Intent i = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ONGOING);
        } else {
            b = new Notification.Builder(this);
        }
        b.setContentTitle(title)
         .setContentText(body)
         .setSmallIcon(android.R.drawable.stat_sys_upload_done)
         .setContentIntent(pi)
         .setOngoing(true);
        if (progress >= 0) {
            b.setProgress(100, Math.min(100, progress), false);
        }
        return b.build();
    }

    public void sendAlertNotification(String title, String body) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Intent i = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 1, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ALERTS);
        } else {
            b = new Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH);
        }
        b.setContentTitle(title)
         .setContentText(body)
         .setSmallIcon(android.R.drawable.ic_dialog_info)
         .setContentIntent(pi)
         .setAutoCancel(true);
        nm.notify(alertNotifId++, b.build());
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel ongoing = new NotificationChannel(
                    CHANNEL_ONGOING, "Live Printer Telemetry", NotificationManager.IMPORTANCE_LOW);
            ongoing.setDescription("Shows live print progress and nozzle/bed temperatures");
            nm.createNotificationChannel(ongoing);

            NotificationChannel alerts = new NotificationChannel(
                    CHANNEL_ALERTS, "Print Status Alerts", NotificationManager.IMPORTANCE_HIGH);
            alerts.setDescription("Alerts when prints finish, pause, or encounter errors");
            alerts.enableVibration(true);
            nm.createNotificationChannel(alerts);
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (executor != null) executor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
