const CONFIG_VERSION = "v2";
const DEFAULT_PRINTERS = [
  {
    id: "k2-main",
    name: "My K2",
    host: "192.168.1.84",
    port: 7125,
    webPort: 4408,
    apiKey: "",
    camMode: "mjpeg"
  },
  {
    id: "k1-se",
    name: "K1 SE",
    host: "192.168.1.242",
    port: 7125,
    webPort: 4409,
    apiKey: "",
    camMode: "mjpeg"
  },
  {
    id: "cr10-smart",
    name: "CR-10 Smart",
    host: "192.168.1.15",
    port: 7125,
    webPort: 80,
    apiKey: "",
    camMode: "mjpeg"
  }
];

let printers = [];
let activePrinterIdx = 0;
let currentPrintState = "standby";
let jogStep = 10;
let ledState = 1;
let ledPinName = "LED";
let hasStandardFan = false;
let discoveredMacros = [];
let tempHistory = [];
let excludeData = { objects: [], excluded_objects: [], current_object: null };
let pcWebrtc = null;
let snapTimer = null;
let bgMonitorOn = true;
let farmStatusCache = {};
let activeWebcams = [];
let selectedWebcamIdx = 0;
let switchSeq = 0;
let consecutivePollFailures = 0;

// Machine Tab state
let currentMachineRoot = "config";
let machineFilesCache = [];
let editingFileRoot = "config";
let editingFilePath = "";

function initApp() {
  loadPrinters();
  renderPrinterPills();
  selectPrinter(0);

  setInterval(pollActivePrinter, 1600);
  setInterval(pollFarmPrinters, 6000);
  setTimeout(pollFarmPrinters, 600);
}

function loadPrinters() {
  const savedVer = localStorage.getItem("klipper_config_ver");
  if (savedVer === CONFIG_VERSION) {
    try {
      if (window.AndroidBridge && AndroidBridge.getPrintersJson) {
        const saved = AndroidBridge.getPrintersJson();
        if (saved && saved.length > 5) {
          printers = JSON.parse(saved);
        }
        bgMonitorOn = AndroidBridge.isBackgroundMonitorEnabled();
        updateBgMonitorBtn();
      }
    } catch (e) {}

    if (!printers || !printers.length) {
      const local = localStorage.getItem("klipper_printers");
      if (local) {
        try { printers = JSON.parse(local); } catch (e) {}
      }
    }
  }

  if (!printers || !printers.length) {
    printers = JSON.parse(JSON.stringify(DEFAULT_PRINTERS));
    localStorage.setItem("klipper_config_ver", CONFIG_VERSION);
    persistPrinters();
  }
}

function persistPrinters() {
  const s = JSON.stringify(printers);
  localStorage.setItem("klipper_printers", s);
  localStorage.setItem("klipper_config_ver", CONFIG_VERSION);
  try {
    if (window.AndroidBridge && AndroidBridge.savePrintersJson) {
      AndroidBridge.savePrintersJson(s);
    }
  } catch (e) {}
}

function getActivePrinter() {
  return printers[activePrinterIdx] || printers[0];
}

function baseUrl(p) {
  p = p || getActivePrinter();
  return `http://${p.host}:${p.port || 7125}`;
}

function reqHeaders(p) {
  p = p || getActivePrinter();
  const h = { "Content-Type": "application/json" };
  if (p.apiKey) h["X-Api-Key"] = p.apiKey;
  return h;
}

/* ACTIVE PRINT PROTECTION GUARD */
function isPrintActive() {
  return currentPrintState === "printing" || currentPrintState === "paused";
}

function confirmIfPrinting(actionDescription, onConfirm, onCancel) {
  const p = getActivePrinter();
  if (isPrintActive()) {
    const ok = confirm(
      `⚠️ ACTIVE PRINT GUARD (${p.name} is ${currentPrintState.toUpperCase()})\n\n` +
      `Are you sure you want to perform this action while a print is active?\n\n` +
      `👉 ${actionDescription}`
    );
    if (!ok) {
      if (typeof onCancel === "function") onCancel();
      return false;
    }
  }
  if (typeof onConfirm === "function") onConfirm();
  return true;
}

const pendingNativeHttp = new Map();
let nativeReqSeq = 0;

window.__onNativeHttpResult = function(reqId, resultJsonStr) {
  const cb = pendingNativeHttp.get(reqId);
  if (cb) {
    pendingNativeHttp.delete(reqId);
    try {
      cb.resolve(JSON.parse(resultJsonStr));
    } catch (e) {
      cb.reject(e);
    }
  }
};

const pendingNativeImages = new Map();
let nativeImgSeq = 0;

window.__onNativeImageResult = function(reqId, dataUri) {
  const cb = pendingNativeImages.get(reqId);
  if (cb) {
    pendingNativeImages.delete(reqId);
    cb.resolve(dataUri);
  }
};

function asyncNativeHttp(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const reqId = "nh_" + (++nativeReqSeq) + "_" + Date.now();
    const timer = setTimeout(() => {
      if (pendingNativeHttp.has(reqId)) {
        pendingNativeHttp.delete(reqId);
        resolve({ status: 408, body: JSON.stringify({ error: "Remote request timeout" }) });
      }
    }, 12000);
    pendingNativeHttp.set(reqId, {
      resolve: (val) => { clearTimeout(timer); resolve(val); },
      reject: (err) => { clearTimeout(timer); reject(err); }
    });
    try {
      AndroidBridge.nativeHttpAsync(reqId, method, url, JSON.stringify(headers || {}), typeof body === "string" ? body : (body ? JSON.stringify(body) : ""));
    } catch (err) {
      clearTimeout(timer);
      pendingNativeHttp.delete(reqId);
      reject(err);
    }
  });
}

function asyncFetchImageBase64(url) {
  return new Promise((resolve) => {
    const reqId = "img_" + (++nativeImgSeq) + "_" + Date.now();
    const timer = setTimeout(() => {
      if (pendingNativeImages.has(reqId)) {
        pendingNativeImages.delete(reqId);
        resolve("");
      }
    }, 8000);
    pendingNativeImages.set(reqId, {
      resolve: (val) => { clearTimeout(timer); resolve(val); }
    });
    try {
      AndroidBridge.fetchImageBase64Async(reqId, url);
    } catch (e) {
      clearTimeout(timer);
      pendingNativeImages.delete(reqId);
      resolve("");
    }
  });
}

