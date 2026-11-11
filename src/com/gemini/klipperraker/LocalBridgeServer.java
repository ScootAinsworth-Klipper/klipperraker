package com.gemini.klipperraker;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lightweight localhost HTTP gateway (127.0.0.1:18125) that routes requests to
 * printer LAN IPs (192.168.1.x) automatically through WG Tunnel's local SOCKS5
 * proxy (127.0.0.1:25344) when active, or directly over Wi-Fi LAN when WG Tunnel is off.
 * This allows AdGuard VPN and WG Tunnel Proxy Mode to work together seamlessly
 * without needing AdGuard Outbound Proxy or LAN bypass modifications.
 */
public class LocalBridgeServer {
    public static final int BRIDGE_PORT = 18125;
    public static volatile int socksPort = 25344;
    private static LocalBridgeServer instance;

    public static synchronized void ensureStarted() {
        if (instance == null) {
            instance = new LocalBridgeServer();
        }
        instance.start();
    }

    private ServerSocket serverSocket;
    private ExecutorService executor;
    private volatile boolean running = false;

    public synchronized void start() {
        if (running) return;
        running = true;
        executor = Executors.newCachedThreadPool();
        executor.execute(new Runnable() {
            @Override
            public void run() {
                runServerLoop();
            }
        });
    }

    public synchronized void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (Exception ignored) {}
        if (executor != null) executor.shutdownNow();
    }

    private void runServerLoop() {
        try {
            serverSocket = new ServerSocket();
            serverSocket.setReuseAddress(true);
            serverSocket.bind(new InetSocketAddress("127.0.0.1", BRIDGE_PORT));
            while (running) {
                final Socket client = serverSocket.accept();
                executor.execute(new Runnable() {
                    @Override
                    public void run() {
                        handleClient(client);
                    }
                });
            }
        } catch (Exception ignored) {
        }
    }

    public static Socket openTargetSocket(String targetHost, int targetPort, int timeoutMs) throws Exception {
        // 1. Check if WG Tunnel SOCKS5 proxy (127.0.0.1:25344) is listening
        Socket socks = null;
        try {
            socks = new Socket();
            socks.connect(new InetSocketAddress("127.0.0.1", socksPort), 250);
            socks.setSoTimeout(timeoutMs);
            if (performSocks5Handshake(socks, targetHost, targetPort)) {
                return socks;
            }
            socks.close();
        } catch (Exception ignored) {
            if (socks != null) {
                try { socks.close(); } catch (Exception e) {}
            }
        }

        // 2. Fallback to direct LAN socket connection
        Socket direct = new Socket();
        direct.connect(new InetSocketAddress(targetHost, targetPort), timeoutMs);
        direct.setSoTimeout(timeoutMs);
        return direct;
    }

    private static boolean performSocks5Handshake(Socket s, String host, int port) throws Exception {
        InputStream in = s.getInputStream();
        OutputStream out = s.getOutputStream();

        // Greeting: VER=5, NMETHODS=1, METHOD=0 (No Auth)
        out.write(new byte[]{0x05, 0x01, 0x00});
        out.flush();

        int ver = in.read();
        int method = in.read();
        if (ver != 0x05 || method != 0x00) return false;

        // Parse IPv4 address if numeric, otherwise domain name
        byte[] ipBytes = null;
        try {
            String[] parts = host.split("\\.");
            if (parts.length == 4) {
                ipBytes = new byte[]{
                    (byte) Integer.parseInt(parts[0]),
                    (byte) Integer.parseInt(parts[1]),
                    (byte) Integer.parseInt(parts[2]),
                    (byte) Integer.parseInt(parts[3])
                };
            }
        } catch (Exception ignored) {}

        ByteArrayOutputStream req = new ByteArrayOutputStream();
        req.write(0x05); // VER
        req.write(0x01); // CMD = CONNECT
        req.write(0x00); // RSV
        if (ipBytes != null) {
            req.write(0x01); // ATYP = IPv4
            req.write(ipBytes);
        } else {
            byte[] domainBytes = host.getBytes(StandardCharsets.UTF_8);
            req.write(0x03); // ATYP = DOMAINNAME
            req.write(domainBytes.length);
            req.write(domainBytes);
        }
        req.write((port >> 8) & 0xFF);
        req.write(port & 0xFF);
        out.write(req.toByteArray());
        out.flush();

        int rVer = in.read();
        int rRep = in.read();
        int rRsv = in.read();
        int rAtyp = in.read();
        if (rVer != 0x05 || rRep != 0x00) return false;

        if (rAtyp == 0x01) {
            skipFully(in, 4 + 2);
        } else if (rAtyp == 0x03) {
            int len = in.read();
            skipFully(in, len + 2);
        } else if (rAtyp == 0x04) {
            skipFully(in, 16 + 2);
        }
        return true;
    }

    private static void skipFully(InputStream in, int n) throws Exception {
        for (int i = 0; i < n; i++) {
            if (in.read() < 0) break;
        }
    }

    private void handleClient(final Socket client) {
        Socket upstream = null;
        try {
            client.setSoTimeout(15000);
            InputStream clientIn = client.getInputStream();
            OutputStream clientOut = client.getOutputStream();

            // Read HTTP request header up to \r\n\r\n
            ByteArrayOutputStream headerBuf = new ByteArrayOutputStream();
            int b;
            int state = 0;
            while ((b = clientIn.read()) != -1) {
                headerBuf.write(b);
                if (state == 0 && b == '\r') state = 1;
                else if (state == 1 && b == '\n') state = 2;
                else if (state == 2 && b == '\r') state = 3;
                else if (state == 3 && b == '\n') break;
                else state = 0;
                if (headerBuf.size() > 32768) break;
            }

            String rawHeader = new String(headerBuf.toByteArray(), StandardCharsets.ISO_8859_1);
            int firstLineEnd = rawHeader.indexOf("\r\n");
            if (firstLineEnd < 0) return;

            String firstLine = rawHeader.substring(0, firstLineEnd);
            String restHeaders = rawHeader.substring(firstLineEnd + 2);
            android.util.Log.i("LocalBridge", "REQ: " + firstLine);
            String[] parts = firstLine.split(" ");
            if (parts.length < 3) return;

            String method = parts[0];
            String fullPath = parts[1]; // Expect: /proxy/<host>:<port>/<realPath>
            String httpVer = parts[2];

            if ("OPTIONS".equalsIgnoreCase(method)) {
                String corsResp = "HTTP/1.1 200 OK\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n" +
                        "Access-Control-Allow-Headers: *\r\n" +
                        "Content-Length: 0\r\n\r\n";
                clientOut.write(corsResp.getBytes(StandardCharsets.ISO_8859_1));
                clientOut.flush();
                return;
            }

            if (!fullPath.startsWith("/proxy/")) return;
            String rem = fullPath.substring("/proxy/".length());
            int slashIdx = rem.indexOf('/');
            String hostPort = slashIdx >= 0 ? rem.substring(0, slashIdx) : rem;
            String realPath = slashIdx >= 0 ? rem.substring(slashIdx) : "/";

            String targetHost = hostPort;
            int targetPort = 80;
            int colonIdx = hostPort.indexOf(':');
            if (colonIdx >= 0) {
                targetHost = hostPort.substring(0, colonIdx);
                targetPort = Integer.parseInt(hostPort.substring(colonIdx + 1));
            }

            upstream = openTargetSocket(targetHost, targetPort, 6000);
            // Allow long-lived streams (MJPEG / MP4)
            upstream.setSoTimeout(60000);
            client.setSoTimeout(60000);

            final InputStream upIn = upstream.getInputStream();
            final OutputStream upOut = upstream.getOutputStream();

            // Rewrite Host header & Connection: close
            StringBuilder newReq = new StringBuilder();
            newReq.append(method).append(" ").append(realPath).append(" ").append(httpVer).append("\r\n");
            String[] hdrLines = restHeaders.split("\r\n");
            for (String hLine : hdrLines) {
                if (hLine.isEmpty()) continue;
                String lower = hLine.toLowerCase();
                if (lower.startsWith("host:")) {
                    newReq.append("Host: ").append(hostPort).append("\r\n");
                } else if (lower.startsWith("connection:")) {
                    newReq.append("Connection: close\r\n");
                } else {
                    newReq.append(hLine).append("\r\n");
                }
            }
            newReq.append("Connection: close\r\n\r\n");
            upOut.write(newReq.toString().getBytes(StandardCharsets.ISO_8859_1));
            upOut.flush();

            // Forward request body if any in background thread
            final Socket finalUpstream = upstream;
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = clientIn.read(buf)) != -1) {
                            upOut.write(buf, 0, n);
                            upOut.flush();
                        }
                    } catch (Exception ignored) {
                    }
                }
            });

            // Read upstream response headers and inject CORS header
            ByteArrayOutputStream respHdrBuf = new ByteArrayOutputStream();
            int rb;
            int rState = 0;
            while ((rb = upIn.read()) != -1) {
                respHdrBuf.write(rb);
                if (rState == 0 && rb == '\r') rState = 1;
                else if (rState == 1 && rb == '\n') rState = 2;
                else if (rState == 2 && rb == '\r') rState = 3;
                else if (rState == 3 && rb == '\n') break;
                else rState = 0;
                if (respHdrBuf.size() > 32768) break;
            }

            String respHdrStr = new String(respHdrBuf.toByteArray(), StandardCharsets.ISO_8859_1);
            int rFirstEnd = respHdrStr.indexOf("\r\n");
            if (rFirstEnd > 0) {
                String statusLine = respHdrStr.substring(0, rFirstEnd);
                android.util.Log.i("LocalBridge", "RESP: " + statusLine + " for " + fullPath);
                String remRespHdrs = respHdrStr.substring(rFirstEnd + 2);
                String patchedRespHdr = statusLine + "\r\nAccess-Control-Allow-Origin: *\r\n" + remRespHdrs;
                clientOut.write(patchedRespHdr.getBytes(StandardCharsets.ISO_8859_1));
            } else {
                clientOut.write(respHdrBuf.toByteArray());
            }
            clientOut.flush();

            // Pipe response body (supports infinite MJPEG stream, MP4, JSON, etc.)
            byte[] pipeBuf = new byte[16384];
            int readLen;
            while ((readLen = upIn.read(pipeBuf)) != -1) {
                clientOut.write(pipeBuf, 0, readLen);
                clientOut.flush();
            }
        } catch (Exception ignored) {
        } finally {
            try { if (upstream != null) upstream.close(); } catch (Exception ignored) {}
            try { client.close(); } catch (Exception ignored) {}
        }
    }
}