async function moonrakerFetch(p, pathAndQuery, options = {}) {
  const url = `${baseUrl(p)}${pathAndQuery}`;
  const isOffWifi = !!(window.AndroidBridge && AndroidBridge.isWifiConnected && !AndroidBridge.isWifiConnected());

  if (isOffWifi && window.AndroidBridge.nativeHttpAsync) {
    const method = options.method || "GET";
    const headers = Object.assign({}, reqHeaders(p), options.headers || {});
    const body = options.body || "";
    try {
      let res = await asyncNativeHttp(method, url, headers, body);
      if (res.status === 401 && p.apiKey) {
        p.apiKey = "";
        persistPrinters();
        delete headers["X-Api-Key"];
        res = await asyncNativeHttp(method, url, headers, body);
      }
      return {
        ok: res.status >= 200 && res.status < 400,
        status: res.status,
        json: async () => JSON.parse(res.body || "{}"),
        text: async () => res.body || ""
      };
    } catch (e) {
      console.error("asyncNativeHttp failed:", e);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 5500);
  try {
    const headers = Object.assign({}, reqHeaders(p), options.headers || {});
    let resp = await fetch(url, Object.assign({}, options, {
      headers,
      signal: controller.signal
    }));
    if (resp.status === 401 && p.apiKey) {
      p.apiKey = "";
      persistPrinters();
      delete headers["X-Api-Key"];
      resp = await fetch(url, Object.assign({}, options, {
        headers,
        signal: controller.signal
      }));
    }
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

function renderPrinterPills() {
  const wrap = document.getElementById("printerPills");
  wrap.innerHTML = printers.map((p, idx) => {
    const st = farmStatusCache[p.id] || "offline";
    let dotClass = "";
    if (st === "printing") dotClass = "printing";
    else if (st === "ready" || st === "complete" || st === "standby" || st === "paused") dotClass = "online";
    else if (st === "shutdown" || st === "error") dotClass = "error";
    return `<div class="printer-pill ${idx === activePrinterIdx ? 'active' : ''}" onclick="selectPrinter(${idx})">
      <span class="status-dot ${dotClass}"></span>
      <span>${escapeHtml(p.name)}</span>
    </div>`;
  }).join("");
}

function resetDashboardForPrinterSwitch(p) {
  currentPrintState = "standby";
  consecutivePollFailures = 0;
  tempHistory = [];
  discoveredMacros = [];
  activeWebcams = [];
  selectedWebcamIdx = 0;
  excludeData = { objects: [], excluded_objects: [], current_object: null };
  machineFilesCache = [];

  if (pcWebrtc) {
    try { pcWebrtc.close(); } catch (e) {}
    pcWebrtc = null;
  }
  if (snapTimer) {
    clearInterval(snapTimer);
    snapTimer = null;
  }

  const videoEl = document.getElementById("webrtcVideo");
  const imgEl = document.getElementById("mjpegImg");
  const emptyEl = document.getElementById("camEmptyState");
  videoEl.style.display = "none";
  videoEl.srcObject = null;
  imgEl.onload = null;
  imgEl.onerror = null;
  imgEl.style.display = "none";
  imgEl.removeAttribute("src");
  emptyEl.style.display = "block";
  emptyEl.innerText = `Connecting to ${p.name} camera...`;
  document.getElementById("camOverlayInfo").innerText = `${p.name} • Connecting...`;
  document.getElementById("multiCamButtons").innerHTML = "";
  document.getElementById("btnWebrtcMode").style.display = (p.host === "192.168.1.84") ? "inline-flex" : "none";

  document.getElementById("printerAlertBanner").style.display = "none";
  document.getElementById("printGuardBadge").style.display = "none";

  document.getElementById("activePrinterTitle").innerText = `${p.name} (${p.host})`;
  const badge = document.getElementById("printerStateBadge");
  badge.className = "badge";
  badge.innerText = "CONNECTING...";

  document.getElementById("jobFilename").innerText = "Connecting to " + p.name + "...";
  document.getElementById("jobPercent").innerText = "0.0%";
  document.getElementById("jobProgressBar").style.width = "0%";
  document.getElementById("statLayer").innerText = "0 / 0";
  document.getElementById("statTime").innerText = "00:00 / --:--";
  document.getElementById("statZSpeed").innerText = "Z 0.00mm";

  document.getElementById("nozTempText").innerText = "--°C / 0°C";
  document.getElementById("nozPowerText").innerText = "Power: 0%";
  document.getElementById("bedTempText").innerText = "--°C / 0°C";
  document.getElementById("bedPowerText").innerText = "Power: 0%";
  document.getElementById("sensor1Label").innerText = "Chamber / Host";
  document.getElementById("sensorChamber").innerText = "-- °C";
  document.getElementById("sensor2Label").innerText = "MCU Temp";
  document.getElementById("sensorMcu").innerText = "-- °C";
  document.getElementById("sensor3Label").innerText = "Aux / CFS";
  document.getElementById("sensorCfs").innerText = "--";

  document.getElementById("cfsCard").style.display = (p.host === "192.168.1.84") ? "flex" : "none";
  document.body.classList.toggle("has-cfs", p.host === "192.168.1.84");
  document.getElementById("cfsSlotsContainer").innerHTML = "";

  document.getElementById("posX").innerText = "0.00";
  document.getElementById("posY").innerText = "0.00";
  document.getElementById("posZ").innerText = "0.00";
  document.getElementById("homedAxesBadge").innerText = "HOMED: NONE";
  document.getElementById("canExtrudeBadge").className = "badge";
  document.getElementById("canExtrudeBadge").innerText = "STANDBY";
  ["fan0", "fan1", "fan2"].forEach(pin => {
    document.getElementById(`${pin}Slider`).value = 0;
    document.getElementById(`${pin}Val`).innerText = "0%";
  });

  drawTempChart();
  renderExcludeObjects();
  document.getElementById("macroGrid").innerHTML = `<div style="color:var(--text-muted); font-size:12px;">Loading macros for ${escapeHtml(p.name)}...</div>`;
  document.getElementById("consoleBox").innerHTML = "";
  document.getElementById("fileListContainer").innerHTML = `<div style="color:var(--text-muted);">Loading files from ${escapeHtml(p.name)}...</div>`;
}

async function selectPrinter(idx) {
  activePrinterIdx = idx;
  const mySeq = ++switchSeq;
  const p = getActivePrinter();
  renderPrinterPills();
  resetDashboardForPrinterSwitch(p);

  discoverWebcamsAndStart(p, mySeq);
  discoverPrinterObjects(p, mySeq);
  pollActivePrinter();
  loadGcodeFiles();
  loadTimelapses();
  refreshGcodeStore();
  loadMachineTabInfo(p, mySeq);
}

function switchTab(tabId, el) {
  document.querySelectorAll(".tab-pane").forEach(s => s.classList.remove("active"));
  document.getElementById("tab-" + tabId).classList.add("active");
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  if (el) el.classList.add("active");

  if (tabId === "files") {
    loadGcodeFiles();
    loadTimelapses();
  }
  if (tabId === "macros") refreshGcodeStore();
  if (tabId === "machine") loadMachineTabInfo(getActivePrinter(), switchSeq);
  if (tabId === "farm") pollFarmPrinters();
}

/* DYNAMIC WEBCAM DISCOVERY & STREAMING */
function resolveCamUrl(p, rawUrl, fallbackPath) {
  const u = (rawUrl || fallbackPath || "").trim();
  if (u.startsWith("http://") || u.startsWith("https://")) {
    return u;
  }
  const webPort = p.webPort || 80;
  const portSuffix = (webPort === 80) ? "" : `:${webPort}`;
  const pathPart = u.startsWith("/") ? u : `/${u}`;
  return `http://${p.host}${portSuffix}${pathPart}`;
}

async function discoverWebcamsAndStart(p, seq) {
  try {
    const r = await moonrakerFetch(p, "/server/webcams/list");
    if (seq !== switchSeq) return;
    if (r.ok) {
      const d = await r.json();
      const cams = ((d.result && d.result.webcams) || []).filter(c => c.enabled !== false);
      if (cams.length > 0) {
        activeWebcams = cams.map(c => ({
          name: c.name || "Camera",
          streamUrl: resolveCamUrl(p, c.stream_url, "/webcam/?action=stream"),
          snapshotUrl: resolveCamUrl(p, c.snapshot_url, "/webcam/?action=snapshot")
        }));
      }
    }
  } catch (e) {
    if (seq !== switchSeq) return;
  }

  if (!activeWebcams.length) {
    activeWebcams = [{
      name: "Main",
      streamUrl: resolveCamUrl(p, "/webcam/?action=stream"),
      snapshotUrl: resolveCamUrl(p, "/webcam/?action=snapshot")
    }];
  }

  selectedWebcamIdx = 0;
  renderMultiCamButtons();
  setCameraMode(p.camMode || "mjpeg");
}

function renderMultiCamButtons() {
  const wrap = document.getElementById("multiCamButtons");
  if (activeWebcams.length <= 1) {
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = activeWebcams.map((c, i) =>
    `<button class="btn ${i === selectedWebcamIdx ? 'btn-primary' : ''}" onclick="selectWebcam(${i})">📷 ${escapeHtml(c.name)}</button>`
  ).join("");
}

function selectWebcam(idx) {
  selectedWebcamIdx = idx;
  renderMultiCamButtons();
  setCameraMode(getActivePrinter().camMode || "mjpeg");
}

function setCameraMode(mode) {
  const p = getActivePrinter();
  if (mode === "webrtc" && p.host !== "192.168.1.84") {
    mode = "mjpeg";
  }
  p.camMode = mode;
  persistPrinters();

  document.getElementById("camModeBadge").innerText = mode.toUpperCase();
  const videoEl = document.getElementById("webrtcVideo");
  const imgEl = document.getElementById("mjpegImg");
  const emptyEl = document.getElementById("camEmptyState");
  const infoEl = document.getElementById("camOverlayInfo");

  if (pcWebrtc) {
    try { pcWebrtc.close(); } catch (e) {}
    pcWebrtc = null;
  }
  if (snapTimer) {
    clearInterval(snapTimer);
    snapTimer = null;
  }

  const cam = activeWebcams[selectedWebcamIdx] || {
    name: "Camera",
    streamUrl: resolveCamUrl(p, "/webcam/?action=stream"),
    snapshotUrl: resolveCamUrl(p, "/webcam/?action=snapshot")
  };

  if (mode === "webrtc") {
    imgEl.style.display = "none";
    imgEl.removeAttribute("src");
    emptyEl.style.display = "none";
    videoEl.style.display = "block";
    infoEl.innerText = `${p.name} (${cam.name}) • WebRTC Connecting...`;
    startWebrtcStream(p.host, infoEl, videoEl);
  } else if (mode === "mjpeg") {
    videoEl.style.display = "none";
    videoEl.srcObject = null;
    emptyEl.style.display = "block";
    emptyEl.innerText = `Loading ${p.name} (${cam.name}) stream...`;
    imgEl.style.display = "none";

    const isOffWifi = !!(window.AndroidBridge && AndroidBridge.isWifiConnected && !AndroidBridge.isWifiConnected());
    if (isOffWifi) {
      infoEl.innerText = `${p.name} • ${cam.name} (Remote 5G)`;
      startSnapshotLoop(p, cam, imgEl, emptyEl, infoEl);
      return;
    }

    const sep = cam.streamUrl.includes("?") ? "&" : "?";
    const streamUrl = `${cam.streamUrl}${sep}t=${Date.now()}`;
    infoEl.innerText = `${p.name} • ${cam.name} (MJPEG)`;

    imgEl.onload = () => {
      emptyEl.style.display = "none";
      imgEl.style.display = "block";
    };
    imgEl.onerror = () => {
      infoEl.innerText = `${p.name} • ${cam.name} (Snapshot Mode)`;
      startSnapshotLoop(p, cam, imgEl, emptyEl, infoEl);
    };
    imgEl.src = streamUrl;
  } else {
    videoEl.style.display = "none";
    videoEl.srcObject = null;
    startSnapshotLoop(p, cam, imgEl, emptyEl, infoEl);
  }
}

function startSnapshotLoop(p, cam, imgEl, emptyEl, infoEl) {
  if (snapTimer) clearInterval(snapTimer);
  const mySeq = switchSeq;
  let fetchingFrame = false;

  const loadSnap = () => {
    if (mySeq !== switchSeq) return;
    const isOffWifi = !!(window.AndroidBridge && AndroidBridge.isWifiConnected && !AndroidBridge.isWifiConnected());
    if (isOffWifi && window.AndroidBridge.fetchImageBase64Async) {
      if (fetchingFrame) return;
      fetchingFrame = true;
      const sep = cam.snapshotUrl.includes("?") ? "&" : "?";
      const u = `${cam.snapshotUrl}${sep}t=${Date.now()}`;
      asyncFetchImageBase64(u).then(b64 => {
        fetchingFrame = false;
        if (mySeq !== switchSeq) return;
        if (b64 && b64.length > 50) {
          emptyEl.style.display = "none";
          imgEl.style.display = "block";
          imgEl.src = b64;
          infoEl.innerText = `${p.name} • ${cam.name} (5G Remote Live)`;
        }
      }).catch(() => {
        fetchingFrame = false;
      });
      return;
    }
    const sep = cam.snapshotUrl.includes("?") ? "&" : "?";
    const url = `${cam.snapshotUrl}${sep}t=${Date.now()}`;
    imgEl.onload = () => {
      emptyEl.style.display = "none";
      imgEl.style.display = "block";
      infoEl.innerText = `${p.name} • ${cam.name} (Live Snapshot)`;
    };
    imgEl.onerror = () => {
      imgEl.style.display = "none";
      emptyEl.style.display = "block";
      emptyEl.innerText = `Camera unavailable on ${p.name} (${p.host})`;
      infoEl.innerText = `${p.name} • Camera Offline`;
    };
    imgEl.src = url;
  };
  loadSnap();
  const interval = (window.AndroidBridge && AndroidBridge.isWifiConnected && !AndroidBridge.isWifiConnected()) ? 1600 : 1200;
  snapTimer = setInterval(loadSnap, interval);
}

function startWebrtcStream(host, infoEl, videoEl) {
  try {
    pcWebrtc = new RTCPeerConnection();
    let offerSent = false;
    const sendOffer = (sdp) => {
      if (offerSent || !sdp) return;
      offerSent = true;
      fetch(`http://${host}:8000/call/webrtc_local`, {
        method: "POST",
        headers: { "Content-Type": "plain/text" },
        body: btoa(JSON.stringify({ type: "offer", sdp: sdp }))
      })
      .then(r => r.text())
      .then(txt => {
        const res = JSON.parse(atob(txt));
        if (res.type === "answer" && pcWebrtc) {
          pcWebrtc.setRemoteDescription(new RTCSessionDescription(res));
          infoEl.innerText = `${host} • WebRTC Live`;
        }
      })
      .catch(() => {
        infoEl.innerText = "WebRTC unavailable — switching to MJPEG";
        setTimeout(() => setCameraMode("mjpeg"), 800);
      });
    };

    pcWebrtc.ontrack = (ev) => {
      if (ev.streams && ev.streams[0]) {
        videoEl.srcObject = ev.streams[0];
      }
    };
    pcWebrtc.onicecandidate = (ev) => {
      if (ev.candidate === null && pcWebrtc.localDescription) {
        sendOffer(pcWebrtc.localDescription.sdp);
      }
    };
    pcWebrtc.addTransceiver("video", { direction: "sendrecv" });
    pcWebrtc.createOffer().then(d => {
      pcWebrtc.setLocalDescription(d);
      setTimeout(() => {
        if (!offerSent && pcWebrtc && pcWebrtc.localDescription) {
          sendOffer(pcWebrtc.localDescription.sdp);
        }
      }, 650);
    });
  } catch (e) {
    setCameraMode("mjpeg");
  }
}

function reloadCamera() {
  discoverWebcamsAndStart(getActivePrinter(), switchSeq);
}

function toggleFullscreenCam(forceState) {
  const c = document.getElementById("camContainer");
  const isFs = (typeof forceState === "boolean")
    ? c.classList.toggle("fullscreen", forceState)
    : c.classList.toggle("fullscreen");
  const btn = document.getElementById("btnOverlayFsToggle");
  if (btn) {
    btn.innerText = isFs ? "↙ Minimize" : "⛶ Fullscreen";
  }
}

window.handleAndroidBack = function() {
  const camContainer = document.getElementById("camContainer");
  if (camContainer && camContainer.classList.contains("fullscreen")) {
    toggleFullscreenCam(false);
    return "HANDLED";
  }
  const tlModal = document.getElementById("timelapsePlayerModal");
  if (tlModal && tlModal.classList.contains("open")) {
    closeTimelapsePlayer();
    return "HANDLED";
  }
  const cfgModal = document.getElementById("configEditorModal");
  if (cfgModal && cfgModal.classList.contains("open")) {
    closeConfigEditor();
    return "HANDLED";
  }
  const modal = document.getElementById("printerModal");
  if (modal && modal.classList.contains("open")) {
    closePrinterModal();
    return "HANDLED";
  }
  const dashTab = document.getElementById("tab-dashboard");
  if (dashTab && !dashTab.classList.contains("active")) {
    switchTab("dashboard", document.querySelector(".bottom-nav .nav-item"));
    return "HANDLED";
  }
  return "NONE";
};

/* TELEMETRY POLLING */
async function pollActivePrinter() {
  const p = getActivePrinter();
  if (!p) return;
  const mySeq = switchSeq;

  const query = [
    "webhooks",
    "extruder",
    "heater_bed",
    "temperature_sensor%20chamber_temp",
    "temperature_sensor%20mcu_temp",
    "temperature_sensor%20Board_MCU",
    "temperature_sensor%20raspberry_pi",
    "temperature_sensor%20CFS_Temperature",
    "temperature_sensor%20CFS_Humidity_RH",
    "print_stats",
    "virtual_sdcard",
    "display_status",
    "toolhead",
    "gcode_move",
    "fan",
    "output_pin%20fan0",
    "output_pin%20fan1",
    "output_pin%20fan2",
    "output_pin%20LED",
    "output_pin%20LED_pin",
    "box",
    "exclude_object"
  ].join("&");

  try {
    const resp = await moonrakerFetch(p, `/printer/objects/query?${query}`);
    if (mySeq !== switchSeq) return;
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (mySeq !== switchSeq) return;
    consecutivePollFailures = 0;
    const st = data.result.status;
    updateDashboardUI(p, st);
  } catch (err) {
    console.error("pollActivePrinter FAILED:", err, "URL was:", `${baseUrl(p)}/printer/objects/query?${query}`);
    if (mySeq !== switchSeq) return;
    consecutivePollFailures++;
    // Allow 1 transient cellular/VPN packet drop before showing OFFLINE
    if (consecutivePollFailures >= 2 || currentPrintState === "standby") {
      handlePrinterOffline(p);
    }
  }
}

function handlePrinterOffline(p) {
  currentPrintState = "offline";
  const badge = document.getElementById("printerStateBadge");
  badge.className = "badge offline";
  badge.innerText = "OFFLINE";
  farmStatusCache[p.id] = "offline";
  renderPrinterPills();
  document.getElementById("printGuardBadge").style.display = "none";

  document.getElementById("jobFilename").innerText = `${p.name} (${p.host}) is unreachable / powered off`;
  const banner = document.getElementById("printerAlertBanner");
  const alertTxt = document.getElementById("printerAlertText");
  banner.style.display = "flex";
  alertTxt.innerText = `⚠️ ${p.name} (${p.host}:${p.port}) is currently unreachable on your network (powered off or asleep).`;
}

function updateDashboardUI(p, st) {
  const wh = st.webhooks || {};
  const ps = st.print_stats || {};
  const vsd = st.virtual_sdcard || {};
  const ext = st.extruder || {};
  const bed = st.heater_bed || {};
  const th = st.toolhead || {};
  const gm = st.gcode_move || {};

  const whState = (wh.state || "ready").toLowerCase();
  const printState = (ps.state || "standby").toLowerCase();
  const effectiveState = (whState === "shutdown" || whState === "error") ? whState : printState;
  currentPrintState = effectiveState;

  farmStatusCache[p.id] = effectiveState;
  renderPrinterPills();

  const stateBadge = document.getElementById("printerStateBadge");
  stateBadge.className = "badge " + (effectiveState === "shutdown" ? "error" : effectiveState);
  stateBadge.innerText = effectiveState.toUpperCase();

  // Toggle Active Print Guard Badge
  document.getElementById("printGuardBadge").style.display = isPrintActive() ? "inline-block" : "none";

  const banner = document.getElementById("printerAlertBanner");
  const alertTxt = document.getElementById("printerAlertText");
  if (whState === "shutdown" || whState === "error") {
    banner.style.display = "flex";
    alertTxt.innerText = `⚠️ ${p.name} Klipper ${whState.toUpperCase()}: ${(wh.state_message || "").trim()}`;
  } else {
    banner.style.display = "none";
  }

  const fname = ps.filename || (vsd.cur_print_data && vsd.cur_print_data.filename) ||
    (whState === "shutdown" ? "MCU Shutdown / Standby" : "Idle — No active print job");
  document.getElementById("jobFilename").innerText = fname;

  const prog = (vsd.progress || 0) * 100;
  document.getElementById("jobPercent").innerText = prog.toFixed(1) + "%";
  document.getElementById("jobProgressBar").style.width = Math.min(100, prog) + "%";

  const curLayer = (ps.info && ps.info.current_layer) || vsd.layer || 0;
  const totLayer = (ps.info && ps.info.total_layer) || vsd.layer_count ||
    (vsd.cur_print_data && vsd.cur_print_data.metadata && vsd.cur_print_data.metadata.layer_count) || 0;
  document.getElementById("statLayer").innerText = `${curLayer} / ${totLayer}`;

  const printDur = ps.print_duration || 0;
  let etaStr = "--:--";
  if (prog > 1 && prog < 100 && printDur > 10) {
    const remSec = (printDur / (prog / 100)) - printDur;
    etaStr = formatDuration(remSec);
  }
  document.getElementById("statTime").innerText = `${formatDuration(printDur)} / ${etaStr}`;

  const pos = th.position || [0, 0, 0];
  document.getElementById("statZSpeed").innerText = `Z ${(pos[2] || 0).toFixed(2)}mm`;

  if (document.activeElement !== document.getElementById("speedSlider") && gm.speed_factor !== undefined) {
    const spdPct = Math.round(gm.speed_factor * 100);
    document.getElementById("speedSlider").value = spdPct;
    document.getElementById("speedFactorVal").innerText = spdPct + "%";
  }
  if (document.activeElement !== document.getElementById("flowSlider") && gm.extrude_factor !== undefined) {
    const flwPct = Math.round(gm.extrude_factor * 100);
    document.getElementById("flowSlider").value = flwPct;
    document.getElementById("flowFactorVal").innerText = flwPct + "%";
  }

  // Machine Limits Sync (if inputs not focused)
  if (th.max_velocity !== undefined && document.activeElement !== document.getElementById("inpMaxVel")) {
    document.getElementById("inpMaxVel").value = Math.round(th.max_velocity);
  }
  if (th.max_accel !== undefined && document.activeElement !== document.getElementById("inpMaxAccel")) {
    document.getElementById("inpMaxAccel").value = Math.round(th.max_accel);
  }
  if (th.square_corner_velocity !== undefined && document.activeElement !== document.getElementById("inpSqCorner")) {
    document.getElementById("inpSqCorner").value = th.square_corner_velocity;
  }
  if (ext.pressure_advance !== undefined && document.activeElement !== document.getElementById("inpPressureAdv")) {
    document.getElementById("inpPressureAdv").value = Number(ext.pressure_advance).toFixed(3);
  }

  // Temperatures
  const nozT = ext.temperature || 0;
  const nozTarget = ext.target || 0;
  const nozPwr = Math.round((ext.power || 0) * 100);
  document.getElementById("nozTempText").innerText = `${nozT.toFixed(1)}°C / ${nozTarget.toFixed(0)}°C`;
  document.getElementById("nozPowerText").innerText = `Power: ${nozPwr}%`;

  const bedT = bed.temperature || 0;
  const bedTarget = bed.target || 0;
  const bedPwr = Math.round((bed.power || 0) * 100);
  document.getElementById("bedTempText").innerText = `${bedT.toFixed(1)}°C / ${bedTarget.toFixed(0)}°C`;
  document.getElementById("bedPowerText").innerText = `Power: ${bedPwr}%`;

  const fsTel = document.getElementById("camFsTelemetry");
  if (fsTel) {
    fsTel.innerText = `${p.name} • ${effectiveState.toUpperCase()} (${prog.toFixed(1)}%) • 🔥 ${nozT.toFixed(1)}°C • 🛏️ ${bedT.toFixed(1)}°C`;
  }

  const chmObj = st["temperature_sensor chamber_temp"];
  const rpiObj = st["temperature_sensor raspberry_pi"];
  const mcuObj = (st["temperature_sensor mcu_temp"] && st["temperature_sensor mcu_temp"].temperature !== undefined)
    ? st["temperature_sensor mcu_temp"]
    : st["temperature_sensor Board_MCU"];
  const cfsTObj = st["temperature_sensor CFS_Temperature"];
  const cfsHObj = st["temperature_sensor CFS_Humidity_RH"];

  let auxTempForChart = 0;
  if (chmObj && chmObj.temperature !== undefined) {
    document.getElementById("sensor1Label").innerText = "Chamber";
    document.getElementById("sensorChamber").innerText = `${chmObj.temperature.toFixed(1)} °C`;
    auxTempForChart = chmObj.temperature;
  } else if (rpiObj && rpiObj.temperature !== undefined) {
    document.getElementById("sensor1Label").innerText = "Raspberry Pi";
    document.getElementById("sensorChamber").innerText = `${rpiObj.temperature.toFixed(1)} °C`;
    auxTempForChart = rpiObj.temperature;
  } else {
    document.getElementById("sensor1Label").innerText = "Chamber";
    document.getElementById("sensorChamber").innerText = "-- °C";
  }

  document.getElementById("sensorMcu").innerText =
    (mcuObj && mcuObj.temperature !== undefined) ? `${mcuObj.temperature.toFixed(1)} °C` : "-- °C";

  if (cfsTObj && cfsHObj && cfsTObj.temperature !== undefined) {
    document.getElementById("sensor3Label").innerText = "CFS Temp / RH";
    document.getElementById("sensorCfs").innerText = `${cfsTObj.temperature.toFixed(0)}°C / ${cfsHObj.temperature.toFixed(0)}%`;
  } else {
    document.getElementById("sensor3Label").innerText = "State";
    document.getElementById("sensorCfs").innerText = effectiveState.toUpperCase();
  }

  tempHistory.push({ noz: nozT, bed: bedT, chm: auxTempForChart });
  if (tempHistory.length > 90) tempHistory.shift();
  drawTempChart();

  const cfsCard = document.getElementById("cfsCard");
  const hasBox = !!(st.box && st.box.T1);
  document.body.classList.toggle("has-cfs", hasBox);
  if (hasBox) {
    cfsCard.style.display = "flex";
    const t1 = st.box.T1;
    document.getElementById("cfsStateBadge").innerText = `CFS ${t1.state ? t1.state.toUpperCase() : 'ONLINE'} • ${t1.temperature || '--'}°C / ${t1.dry_and_humidity || '--'}% RH`;
    const colors = t1.color_value || [];
    const mats = st.box.same_material || [];
    const slotNames = ["T1A", "T1B", "T1C", "T1D"];
    document.getElementById("cfsSlotsContainer").innerHTML = slotNames.map((sName, i) => {
      let rawHex = (colors[i] || "0ffffff").replace(/^0/, "#");
      if (!rawHex.startsWith("#")) rawHex = "#" + rawHex;
      let matName = "PLA";
      const foundMat = mats.find(m => m[2] === sName);
      if (foundMat && foundMat[3]) matName = foundMat[3];
      return `<div class="cfs-slot">
        <div class="color-swatch" style="background:${rawHex};"></div>
        <div style="font-weight:700;">${sName}</div>
        <div style="font-size:12px; color:var(--text-muted);">${matName}</div>
      </div>`;
    }).join("");
  } else {
    cfsCard.style.display = "none";
  }

  document.getElementById("posX").innerText = (pos[0] || 0).toFixed(2);
  document.getElementById("posY").innerText = (pos[1] || 0).toFixed(2);
  document.getElementById("posZ").innerText = (pos[2] || 0).toFixed(2);
  const homed = (th.homed_axes || "").toUpperCase() || "NONE";
  document.getElementById("homedAxesBadge").innerText = `HOMED: ${homed}`;

  const canExt = document.getElementById("canExtrudeBadge");
  canExt.className = "badge " + (ext.can_extrude ? "ready" : "error");
  canExt.innerText = ext.can_extrude ? "HOT / READY" : "COLD (<170°C)";

  if (gm.homing_origin && gm.homing_origin.length >= 3) {
    document.getElementById("zOffsetBadge").innerText = `${gm.homing_origin[2].toFixed(3)} mm`;
  }

  // Fans & LED
  if (st["output_pin fan0"] && st["output_pin fan0"].value !== undefined) {
    hasStandardFan = false;
    document.getElementById("fan1Row").style.display = "flex";
    document.getElementById("fan2Row").style.display = "flex";
    ["fan0", "fan1", "fan2"].forEach(pin => {
      const pinObj = st[`output_pin ${pin}`];
      const slider = document.getElementById(`${pin}Slider`);
      if (pinObj && pinObj.value !== undefined && document.activeElement !== slider) {
        const val = pinObj.value <= 1.0 ? Math.round(pinObj.value * 100) : Math.round((pinObj.value / 255) * 100);
        slider.value = val;
        document.getElementById(`${pin}Val`).innerText = val + "%";
      }
    });
  } else if (st.fan && st.fan.speed !== undefined) {
    hasStandardFan = true;
    document.getElementById("fan1Row").style.display = "none";
    document.getElementById("fan2Row").style.display = "none";
    const slider = document.getElementById("fan0Slider");
    if (document.activeElement !== slider) {
      const val = Math.round((st.fan.speed || 0) * 100);
      slider.value = val;
      document.getElementById("fan0Val").innerText = val + "%";
    }
  }

  let ledObj = null;
  if (st["output_pin LED"] && st["output_pin LED"].value !== undefined) {
    ledObj = st["output_pin LED"];
    ledPinName = "LED";
  } else if (st["output_pin LED_pin"] && st["output_pin LED_pin"].value !== undefined) {
    ledObj = st["output_pin LED_pin"];
    ledPinName = "LED_pin";
  }

  if (ledObj !== null) {
    ledState = ledObj.value > 0 ? 1 : 0;
    document.getElementById("btnLedToggle").style.borderColor = ledState ? "var(--yellow)" : "var(--border)";
  }

  if (st.exclude_object) {
    excludeData = st.exclude_object;
    renderExcludeObjects();
  }
}

function drawTempChart() {
  const cvs = document.getElementById("tempChart");
  if (!cvs) return;
  const rect = cvs.getBoundingClientRect();
  if (rect.width > 50 && (cvs.width !== Math.round(rect.width) || cvs.height !== Math.round(rect.height))) {
    cvs.width = Math.round(rect.width);
    cvs.height = Math.round(rect.height);
  }
  const ctx = cvs.getContext("2d");
  const w = cvs.width;
  const h = cvs.height;
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach(r => {
    ctx.beginPath();
    ctx.moveTo(0, h * r);
    ctx.lineTo(w, h * r);
    ctx.stroke();
  });

  if (tempHistory.length < 2) return;
  const maxTemp = 280;

  const plotLine = (key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    tempHistory.forEach((pt, idx) => {
      const x = (idx / (tempHistory.length - 1)) * (w - 10) + 5;
      const y = h - Math.min(1, Math.max(0, pt[key] / maxTemp)) * (h - 14) - 7;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  plotLine("chm", "#22c55e");
  plotLine("bed", "#38bdf8");
  plotLine("noz", "#f97316");
}

/* G-CODE EXECUTION & PRINT-GUARDED CONTROLS */
async function sendGcode(script) {
  const p = getActivePrinter();
  appendConsoleLine(`> ${script}`, "cmd");
  try {
    const r = await moonrakerFetch(p, `/printer/gcode/script?script=${encodeURIComponent(script)}`, {
      method: "POST"
    });
    if (!r.ok) {
      const errTxt = await r.text();
      appendConsoleLine(`Error: ${errTxt}`, "err");
    } else {
      setTimeout(pollActivePrinter, 350);
    }
  } catch (e) {
    appendConsoleLine(`Network error sending ${script}`, "err");
  }
}

function safeGcodeAction(script, description) {
  confirmIfPrinting(description || script, () => sendGcode(script));
}

function safePausePrint() {
  if (confirm(`Pause the active print on ${getActivePrinter().name}?`)) {
    sendGcode("PAUSE");
  }
}

function safeResumePrint() {
  if (confirm(`Resume the print on ${getActivePrinter().name}?`)) {
    sendGcode("RESUME");
  }
}

function safeRestartFirmware() {
  if (confirm(`Run FIRMWARE_RESTART on ${getActivePrinter().name}?${isPrintActive() ? "\n\n⚠️ WARNING: This will abort the ongoing print!" : ""}`)) {
    sendGcode("FIRMWARE_RESTART");
  }
}

function safeRestartKlipper() {
  if (confirm(`Run Klipper RESTART on ${getActivePrinter().name}?${isPrintActive() ? "\n\n⚠️ WARNING: This will abort the ongoing print!" : ""}`)) {
    sendGcode("RESTART");
  }
}

function confirmEmergencyStop() {
  if (confirm("🛑 EMERGENCY STOP (M112)? This will immediately halt the printer.")) {
    const p = getActivePrinter();
    moonrakerFetch(p, "/printer/emergency_stop", { method: "POST" });
    sendGcode("M112");
  }
}

function confirmCancelPrint() {
  if (confirm("✖ Cancel the current print job? This cannot be undone.")) {
    sendGcode("CANCEL_PRINT");
  }
}

function toggleChamberLed() {
  const next = ledState ? 0 : 1;
  ledState = next;
  sendGcode(`SET_PIN PIN=${ledPinName} VALUE=${next}`);
}

function setNozzleTemp() {
  const v = parseInt(document.getElementById("nozTargetInput").value || "0", 10);
  confirmIfPrinting(`Set Nozzle target temperature to ${v}°C`, () => {
    sendGcode(`M104 S${v}`);
  });
}

function setBedTemp() {
  const v = parseInt(document.getElementById("bedTargetInput").value || "0", 10);
  confirmIfPrinting(`Set Heated Bed target temperature to ${v}°C`, () => {
    sendGcode(`M140 S${v}`);
  });
}

function applyPreset(noz, bed, chm, label) {
  confirmIfPrinting(`Apply preset ${label || (noz + "/" + bed + "°C")}`, () => {
    document.getElementById("nozTargetInput").value = noz;
    document.getElementById("bedTargetInput").value = bed;
    sendGcode(`M104 S${noz}\nM140 S${bed}`);
    if (chm > 0) sendGcode(`M141 S${chm}`);
  });
}

function cooldownAll() {
  if (isPrintActive()) {
    if (!confirm(`⚠️ ACTIVE PRINT GUARD\n\nTurn off all heaters (0°C) while ${getActivePrinter().name} is printing? This will ruin the print!`)) {
      return;
    }
  }
  sendGcode("TURN_OFF_HEATERS");
}

function setSpeedFactor(val) {
  confirmIfPrinting(
    `Change Print Speed Factor to ${val}% (M220 S${val})`,
    () => sendGcode(`M220 S${val}`),
    () => pollActivePrinter()
  );
}

function setFlowFactor(val) {
  confirmIfPrinting(
    `Change Extrusion Flow Factor to ${val}% (M221 S${val})`,
    () => sendGcode(`M221 S${val}`),
    () => pollActivePrinter()
  );
}

function setJogStep(step, chipEl) {
  jogStep = step;
  document.querySelectorAll("#stepChips .chip").forEach(c => c.style.borderColor = "var(--border)");
  if (chipEl) chipEl.style.borderColor = "var(--accent)";
}

function jogAxis(axis, dir) {
  const dist = (jogStep * dir).toFixed(2);
  const feed = axis === "Z" ? 600 : 3600;
  confirmIfPrinting(`Jog toolhead ${axis} ${dist}mm`, () => {
    sendGcode(`G91\nG1 ${axis}${dist} F${feed}\nG90`);
  });
}

function extrudeFilament(dir) {
  const len = parseFloat(document.getElementById("extrudeLenInput").value || "10") * dir;
  confirmIfPrinting(`${dir > 0 ? "Extrude" : "Retract"} ${Math.abs(len).toFixed(1)}mm of filament`, () => {
    sendGcode(`M83\nG1 E${len.toFixed(1)} F300`);
  });
}

function adjustZOffset(delta) {
  confirmIfPrinting(`Adjust Z-Offset by ${delta > 0 ? "+" : ""}${delta} mm`, () => {
    sendGcode(`SET_GCODE_OFFSET Z_ADJUST=${delta} MOVE=1`);
  });
}

function setFanPin(pin, pct) {
  const val255 = Math.round((parseInt(pct, 10) / 100) * 255);
  confirmIfPrinting(
    `Set ${pin} fan speed to ${pct}%`,
    () => {
      if (pin === "fan0" && hasStandardFan) {
        sendGcode(`M106 S${val255}`);
      } else {
        sendGcode(`SET_PIN PIN=${pin} VALUE=${val255}`);
      }
    },
    () => pollActivePrinter()
  );
}

/* EXCLUDE OBJECTS */
function renderExcludeObjects() {
  const objs = excludeData.objects || [];
  const excluded = excludeData.excluded_objects || [];
  const cur = excludeData.current_object;

  document.getElementById("excludeCountBadge").innerText = `${objs.length} OBJECTS`;
  const cvs = document.getElementById("excludeCanvas");
  const ctx = cvs.getContext("2d");
  ctx.clearRect(0, 0, cvs.width, cvs.height);

  ctx.strokeStyle = "#1e293b";
  for (let x = 0; x <= cvs.width; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cvs.height); ctx.stroke();
  }
  for (let y = 0; y <= cvs.height; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cvs.width, y); ctx.stroke();
  }

  const listEl = document.getElementById("excludeObjectList");
  if (!objs.length) {
    listEl.innerHTML = `<div style="color:var(--text-muted); font-size:12px;">No multi-object metadata active in current job.</div>`;
    return;
  }

  objs.forEach(o => {
    const isEx = excluded.includes(o.name);
    const isCur = cur === o.name;
    const center = o.center || [130, 130];
    const cx = (center[0] / 260) * cvs.width;
    const cy = cvs.height - (center[1] / 260) * cvs.height;

    ctx.fillStyle = isEx ? "rgba(239,68,68,0.5)" : (isCur ? "rgba(56,189,248,0.75)" : "rgba(34,197,94,0.6)");
    ctx.beginPath();
    ctx.arc(cx, cy, 12, 0, Math.PI * 2);
    ctx.fill();
  });

  listEl.innerHTML = objs.map(o => {
    const isEx = excluded.includes(o.name);
    return `<div style="display:flex; justify-content:space-between; align-items:center; background:#0f172a; padding:6px 10px; border-radius:6px; border:1px solid var(--border);">
      <span style="font-size:12px; font-weight:600;">${escapeHtml(o.name)}</span>
      ${isEx
        ? `<span class="badge error">EXCLUDED</span>`
        : `<button class="btn btn-danger" style="padding:3px 8px; font-size:11px;" onclick="excludePart('${escapeHtml(o.name)}')">Exclude Part</button>`
      }
    </div>`;
  }).join("");
}

function excludePart(name) {
  if (confirm(`Exclude object "${name}" from the remaining print?`)) {
    sendGcode(`EXCLUDE_OBJECT NAME=${name}`);
  }
}

/* MACROS & CONSOLE */
async function discoverPrinterObjects(p, seq) {
  p = p || getActivePrinter();
  try {
    const r = await moonrakerFetch(p, "/printer/objects/list");
    if (seq && seq !== switchSeq) return;
    const d = await r.json();
    const objs = (d.result && d.result.objects) || [];
    discoveredMacros = objs
      .filter(o => o.startsWith("gcode_macro "))
      .map(o => o.replace("gcode_macro ", "").trim())
      .filter(m => !m.startsWith("_"))
      .sort();
    renderMacros("");
  } catch (e) {
    if (seq && seq !== switchSeq) return;
    document.getElementById("macroGrid").innerHTML = `<div style="color:var(--text-muted); font-size:12px;">Macros unavailable (printer offline).</div>`;
  }
}

function renderMacros(filterText) {
  const q = (filterText || "").toLowerCase();
  const grid = document.getElementById("macroGrid");
  const list = discoveredMacros.filter(m => m.toLowerCase().includes(q));
  const countBadge = document.getElementById("macroCountBadge");
  if (countBadge) countBadge.innerText = list.length;
  if (!list.length) {
    grid.innerHTML = `<div style="color:var(--text-muted); font-size:12px;">No macros found.</div>`;
    return;
  }
  grid.innerHTML = list.map(m =>
    `<button class="macro-btn" onclick="safeGcodeAction('${escapeHtml(m)}', 'Run macro ${escapeHtml(m)}')" title="${escapeHtml(m)}"><span>⚡</span><span>${escapeHtml(m)}</span></button>`
  ).join("");
}

async function refreshGcodeStore() {
  const p = getActivePrinter();
  const mySeq = switchSeq;
  try {
    const r = await moonrakerFetch(p, "/server/gcode_store?count=40");
    if (mySeq !== switchSeq) return;
    const d = await r.json();
    const items = (d.result && d.result.gcode_store) || [];
    const box = document.getElementById("consoleBox");
    box.innerHTML = items.map(it => {
      const cls = it.type === "command" ? "cmd" : "resp";
      return `<div class="console-line ${cls}">${escapeHtml(it.message)}</div>`;
    }).join("");
    box.scrollTop = box.scrollHeight;
  } catch (e) {}
}

function appendConsoleLine(txt, cls) {
  const box = document.getElementById("consoleBox");
  if (!box) return;
  const div = document.createElement("div");
  div.className = "console-line " + (cls || "resp");
  div.innerText = txt;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function sendConsoleCommand() {
  const inp = document.getElementById("gcodeInput");
  const cmd = inp.value.trim();
  if (!cmd) return;
  confirmIfPrinting(`Send G-code command: ${cmd}`, () => {
    inp.value = "";
    sendGcode(cmd);
    setTimeout(refreshGcodeStore, 600);
  });
}

/* G-CODE FILE BROWSER, UPLOAD & TIMELAPSES */
function switchFilesSubtab(subtab) {
  const isTl = (subtab === "timelapses");
  document.getElementById("gcodesCard").style.display = isTl ? "none" : "flex";
  document.getElementById("timelapsesCard").style.display = isTl ? "flex" : "none";
  document.getElementById("btnSubtabGcodes").className = isTl ? "btn" : "btn btn-primary";
  document.getElementById("btnSubtabTimelapses").className = isTl ? "btn btn-primary" : "btn";
  if (isTl) loadTimelapses();
}

async function loadTimelapses() {
  const p = getActivePrinter();
  const mySeq = switchSeq;
  const wrap = document.getElementById("timelapseListContainer");
  const badge = document.getElementById("timelapseCountBadge");
  if (!wrap) return;

  let items = [];

  // 1. Check Creality delay_image_info.json (My K2 & K1 SE)
  try {
    const r = await moonrakerFetch(p, "/server/files/config/creality_timelapse/delay_image_info.json");
    if (mySeq !== switchSeq) return;
    if (r.ok) {
      const d = await r.json();
      const list = d.list || d.FileInfo || [];
      items = list.map(it => {
        const vidFile = it.videoname || (it.videoid + ".mp4");
        const covFile = (it.videoid || vidFile.replace(".mp4", "")) + ".png";
        const gname = (it.gcodename || vidFile).replace(/\.gcode$/i, "");
        return {
          title: gname,
          dateStr: it.dateTime || "",
          sizeMb: ((it.size || 0) / (1024 * 1024)).toFixed(2),
          durationSec: it.duration || 0,
          videoUrl: `${baseUrl(p)}/server/files/config/creality_timelapse/video/${encodeURIComponent(vidFile)}`,
          coverUrl: `${baseUrl(p)}/server/files/config/creality_timelapse/cover/${encodeURIComponent(covFile)}`,
          dlName: `${p.name.replace(/\s+/g, "_")}_${gname}_${vidFile}`
        };
      });
    }
  } catch (e) {}

  // 2. Also check standard Moonraker timelapse root (CR-10 Smart)
  if (!items.length) {
    try {
      const r2 = await moonrakerFetch(p, "/server/files/list?root=timelapse");
      if (mySeq !== switchSeq) return;
      if (r2.ok) {
        const d2 = await r2.json();
        const rawFiles = (d2.result) || [];
        const mp4s = rawFiles.filter(f => f.path.toLowerCase().endsWith(".mp4")).sort((a, b) => (b.modified || 0) - (a.modified || 0));
        items = mp4s.map(f => {
          const baseName = f.path.replace(/\.mp4$/i, "");
          const hasThumb = rawFiles.some(x => x.path === baseName + ".jpg");
          return {
            title: baseName.replace(/^timelapse_/, ""),
            dateStr: f.modified ? new Date(f.modified * 1000).toLocaleString() : "",
            sizeMb: ((f.size || 0) / (1024 * 1024)).toFixed(2),
            durationSec: 0,
            videoUrl: `${baseUrl(p)}/server/files/timelapse/${encodeURIComponent(f.path)}`,
            coverUrl: hasThumb ? `${baseUrl(p)}/server/files/timelapse/${encodeURIComponent(baseName + ".jpg")}` : "",
            dlName: `${p.name.replace(/\s+/g, "_")}_${f.path}`
          };
        });
      }
    } catch (e) {}
  }

  if (badge) badge.innerText = items.length;
  if (!items.length) {
    wrap.innerHTML = `<div style="color:var(--text-muted);">No timelapse videos found on ${escapeHtml(p.name)}.</div>`;
    return;
  }

  wrap.innerHTML = items.slice(0, 45).map((it, i) => {
    const durTag = it.durationSec ? ` • ⏱ ${it.durationSec}s` : "";
    return `<div class="file-item" style="flex-wrap:wrap;">
      <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:200px; overflow:hidden;">
        ${it.coverUrl
          ? `<img src="${it.coverUrl}" onerror="this.style.display='none'" style="width:78px; height:56px; object-fit:cover; border-radius:6px; border:1px solid var(--border); flex-shrink:0; background:#050811;" />`
          : `<div style="width:78px; height:56px; border-radius:6px; background:#050811; display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0;">🎬</div>`
        }
        <div style="overflow:hidden;">
          <div style="font-weight:700; word-break:break-all;">${escapeHtml(it.title)}</div>
          <div class="file-meta">${it.sizeMb} MB${durTag} • ${escapeHtml(it.dateStr)}</div>
        </div>
      </div>
      <div style="display:flex; gap:6px; flex-shrink:0;">
        <button class="btn btn-success" onclick="playTimelapse('${escapeHtml(it.videoUrl)}', '${escapeHtml(it.title)}', '${it.sizeMb} MB • ${escapeHtml(it.dateStr)}', '${escapeHtml(it.dlName)}')">▶ Play</button>
        <button class="btn btn-primary" onclick="downloadTimelapseFile('${escapeHtml(it.videoUrl)}', '${escapeHtml(it.dlName)}')">⬇ Save</button>
      </div>
    </div>`;
  }).join("");
}

function playTimelapse(videoUrl, title, meta, dlName) {
  document.getElementById("tlPlayerTitle").innerText = `🎬 ${title}`;
  document.getElementById("tlPlayerMeta").innerText = meta;
  const v = document.getElementById("tlPlayerVideo");
  v.src = videoUrl;
  v.play().catch(() => {});
  const dlBtn = document.getElementById("btnModalDownloadTl");
  dlBtn.onclick = () => downloadTimelapseFile(videoUrl, dlName);
  document.getElementById("timelapsePlayerModal").classList.add("open");
}

function closeTimelapsePlayer() {
  const v = document.getElementById("tlPlayerVideo");
  if (v) {
    v.pause();
    v.removeAttribute("src");
    v.load();
  }
  document.getElementById("timelapsePlayerModal").classList.remove("open");
}

function downloadTimelapseFile(videoUrl, dlName) {
  if (window.AndroidBridge && AndroidBridge.downloadFile) {
    AndroidBridge.downloadFile(videoUrl, dlName);
  } else {
    window.open(videoUrl, "_blank");
  }
}

async function loadGcodeFiles() {
  const p = getActivePrinter();
  const mySeq = switchSeq;
  const wrap = document.getElementById("fileListContainer");
  try {
    const r = await moonrakerFetch(p, "/server/files/list?root=gcodes");
    if (mySeq !== switchSeq) return;
    const d = await r.json();
    const files = ((d.result) || []).sort((a, b) => (b.modified || 0) - (a.modified || 0)).slice(0, 35);
    if (!files.length) {
      wrap.innerHTML = `<div style="color:var(--text-muted);">No G-code files stored on ${escapeHtml(p.name)}.</div>`;
      return;
    }
    wrap.innerHTML = files.map(f => {
      const mb = ((f.size || 0) / (1024 * 1024)).toFixed(2);
      const dateStr = f.modified ? new Date(f.modified * 1000).toLocaleString() : "";
      return `<div class="file-item">
        <div style="overflow:hidden;">
          <div style="font-weight:700; word-break:break-all;">📄 ${escapeHtml(f.path)}</div>
          <div class="file-meta">${mb} MB • ${dateStr}</div>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button class="btn btn-success" onclick="startPrintFile('${escapeHtml(f.path)}')">▶ Print</button>
          <button class="btn btn-danger" onclick="deleteGcodeFile('${escapeHtml(f.path)}')">🗑</button>
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    if (mySeq !== switchSeq) return;
    wrap.innerHTML = `<div style="color:var(--red);">Could not load files from ${escapeHtml(p.name)} (${p.host}).</div>`;
  }
}

async function startPrintFile(filename) {
  if (isPrintActive()) {
    alert(`Cannot start a new print while ${getActivePrinter().name} is actively printing!`);
    return;
  }
  if (!confirm(`Start printing "${filename}" on ${getActivePrinter().name}?`)) return;
  const p = getActivePrinter();
  await moonrakerFetch(p, `/printer/print/start?filename=${encodeURIComponent(filename)}`, {
    method: "POST"
  });
  switchTab("dashboard", document.querySelector(".nav-item"));
  pollActivePrinter();
}

async function deleteGcodeFile(filename) {
  if (!confirm(`Delete "${filename}" from printer storage?`)) return;
  const p = getActivePrinter();
  await moonrakerFetch(p, `/server/files/gcodes/${encodeURIComponent(filename)}`, {
    method: "DELETE"
  });
  loadGcodeFiles();
}

async function uploadGcodeFile(inputEl) {
  if (!inputEl.files || !inputEl.files.length) return;
  const file = inputEl.files[0];
  const p = getActivePrinter();
  const fd = new FormData();
  fd.append("file", file, file.name);
  fd.append("root", "gcodes");

  const headers = {};
  if (p.apiKey) headers["X-Api-Key"] = p.apiKey;

  try {
    const r = await fetch(`${baseUrl(p)}/server/files/upload`, {
      method: "POST",
      headers: headers,
      body: fd
    });
    if (r.ok) {
      alert(`Uploaded ${file.name} successfully!`);
      loadGcodeFiles();
    } else {
      alert(`Upload failed: HTTP ${r.status}`);
    }
  } catch (e) {
    alert(`Upload error: ${e.message}`);
  }
  inputEl.value = "";
}

/* TAB 5: MAINSAIL MACHINE, CONFIG FILES, KLIPPER LIMITS & SOFTWARE UPDATES */
async function loadMachineTabInfo(p, seq) {
  p = p || getActivePrinter();
  loadMachineFiles(currentMachineRoot);
  loadUpdateStatus(false);

  try {
    const [infoRes, procRes] = await Promise.all([
      moonrakerFetch(p, "/printer/info"),
      moonrakerFetch(p, "/machine/proc_stats")
    ]);
    if (seq && seq !== switchSeq) return;
    if (infoRes.ok) {
      const info = (await infoRes.json()).result || {};
      document.getElementById("sysHostname").innerText = info.hostname || p.name;
      document.getElementById("sysKlipperVer").innerText = info.software_version || "--";
    }
    if (procRes.ok) {
      const proc = (await procRes.json()).result || {};
      const stats = proc.moonraker_stats || [];
      const last = stats[stats.length - 1];
      if (last) {
        const mb = Math.round((last.memory || 0) / 1024);
        document.getElementById("sysCpuMem").innerText = `${(last.cpu_usage || 0).toFixed(1)}% / ${mb}MB`;
      }
    }
  } catch (e) {}
}

async function loadMachineFiles(rootName) {
  currentMachineRoot = rootName || "config";
  document.getElementById("btnRootConfig").className = currentMachineRoot === "config" ? "btn btn-primary" : "btn";
  document.getElementById("btnRootLogs").className = currentMachineRoot === "logs" ? "btn btn-primary" : "btn";

  const p = getActivePrinter();
  const mySeq = switchSeq;
  const wrap = document.getElementById("machineFileList");
  wrap.innerHTML = `<div style="color:var(--text-muted);">Loading ${currentMachineRoot} files from ${escapeHtml(p.name)}...</div>`;

  try {
    const r = await moonrakerFetch(p, `/server/files/list?root=${encodeURIComponent(currentMachineRoot)}`);
    if (mySeq !== switchSeq) return;
    const d = await r.json();
    machineFilesCache = ((d.result) || [])
      .filter(f => !f.path.includes(".git/") && !f.path.startsWith("backups/"))
      .sort((a, b) => {
        if (a.path === "printer.cfg") return -1;
        if (b.path === "printer.cfg") return 1;
        return a.path.localeCompare(b.path);
      });
    renderMachineFiles("");
  } catch (e) {
    if (mySeq !== switchSeq) return;
    wrap.innerHTML = `<div style="color:var(--red);">Unable to load ${currentMachineRoot} files (${escapeHtml(p.name)} offline).</div>`;
  }
}

function renderMachineFiles(filterText) {
  const q = (filterText || "").toLowerCase();
  const wrap = document.getElementById("machineFileList");
  const filtered = machineFilesCache.filter(f => f.path.toLowerCase().includes(q)).slice(0, 60);
  if (!filtered.length) {
    wrap.innerHTML = `<div style="color:var(--text-muted);">No matching files in ${currentMachineRoot}.</div>`;
    return;
  }
  const isWritable = currentMachineRoot === "config";
  wrap.innerHTML = filtered.map(f => {
    const kb = ((f.size || 0) / 1024).toFixed(1);
    return `<div class="file-item">
      <div style="overflow:hidden;">
        <div style="font-weight:700; word-break:break-all;">${isWritable ? "⚙️" : "📋"} ${escapeHtml(f.path)}</div>
        <div class="file-meta">${kb} KB</div>
      </div>
      <div style="display:flex; gap:6px; flex-shrink:0;">
        <button class="btn btn-primary" onclick="openConfigEditor('${currentMachineRoot}', '${escapeHtml(f.path)}')">
          ${isWritable ? "✏️ Edit" : "👁 View"}
        </button>
      </div>
    </div>`;
  }).join("");
}

async function openConfigEditor(rootName, filePath) {
  const p = getActivePrinter();
  editingFileRoot = rootName;
  editingFilePath = filePath;

  document.getElementById("editorFileTitle").innerText = `📝 ${p.name} • ${rootName}/${filePath}`;
  const ta = document.getElementById("configEditorTextarea");
  const statusEl = document.getElementById("editorStatusText");
  ta.value = "Loading file contents...";
  ta.readOnly = (rootName !== "config");
  statusEl.innerText = "Fetching from Moonraker...";
  document.getElementById("configEditorModal").classList.add("open");

  try {
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    const r = await moonrakerFetch(p, `/server/files/${rootName}/${encodedPath}`, { timeout: 6000 });
    if (!r.ok) throw new Error("HTTP " + r.status);
    let txt = await r.text();
    if (txt.length > 180000) {
      txt = txt.slice(txt.length - 180000);
      statusEl.innerText = `Showing last 180 KB (${rootName})`;
    } else {
      statusEl.innerText = `${txt.length} bytes loaded`;
    }
    ta.value = txt;
  } catch (e) {
    ta.value = `Failed to load ${filePath}: ${e.message}`;
    statusEl.innerText = "Error loading file";
  }
}

function createNewConfigFile() {
  const fname = prompt("Enter new config file name (e.g. custom_macros.cfg):");
  if (!fname) return;
  editingFileRoot = "config";
  editingFilePath = fname.trim();
  document.getElementById("editorFileTitle").innerText = `📝 ${getActivePrinter().name} • config/${editingFilePath}`;
  const ta = document.getElementById("configEditorTextarea");
  ta.readOnly = false;
  ta.value = "# New Klipper config file\n";
  document.getElementById("editorStatusText").innerText = "New file (unsaved)";
  document.getElementById("configEditorModal").classList.add("open");
}

function closeConfigEditor() {
  document.getElementById("configEditorModal").classList.remove("open");
}

async function saveConfigEditorFile(restartAfter) {
  if (editingFileRoot !== "config") {
    alert("Log files are read-only.");
    return;
  }
  const p = getActivePrinter();
  if (restartAfter && isPrintActive()) {
    if (!confirm(`⚠️ ${p.name} is currently printing!\n\nSaving and running FIRMWARE_RESTART will abort the ongoing print. Proceed anyway?`)) {
      return;
    }
  } else if (isPrintActive()) {
    if (!confirm(`Save changes to ${editingFilePath} while ${p.name} is printing?`)) {
      return;
    }
  }

  const content = document.getElementById("configEditorTextarea").value;
  const statusEl = document.getElementById("editorStatusText");
  statusEl.innerText = "Uploading to Moonraker...";

  const parts = editingFilePath.split("/");
  const fileNameOnly = parts.pop();
  const subPath = parts.join("/");

  const blob = new Blob([content], { type: "text/plain" });
  const fd = new FormData();
  fd.append("file", blob, fileNameOnly);
  fd.append("root", "config");
  if (subPath) fd.append("path", subPath);

  const headers = {};
  if (p.apiKey) headers["X-Api-Key"] = p.apiKey;

  try {
    const r = await fetch(`${baseUrl(p)}/server/files/upload`, {
      method: "POST",
      headers,
      body: fd
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    statusEl.innerText = "Saved successfully!";
    loadMachineFiles("config");
    if (restartAfter) {
      sendGcode("FIRMWARE_RESTART");
      closeConfigEditor();
    }
  } catch (e) {
    statusEl.innerText = "Save failed: " + e.message;
    alert("Failed to save config file: " + e.message);
  }
}

function applyMachineLimit(paramName, inputId) {
  const val = parseFloat(document.getElementById(inputId).value || "0");
  if (isNaN(val) || val <= 0) return;
  safeGcodeAction(
    `SET_VELOCITY_LIMIT ${paramName}=${val}`,
    `Set Klipper ${paramName} limit to ${val}`
  );
}

function applyPressureAdvance() {
  const val = parseFloat(document.getElementById("inpPressureAdv").value || "0");
  if (isNaN(val) || val < 0) return;
  safeGcodeAction(
    `SET_PRESSURE_ADVANCE ADVANCE=${val}`,
    `Set Pressure Advance to ${val}`
  );
}

async function loadUpdateStatus(forceRefresh) {
  const p = getActivePrinter();
  const mySeq = switchSeq;
  const wrap = document.getElementById("updateManagerList");
  if (forceRefresh) {
    wrap.innerHTML = `<div style="color:var(--text-muted);">Checking for software updates on ${escapeHtml(p.name)}...</div>`;
  }
  try {
    const endpoint = forceRefresh ? "/machine/update/refresh" : "/machine/update/status";
    const method = forceRefresh ? "POST" : "GET";
    const r = await moonrakerFetch(p, endpoint, { method, timeout: forceRefresh ? 12000 : 3500 });
    if (mySeq !== switchSeq) return;
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    const vInfo = (d.result && d.result.version_info) || {};
    const keys = Object.keys(vInfo);
    if (!keys.length) {
      wrap.innerHTML = `<div style="color:var(--text-muted);">No update manager items configured on ${escapeHtml(p.name)}.</div>`;
      return;
    }

    wrap.innerHTML = keys.map(k => {
      const item = vInfo[k] || {};
      if (k === "system") {
        const pkgCount = item.package_count || 0;
        const upToDate = pkgCount === 0;
        return `<div class="file-item">
          <div>
            <div style="font-weight:700;">🐧 OS System Packages</div>
            <div class="file-meta">${pkgCount} package(s) upgradable</div>
          </div>
          <div>
            ${upToDate
              ? `<span class="badge ready">UP TO DATE</span>`
              : `<button class="btn btn-primary" onclick="triggerSoftwareUpdate('system', 'OS System Packages')">⬆️ Update (${pkgCount})</button>`
            }
          </div>
        </div>`;
      }
      const curVer = item.version || "?";
      const remVer = item.remote_version || curVer;
      const needsUpdate = (curVer !== "?" && remVer !== "?" && curVer !== remVer);
      const dirtyTag = item.is_dirty ? " (dirty)" : "";
      return `<div class="file-item">
        <div>
          <div style="font-weight:700;">📦 ${escapeHtml(k)}</div>
          <div class="file-meta">Installed: ${escapeHtml(curVer)}${dirtyTag} • Remote: ${escapeHtml(remVer)}</div>
        </div>
        <div>
          ${needsUpdate
            ? `<button class="btn btn-primary" onclick="triggerSoftwareUpdate('${escapeHtml(k)}', '${escapeHtml(k)}')">⬆️ Update</button>`
            : `<span class="badge ready">UP TO DATE</span>`
          }
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    if (mySeq !== switchSeq) return;
    wrap.innerHTML = `<div style="color:var(--text-muted);">Update Manager unavailable on ${escapeHtml(p.name)}.</div>`;
  }
}

async function triggerSoftwareUpdate(target, label) {
  const p = getActivePrinter();
  if (isPrintActive()) {
    alert(`Cannot run software updates while ${p.name} is actively printing!`);
    return;
  }
  if (!confirm(`Update ${label} on ${p.name}?\n\nKlipper/Moonraker may restart during the update.`)) return;

  let path = `/machine/update/client?name=${encodeURIComponent(target)}`;
  if (target === "full" || target === "klipper" || target === "moonraker" || target === "system") {
    path = `/machine/update/${target}`;
  }
  try {
    const r = await moonrakerFetch(p, path, { method: "POST", timeout: 30000 });
    if (r.ok) {
      alert(`Update started for ${label}!`);
      loadUpdateStatus(false);
    } else {
      alert(`Update request returned HTTP ${r.status}`);
    }
  } catch (e) {
    alert(`Update triggered (connection may reset while services restart).`);
  }
}

async function rebootPrinterHost() {
  const p = getActivePrinter();
  if (!confirm(`⚠️ Reboot the entire Linux host on ${p.name} (${p.host})?${isPrintActive() ? "\n\nDANGER: A print is currently running!" : ""}`)) return;
  await moonrakerFetch(p, "/machine/reboot", { method: "POST" });
}

/* MULTI-PRINTER FARM OVERVIEW */
async function pollFarmPrinters() {
  const grid = document.getElementById("farmGrid");
  const cards = await Promise.all(printers.map(async (p, idx) => {
    try {
      const r = await moonrakerFetch(p, "/printer/objects/query?webhooks&print_stats&virtual_sdcard&extruder&heater_bed");
      if (!r.ok) throw new Error("offline");
      const d = await r.json();
      const st = d.result.status;
      const whState = (st.webhooks && st.webhooks.state) || "ready";
      const psState = (st.print_stats && st.print_stats.state) || "ready";
      const state = (whState === "shutdown" || whState === "error") ? whState : psState;
      const prog = Math.round(((st.virtual_sdcard && st.virtual_sdcard.progress) || 0) * 100);
      const noz = st.extruder ? st.extruder.temperature.toFixed(1) : "0.0";
      const bed = st.heater_bed ? st.heater_bed.temperature.toFixed(1) : "0.0";
      const fname = (st.print_stats && st.print_stats.filename) || (whState === "shutdown" ? "MCU Shutdown" : "Idle");
      farmStatusCache[p.id] = state;

      let snapUrl = resolveCamUrl(p, "/webcam/?action=snapshot");
      try {
        const wcRes = await moonrakerFetch(p, "/server/webcams/list");
        if (wcRes.ok) {
          const wcData = await wcRes.json();
          const firstCam = ((wcData.result && wcData.result.webcams) || []).find(c => c.enabled !== false);
          if (firstCam && firstCam.snapshot_url) {
            snapUrl = resolveCamUrl(p, firstCam.snapshot_url);
          }
        }
      } catch (e) {}
      const sep = snapUrl.includes("?") ? "&" : "?";

      return `<div class="card" onclick="selectPrinter(${idx}); switchTab('dashboard', document.querySelector('.nav-item'));" style="cursor:pointer;">
        <div class="card-header">
          <div class="card-title">🖨️ ${escapeHtml(p.name)} <span style="font-size:11px; color:var(--text-muted);">(${p.host})</span></div>
          <span class="badge ${state === 'shutdown' ? 'error' : state}">${state.toUpperCase()}</span>
        </div>
        <img src="${snapUrl}${sep}t=${Date.now()}" onerror="this.style.display='none'" style="width:100%; height:150px; object-fit:cover; border-radius:8px; background:#050811;" />
        <div style="font-size:13px; font-weight:700;">${escapeHtml(fname)} (${prog}%)</div>
        <div class="progress-wrap"><div class="progress-fill" style="width:${prog}%;"></div></div>
        <div style="font-size:12px; color:var(--text-muted);">🔥 Nozzle: ${noz}°C &nbsp;|&nbsp; 🛏️ Bed: ${bed}°C</div>
      </div>`;
    } catch (e) {
      farmStatusCache[p.id] = "offline";
      return `<div class="card">
        <div class="card-header">
          <div class="card-title">🖨️ ${escapeHtml(p.name)} <span style="font-size:11px; color:var(--text-muted);">(${p.host})</span></div>
          <span class="badge offline">OFFLINE</span>
        </div>
        <div style="color:var(--text-muted); font-size:12px; padding:16px 0;">Printer unreachable on LAN (${p.host}:${p.port}).</div>
        <button class="btn" onclick="selectPrinter(${idx}); switchTab('dashboard', document.querySelector('.nav-item'));">Select Printer</button>
      </div>`;
    }
  }));
  if (grid) grid.innerHTML = cards.join("");
  renderPrinterPills();
}

/* PRINTER MODAL & NATIVE NOTIFICATIONS */
function openPrinterModal() {
  renderManagePrintersList();
  if (window.AndroidBridge && AndroidBridge.getAppVersionInfo) {
    try {
      const v = JSON.parse(AndroidBridge.getAppVersionInfo());
      const lbl = document.getElementById("lblCurrentAppVersion");
      if (lbl) lbl.innerText = `Version: ${v.versionName} (Build ${v.versionCode})`;
    } catch (e) {}
  }
  const savedRepo = localStorage.getItem("klipper_github_repo") || "";
  const inpRepo = document.getElementById("inpGithubRepo");
  if (inpRepo) inpRepo.value = savedRepo;
  document.getElementById("printerModal").classList.add("open");
}

function closePrinterModal() {
  document.getElementById("printerModal").classList.remove("open");
}

/* IN-APP UPDATER (GITHUB RELEASES & DIRECT OTA) */
let pendingUpdateApkUrl = "";
let currentAppVersionName = "1.0.0";
let currentAppVersionCode = 1;

function getGithubRepo() {
  return localStorage.getItem("klipper_github_repo") || "";
}

function saveGithubRepo(val) {
  localStorage.setItem("klipper_github_repo", (val || "").trim());
  showToast("GitHub repository saved");
}

function closeUpdateModal() {
  const m = document.getElementById("updateModal");
  if (m) m.classList.remove("open");
}

async function checkForAppUpdate(isManual = false) {
  if (window.AndroidBridge && AndroidBridge.getAppVersionInfo) {
    try {
      const v = JSON.parse(AndroidBridge.getAppVersionInfo());
      currentAppVersionCode = v.versionCode || 1;
      currentAppVersionName = v.versionName || "1.0.0";
    } catch (e) {}
  }

  const repo = getGithubRepo();
  if (!repo) {
    if (isManual) {
      alert("Please enter your GitHub repository (e.g. your-username/klipperraker) in Settings to check for updates.");
    }
    return;
  }

  try {
    if (isManual) showToast("Checking GitHub for updates...");
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const res = await fetch(apiUrl, { headers: { "Accept": "application/vnd.github.v3+json" } });
    if (!res.ok) {
      if (isManual) showToast(`No releases found on GitHub (${res.status})`);
      return;
    }
    const release = await res.json();
    const tagName = (release.tag_name || "").replace(/^v/, "");
    const apkAsset = (release.assets || []).find(a => a.name && a.name.endsWith(".apk"));
    if (!apkAsset || !apkAsset.browser_download_url) {
      if (isManual) showToast("Latest release has no APK attached.");
      return;
    }

    const isNewer = isVersionNewer(tagName, currentAppVersionName);
    if (isNewer) {
      pendingUpdateApkUrl = apkAsset.browser_download_url;
      document.getElementById("updateNewVersion").innerText = `v${tagName}`;
      document.getElementById("updateCurrentVersion").innerText = `Current: v${currentAppVersionName}`;
      document.getElementById("updateChangelog").innerText = release.body || "• Performance enhancements and bug fixes.";
      document.getElementById("updateProgressWrap").style.display = "none";
      document.getElementById("updatePermissionNote").style.display = "none";
      document.getElementById("btnStartUpdate").style.display = "inline-flex";
      document.getElementById("btnStartUpdate").innerText = "📥 Download & Install";
      document.getElementById("btnStartUpdate").onclick = startAppUpdateDownload;
      document.getElementById("btnUpdateLater").style.display = "inline-flex";
      document.getElementById("updateModal").classList.add("open");
    } else {
      if (isManual) {
        showToast(`✅ Klipperraker Pro is up to date (v${currentAppVersionName})!`);
      }
    }
  } catch (err) {
    if (isManual) showToast("Failed checking GitHub: " + err.message);
  }
}

function isVersionNewer(remoteVer, currentVer) {
  const rParts = (remoteVer || "0").split(".").map(n => parseInt(n, 10) || 0);
  const cParts = (currentVer || "0").split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(rParts.length, cParts.length); i++) {
    const r = rParts[i] || 0;
    const c = cParts[i] || 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}

function startAppUpdateDownload() {
  if (!pendingUpdateApkUrl) return;
  const wrap = document.getElementById("updateProgressWrap");
  const bar = document.getElementById("updateProgressBar");
  const pctTxt = document.getElementById("updateProgressPct");
  const statTxt = document.getElementById("updateProgressStatus");
  const btnStart = document.getElementById("btnStartUpdate");
  const btnLater = document.getElementById("btnUpdateLater");

  wrap.style.display = "block";
  bar.style.width = "0%";
  pctTxt.innerText = "0%";
  statTxt.innerText = "Connecting to download...";
  btnStart.style.display = "none";
  btnLater.style.display = "none";

  if (window.AndroidBridge && AndroidBridge.downloadAndInstallApk) {
    AndroidBridge.downloadAndInstallApk(pendingUpdateApkUrl, "app_update");
  } else {
    window.location.href = pendingUpdateApkUrl;
  }
}

window.__onUpdateDownloadProgress = function(cbId, downloaded, total, pct, status) {
  const bar = document.getElementById("updateProgressBar");
  const pctTxt = document.getElementById("updateProgressPct");
  const statTxt = document.getElementById("updateProgressStatus");
  const btnStart = document.getElementById("btnStartUpdate");
  const permNote = document.getElementById("updatePermissionNote");

  if (pct >= 0) {
    bar.style.width = pct + "%";
    pctTxt.innerText = pct + "%";
  }

  if (status === "DOWNLOADING") {
    const mbDownloaded = (downloaded / (1024 * 1024)).toFixed(1);
    const mbTotal = total > 0 ? (total / (1024 * 1024)).toFixed(1) + " MB" : "";
    statTxt.innerText = `Downloading APK: ${mbDownloaded} / ${mbTotal}`;
  } else if (status === "READY" || status === "INSTALLING") {
    statTxt.innerText = "Launching Android package installer...";
    bar.style.width = "100%";
    pctTxt.innerText = "100%";
  } else if (status === "PERMISSION_REQUIRED") {
    statTxt.innerText = "Permission required to install update";
    permNote.style.display = "block";
    btnStart.style.display = "inline-flex";
    btnStart.innerText = "🚀 Tap to Install";
    btnStart.onclick = function() {
      if (window.AndroidBridge && AndroidBridge.triggerInstallApk) {
        AndroidBridge.triggerInstallApk("manual_install");
      }
    };
  } else if (status && status.startsWith("ERROR")) {
    statTxt.innerText = status;
    btnStart.style.display = "inline-flex";
    btnStart.innerText = "🔄 Retry Download";
    btnStart.onclick = startAppUpdateDownload;
    document.getElementById("btnUpdateLater").style.display = "inline-flex";
  }
};

function renderManagePrintersList() {
  const el = document.getElementById("printerManageList");
  el.innerHTML = printers.map((p, i) =>
    `<div style="display:flex; justify-content:space-between; align-items:center; background:#0f172a; padding:6px 10px; border-radius:6px; border:1px solid var(--border);">
      <span><b>${escapeHtml(p.name)}</b> (${p.host}:${p.port})</span>
      ${printers.length > 1 ? `<button class="btn btn-danger" style="padding:3px 8px; font-size:11px;" onclick="removePrinter(${i})">Remove</button>` : ''}
    </div>`
  ).join("");
}

function removePrinter(idx) {
  printers.splice(idx, 1);
  if (activePrinterIdx >= printers.length) activePrinterIdx = 0;
  persistPrinters();
  renderManagePrintersList();
  renderPrinterPills();
}

function saveNewPrinter() {
  const name = document.getElementById("inpPrinterName").value.trim();
  const host = document.getElementById("inpPrinterHost").value.trim();
  const port = parseInt(document.getElementById("inpPrinterPort").value || "7125", 10);
  const webPort = parseInt(document.getElementById("inpPrinterWebPort").value || "4408", 10);
  const apiKey = document.getElementById("inpPrinterKey").value.trim();
  if (!name || !host) {
    alert("Please enter both a printer name and IP/hostname.");
    return;
  }
  printers.push({
    id: "p-" + Date.now(),
    name,
    host,
    port,
    webPort,
    apiKey,
    camMode: "mjpeg"
  });
  persistPrinters();
  closePrinterModal();
  selectPrinter(printers.length - 1);
}

function toggleBgMonitor() {
  bgMonitorOn = !bgMonitorOn;
  updateBgMonitorBtn();
  try {
    if (window.AndroidBridge && AndroidBridge.setBackgroundMonitorEnabled) {
      AndroidBridge.setBackgroundMonitorEnabled(bgMonitorOn);
    }
  } catch (e) {}
}

function updateBgMonitorBtn() {
  const btn = document.getElementById("btnToggleBgMonitor");
  if (!btn) return;
  btn.innerText = `🔔 Background Print Monitor: ${bgMonitorOn ? "ON" : "OFF"}`;
  btn.className = bgMonitorOn ? "btn btn-primary" : "btn";
}

function testTabletNotification() {
  const p = getActivePrinter();
  if (window.AndroidBridge && AndroidBridge.sendLocalNotification) {
    AndroidBridge.sendLocalNotification(`${p.name}: Test Print Alert`, "Background print notifications are active on your Fire tablet!");
  } else {
    alert("Test notification sent!");
  }
}

function saveSocksPort() {
  const port = parseInt(document.getElementById("inpSocksPort").value || "25344", 10);
  if (window.AndroidBridge && AndroidBridge.setSocksPort) {
    AndroidBridge.setSocksPort(port);
    AndroidBridge.showToast("Saved WG Tunnel SOCKS5 port: " + port);
  }
  pollActivePrinter();
}

/* HELPERS */
function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function showToast(msg) {
  if (window.AndroidBridge && AndroidBridge.showToast) {
    AndroidBridge.showToast(msg);
  } else {
    console.log("[Toast]", msg);
  }
}

/* AUTOMATIC NETWORK SWITCH & PULL-TO-REFRESH */
let currentNetworkMode = (window.AndroidBridge && AndroidBridge.isWifiConnected && AndroidBridge.isWifiConnected()) ? "wifi" : "remote";
let lastNetworkSwitch = 0;

window.onNetworkStateChanged = function() {
  const isOff = !!(window.AndroidBridge && AndroidBridge.isWifiConnected && !AndroidBridge.isWifiConnected());
  const newMode = isOff ? "remote" : "wifi";

  if (newMode === currentNetworkMode) {
    // Mode has not actually changed! Ignore spurious background capability events.
    return;
  }

  const now = Date.now();
  if (now - lastNetworkSwitch < 1500) return;
  lastNetworkSwitch = now;

  console.log(`Network mode transitioned: ${currentNetworkMode} -> ${newMode}`);
  currentNetworkMode = newMode;
  forceReconnectAll(true);
};

function forceReconnectAll(isAuto) {
  const isOff = !!(window.AndroidBridge && AndroidBridge.isWifiConnected && !AndroidBridge.isWifiConnected());
  currentNetworkMode = isOff ? "remote" : "wifi";
  showToast(isOff ? "Switched to 5G Remote (WG Tunnel)" : "Switched to Home Wi-Fi (Direct)");

  consecutivePollFailures = 0;
  const mySeq = ++switchSeq;
  const p = getActivePrinter();
  if (p) {
    // If switching network, restart webcam stream cleanly
    discoverWebcamsAndStart(p, mySeq);
    discoverPrinterObjects(p, mySeq);
    pollActivePrinter();
  }
  pollFarmPrinters();
}

// Pull-to-refresh gesture
function setupPullToRefresh() {
  const container = document.getElementById("mainContent") || document.querySelector(".main-content");
  const banner = document.getElementById("pullToRefreshBanner");
  const textEl = document.getElementById("pullRefreshText");
  const iconEl = document.getElementById("pullRefreshIcon");
  if (!container || !banner) return;

  let startY = 0;
  let isDragging = false;

  container.addEventListener("touchstart", (e) => {
    if (container.scrollTop <= 2) {
      startY = e.touches[0].clientY;
      isDragging = true;
    } else {
      isDragging = false;
    }
  }, { passive: true });

  container.addEventListener("touchmove", (e) => {
    if (!isDragging) return;
    const currentY = e.touches[0].clientY;
    const diff = currentY - startY;
    if (diff > 25 && container.scrollTop <= 2) {
      banner.style.display = "block";
      if (diff > 85) {
        textEl.innerText = "Release to Reconnect & Refresh!";
        iconEl.innerText = "🔄";
      } else {
        textEl.innerText = "Pull down to reconnect...";
        iconEl.innerText = "⬇️";
      }
    }
  }, { passive: true });

  container.addEventListener("touchend", (e) => {
    if (!isDragging) return;
    isDragging = false;
    const currentY = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientY : startY;
    const diff = currentY - startY;
    if (diff > 85 && container.scrollTop <= 2) {
      textEl.innerText = "Reconnecting now...";
      iconEl.innerText = "⚡";
      forceReconnectAll(false);
      setTimeout(() => {
        banner.style.display = "none";
      }, 900);
    } else {
      banner.style.display = "none";
    }
  });
}

const originalInitApp = initApp;
initApp = function() {
  originalInitApp();
  setupPullToRefresh();
  window.addEventListener("resize", () => {
    drawTempChart();
    renderExcludeObjects();
  });
  window.addEventListener("orientationchange", () => {
    setTimeout(() => {
      drawTempChart();
      renderExcludeObjects();
    }, 150);
  });
  setTimeout(() => {
    checkForAppUpdate(false);
  }, 4000);
};

window.addEventListener("DOMContentLoaded", initApp);
