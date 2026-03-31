
(function () {
  "use strict";

  var WS_WAIT_MS = 15000;
  var HISTORY_WINDOW_MS = 120000;
  var SHELLY1_BASE_URL = "http://192.168.178.52";
  var SHELLY2_BASE_URL = "http://192.168.178.53";
  var DB_NAME = "shelly-history-db";
  var DB_VERSION = 2;
  var SESSIONS_STORE = "sessions";
  var SAMPLES_STORE = "samples";

  var form = document.getElementById("form");
  var btnConnect = document.getElementById("btnConnect");
  var btnClearHistory = document.getElementById("btnClearHistory");
  var noteEl = document.getElementById("note");
  var errEl = document.getElementById("err");
  var out = document.getElementById("out");
  var powerValueEl = document.getElementById("powerValue");
  var powerValueEl2 = document.getElementById("powerValue2");
  var powerValueEl3 = document.getElementById("powerValue3");
  var chartCanvas = document.getElementById("powerChart");
  var legendLoadValueEl = document.getElementById("legendLoadValue");
  var legendGridValueEl = document.getElementById("legendGridValue");
  var legendSolarValueEl = document.getElementById("legendSolarValue");
  var storageMetaEl = document.getElementById("storageMeta");
  var historySessionsEl = document.getElementById("historySessions");
  var historyEmptyEl = document.getElementById("historyEmpty");
  var tabButtons = Array.prototype.slice.call(document.querySelectorAll("[data-tab-target]"));
  var tabPanels = Array.prototype.slice.call(document.querySelectorAll("[data-tab-panel]"));

  var wsConn = null;
  var wsConn2 = null;
  var waitTimer = null;
  var waitTimer2 = null;
  var updateIntervalId = null;
  var updateIntervalId2 = null;
  var chartRefreshIntervalId = null;
  var historyDbPromise = null;
  var userClosed = false;
  var netzbezug = 0;
  var solar = 0;
  var powerHistory = [];
  var currentSessionId = null;
  var sessionList = [];
  var storageStats = { sessions: 0, samples: 0, lastStart: null };

  function appendNote(msg) {
    if (!msg || !noteEl) return;
    noteEl.textContent = noteEl.hidden || !noteEl.textContent ? msg : noteEl.textContent + " " + msg;
    noteEl.hidden = false;
  }

  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg || "";
    errEl.hidden = !msg;
  }

  function showNote(msg) {
    if (!noteEl) return;
    noteEl.textContent = msg || "";
    noteEl.hidden = !msg;
  }

  function setOut(msg) {
    if (!out) return;
    out.textContent = msg || "";
  }

  function updateVerbrauch() {
    var verbrauch = netzbezug - solar;
    if (powerValueEl3) powerValueEl3.textContent = verbrauch.toFixed(1);
  }

  function formatWatts(value) {
    return Number(value || 0).toFixed(1) + " W";
  }

  function formatShortDateTime(timestamp) {
    if (!timestamp) return "offen";
    return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(timestamp));
  }

  function formatLongDateTime(timestamp) {
    if (!timestamp) return "laeuft";
    return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp));
  }

  function formatDuration(startedAt, stoppedAt) {
    if (!startedAt) return "-";
    var end = stoppedAt || Date.now();
    var totalSeconds = Math.max(0, Math.round((end - startedAt) / 1000));
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;

    if (hours > 0) return hours + "h " + String(minutes).padStart(2, "0") + "m";
    if (minutes > 0) return minutes + "m " + String(seconds).padStart(2, "0") + "s";
    return seconds + "s";
  }

  function getNiceStep(rawStep) {
    if (!isFinite(rawStep) || rawStep <= 0) return 1;
    var exponent = Math.floor(Math.log(rawStep) / Math.LN10);
    var fraction = rawStep / Math.pow(10, exponent);
    var niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return niceFraction * Math.pow(10, exponent);
  }

  function updateLegendValues() {
    if (legendLoadValueEl) legendLoadValueEl.textContent = formatWatts(netzbezug - solar);
    if (legendGridValueEl) legendGridValueEl.textContent = formatWatts(netzbezug);
    if (legendSolarValueEl) legendSolarValueEl.textContent = formatWatts(solar);
  }

  function supportsIndexedDb() {
    return typeof window.indexedDB !== "undefined";
  }

  function setConnectUi(connected) {
    if (!btnConnect) return;
    btnConnect.textContent = connected ? "Stop" : "Start";
    btnConnect.setAttribute("aria-pressed", connected ? "true" : "false");
  }

  function setActiveTab(tabName) {
    tabButtons.forEach(function (button) {
      var isActive = button.getAttribute("data-tab-target") === tabName;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    tabPanels.forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-tab-panel") !== tabName;
    });
  }

  function updateStorageUi() {
    if (!storageMetaEl) return;

    if (!supportsIndexedDb()) {
      storageMetaEl.textContent = "IndexedDB wird von diesem Browser nicht unterstuetzt.";
    } else if (!storageStats.sessions) {
      storageMetaEl.textContent = "Noch keine gespeicherten Sessions.";
    } else {
      storageMetaEl.textContent = storageStats.sessions + " Sessions mit " + storageStats.samples + " Messpunkten. Letzter Start: " + formatShortDateTime(storageStats.lastStart) + ".";
    }

    if (btnClearHistory) btnClearHistory.disabled = !supportsIndexedDb() || storageStats.sessions === 0;
  }

  function openHistoryDb() {
    if (!supportsIndexedDb()) return Promise.reject(new Error("IndexedDB wird nicht unterstuetzt."));
    if (historyDbPromise) return historyDbPromise;

    historyDbPromise = new Promise(function (resolve, reject) {
      var request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function (event) {
        var db = event.target.result;
        var transaction = event.target.transaction;
        var sessionsStore;
        var samplesStore;

        if (!db.objectStoreNames.contains(SESSIONS_STORE)) sessionsStore = db.createObjectStore(SESSIONS_STORE, { keyPath: "id", autoIncrement: true });
        else sessionsStore = transaction.objectStore(SESSIONS_STORE);

        if (!sessionsStore.indexNames.contains("startedAt")) sessionsStore.createIndex("startedAt", "startedAt", { unique: false });

        if (!db.objectStoreNames.contains(SAMPLES_STORE)) samplesStore = db.createObjectStore(SAMPLES_STORE, { keyPath: "id", autoIncrement: true });
        else samplesStore = transaction.objectStore(SAMPLES_STORE);

        if (!samplesStore.indexNames.contains("t")) samplesStore.createIndex("t", "t", { unique: false });
        if (!samplesStore.indexNames.contains("sessionId")) samplesStore.createIndex("sessionId", "sessionId", { unique: false });
      };

      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB konnte nicht geoeffnet werden.")); };
    });

    return historyDbPromise;
  }
  function loadStorageStats() {
    return openHistoryDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction([SESSIONS_STORE, SAMPLES_STORE], "readonly");
        var sessionsStore = transaction.objectStore(SESSIONS_STORE);
        var samplesStore = transaction.objectStore(SAMPLES_STORE);
        var latestSessionRequest = sessionsStore.index("startedAt").openCursor(null, "prev");
        var sessionsCountRequest = sessionsStore.count();
        var samplesCountRequest = samplesStore.count();
        var stats = { sessions: 0, samples: 0, lastStart: null };

        sessionsCountRequest.onsuccess = function () { stats.sessions = sessionsCountRequest.result || 0; };
        samplesCountRequest.onsuccess = function () { stats.samples = samplesCountRequest.result || 0; };
        latestSessionRequest.onsuccess = function () {
          var cursor = latestSessionRequest.result;
          stats.lastStart = cursor ? cursor.value.startedAt : null;
        };

        transaction.oncomplete = function () {
          storageStats = stats;
          updateStorageUi();
          resolve(stats);
        };
        transaction.onerror = function () { reject(transaction.error || new Error("Speicherstatistik konnte nicht geladen werden.")); };
      });
    }).catch(function (err) {
      appendNote("Speicherstatistik konnte nicht geladen werden: " + ((err && err.message) || String(err)));
    });
  }

  function loadRecentHistoryFromDb() {
    return openHistoryDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(SAMPLES_STORE, "readonly");
        var request = transaction.objectStore(SAMPLES_STORE).index("t").getAll(window.IDBKeyRange.lowerBound(Date.now() - HISTORY_WINDOW_MS));

        request.onsuccess = function () {
          powerHistory = (request.result || []).map(function (sample) {
            return { t: sample.t, netzbezug: sample.netzbezug, solar: sample.solar, verbrauch: sample.verbrauch };
          });
        };
        transaction.oncomplete = function () { renderChart(); resolve(powerHistory); };
        transaction.onerror = function () { reject(transaction.error || new Error("Verlauf konnte nicht geladen werden.")); };
      });
    }).catch(function (err) {
      appendNote("Gespeicherter Verlauf konnte nicht geladen werden: " + ((err && err.message) || String(err)));
    });
  }

  function loadSessions() {
    return openHistoryDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(SESSIONS_STORE, "readonly");
        var request = transaction.objectStore(SESSIONS_STORE).getAll();

        request.onsuccess = function () {
          sessionList = (request.result || []).sort(function (a, b) {
            return (b.startedAt || 0) - (a.startedAt || 0);
          });
        };
        transaction.oncomplete = function () { renderSessions(); resolve(sessionList); };
        transaction.onerror = function () { reject(transaction.error || new Error("Sessions konnten nicht geladen werden.")); };
      });
    }).catch(function (err) {
      appendNote("Historie konnte nicht geladen werden: " + ((err && err.message) || String(err)));
    });
  }

  function renderSessions() {
    if (!historySessionsEl || !historyEmptyEl) return;

    historySessionsEl.innerHTML = "";
    historyEmptyEl.hidden = sessionList.length > 0;

    sessionList.forEach(function (session) {
      var article = document.createElement("article");
      var isActive = !session.stoppedAt;
      var sampleCount = session.sampleCount || 0;
      var stopText = isActive ? "laeuft noch" : formatLongDateTime(session.stoppedAt);

      article.className = "session-card";
      article.innerHTML =
        '<div class="session-card-top">' +
          '<div><p class="session-kicker">Session</p><h3>' + formatShortDateTime(session.startedAt) + '</h3></div>' +
          '<span class="session-pill' + (isActive ? ' is-live' : '') + '">' + (isActive ? 'Live' : 'Beendet') + '</span>' +
        '</div>' +
        '<div class="session-meta-grid">' +
          '<p><span>Start</span><strong>' + formatLongDateTime(session.startedAt) + '</strong></p>' +
          '<p><span>Stop</span><strong>' + stopText + '</strong></p>' +
          '<p><span>Dauer</span><strong>' + formatDuration(session.startedAt, session.stoppedAt) + '</strong></p>' +
          '<p><span>Messpunkte</span><strong>' + sampleCount + '</strong></p>' +
        '</div>' +
        '<div class="session-actions">' +
          '<button type="button" class="secondary-action session-export" data-session-export="' + session.id + '"' + (sampleCount ? '' : ' disabled') + '>Abschnitt exportieren</button>' +
        '</div>';
      historySessionsEl.appendChild(article);
    });
  }

  function startSession() {
    return openHistoryDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(SESSIONS_STORE, "readwrite");
        var request = transaction.objectStore(SESSIONS_STORE).add({ startedAt: Date.now(), stoppedAt: null, sampleCount: 0 });

        request.onsuccess = function () { currentSessionId = request.result; };
        transaction.oncomplete = function () {
          loadStorageStats();
          loadSessions();
          resolve(currentSessionId);
        };
        transaction.onerror = function () { reject(transaction.error || new Error("Session konnte nicht gestartet werden.")); };
      });
    });
  }

  function stopCurrentSession() {
    if (!currentSessionId) return Promise.resolve();

    var sessionId = currentSessionId;
    currentSessionId = null;

    return openHistoryDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(SESSIONS_STORE, "readwrite");
        var store = transaction.objectStore(SESSIONS_STORE);
        var getRequest = store.get(sessionId);

        getRequest.onsuccess = function () {
          var session = getRequest.result;
          if (!session) return;
          session.stoppedAt = Date.now();
          store.put(session);
        };
        transaction.oncomplete = function () {
          loadStorageStats();
          loadSessions();
          resolve();
        };
        transaction.onerror = function () { reject(transaction.error || new Error("Session konnte nicht beendet werden.")); };
      });
    }).catch(function (err) {
      appendNote("Session konnte nicht sauber beendet werden: " + ((err && err.message) || String(err)));
    });
  }

  function incrementSessionSampleCount(sessionId) {
    if (!sessionId) return;

    openHistoryDb().then(function (db) {
      var transaction = db.transaction(SESSIONS_STORE, "readwrite");
      var store = transaction.objectStore(SESSIONS_STORE);
      var request = store.get(sessionId);

      request.onsuccess = function () {
        var session = request.result;
        if (!session) return;
        session.sampleCount = (session.sampleCount || 0) + 1;
        store.put(session);
      };
      transaction.oncomplete = function () {
        loadStorageStats();
        loadSessions();
      };
    }).catch(function (err) {
      appendNote("Session-Zaehler konnte nicht aktualisiert werden: " + ((err && err.message) || String(err)));
    });
  }

  function persistHistoryPoint(sample) {
    if (!currentSessionId) return;

    var payload = {
      sessionId: currentSessionId,
      t: sample.t,
      netzbezug: sample.netzbezug,
      solar: sample.solar,
      verbrauch: sample.verbrauch
    };

    openHistoryDb().then(function (db) {
      var transaction = db.transaction(SAMPLES_STORE, "readwrite");
      transaction.objectStore(SAMPLES_STORE).add(payload);
      transaction.oncomplete = function () { incrementSessionSampleCount(payload.sessionId); };
      transaction.onerror = function () { appendNote("Verlauf konnte nicht gespeichert werden."); };
    }).catch(function (err) {
      appendNote("Verlauf konnte nicht gespeichert werden: " + ((err && err.message) || String(err)));
    });
  }
  function exportSessionAsJson(sessionId) {
    openHistoryDb().then(function (db) {
      var transaction = db.transaction([SESSIONS_STORE, SAMPLES_STORE], "readonly");
      var sessionRequest = transaction.objectStore(SESSIONS_STORE).get(sessionId);
      var samplesRequest = transaction.objectStore(SAMPLES_STORE).index("sessionId").getAll(sessionId);

      transaction.oncomplete = function () {
        var session = sessionRequest.result;
        var samples = samplesRequest.result || [];
        if (!session) {
          showError("Session nicht gefunden.");
          return;
        }

        var payload = {
          exportedAt: new Date().toISOString(),
          source: "Shelly Status",
          session: {
            id: session.id,
            startedAt: session.startedAt,
            stoppedAt: session.stoppedAt,
            sampleCount: session.sampleCount || samples.length
          },
          samples: samples.map(function (sample) {
            return {
              t: sample.t,
              netzbezug: sample.netzbezug,
              solar: sample.solar,
              verbrauch: sample.verbrauch
            };
          })
        };

        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var link = document.createElement("a");
        link.href = url;
        link.download = "shelly-session-" + session.id + "-" + new Date(session.startedAt).toISOString().replace(/[:.]/g, "-") + ".json";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        showNote("Session " + formatShortDateTime(session.startedAt) + " wurde exportiert.");
      };

      transaction.onerror = function () { showError("Session-Export fehlgeschlagen."); };
    }).catch(function (err) {
      showError("Session-Export fehlgeschlagen: " + ((err && err.message) || String(err)));
    });
  }

  function clearPersistedHistory() {
    openHistoryDb().then(function (db) {
      var transaction = db.transaction([SESSIONS_STORE, SAMPLES_STORE], "readwrite");
      transaction.objectStore(SESSIONS_STORE).clear();
      transaction.objectStore(SAMPLES_STORE).clear();

      transaction.oncomplete = function () {
        sessionList = [];
        powerHistory = [];
        currentSessionId = null;
        storageStats = { sessions: 0, samples: 0, lastStart: null };
        updateStorageUi();
        renderSessions();
        renderChart();
        showNote("Alle gespeicherten Sessions wurden geloescht.");
      };
      transaction.onerror = function () { showError("Historie konnte nicht geloescht werden."); };
    }).catch(function (err) {
      showError("Historie konnte nicht geloescht werden: " + ((err && err.message) || String(err)));
    });
  }

  function pruneHistory(now) {
    var cutoff = now - HISTORY_WINDOW_MS;
    while (powerHistory.length && powerHistory[0].t < cutoff) {
      powerHistory.shift();
    }
  }

  function resizeCanvasToDisplaySize(canvas) {
    if (!canvas) return null;
    var ratio = window.devicePixelRatio || 1;
    var width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    var height = Math.max(1, Math.round(canvas.clientHeight * ratio));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return canvas.getContext("2d");
  }

  function drawSeries(ctx, width, height, now, minValue, range, color, key) {
    if (!powerHistory.length) return;
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;

    for (var i = 0; i < powerHistory.length; i += 1) {
      var point = powerHistory[i];
      var x = ((point.t - (now - HISTORY_WINDOW_MS)) / HISTORY_WINDOW_MS) * width;
      var y = height - (((point[key] - minValue) / range) * height);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function renderChart() {
    if (!chartCanvas) return;

    var now = Date.now();
    pruneHistory(now);
    updateLegendValues();

    var ctx = resizeCanvasToDisplaySize(chartCanvas);
    if (!ctx) return;

    var width = chartCanvas.width;
    var height = chartCanvas.height;
    var paddingTop = 14;
    var paddingBottom = 22;
    var paddingLeft = 8;
    var paddingRight = 8;
    var plotWidth = width - paddingLeft - paddingRight;
    var plotHeight = height - paddingTop - paddingBottom;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
    ctx.fillRect(0, 0, width, height);

    if (!powerHistory.length) {
      ctx.fillStyle = "#8b9aab";
      ctx.font = Math.round(14 * (window.devicePixelRatio || 1)) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Noch keine Messwerte", width / 2, height / 2);
      return;
    }

    var minValue = Infinity;
    var maxValue = -Infinity;
    for (var i = 0; i < powerHistory.length; i += 1) {
      var sample = powerHistory[i];
      minValue = Math.min(minValue, sample.netzbezug, sample.solar, sample.verbrauch);
      maxValue = Math.max(maxValue, sample.netzbezug, sample.solar, sample.verbrauch);
    }

    if (!isFinite(minValue) || !isFinite(maxValue)) {
      minValue = 0;
      maxValue = 1;
    }
    if (minValue === maxValue) {
      minValue -= 1;
      maxValue += 1;
    }

    var paddingValue = Math.max(10, (maxValue - minValue) * 0.15);
    minValue = Math.min(minValue - paddingValue, 0);
    maxValue = Math.max(maxValue + paddingValue, 0);

    var niceStep = getNiceStep((maxValue - minValue) / 4);
    minValue = Math.floor(minValue / niceStep) * niceStep;
    maxValue = Math.ceil(maxValue / niceStep) * niceStep;
    if (minValue === maxValue) maxValue = minValue + niceStep;

    var range = maxValue - minValue;

    ctx.save();
    ctx.translate(paddingLeft, paddingTop);

    var tickValues = [];
    for (var tickValue = maxValue; tickValue >= minValue - (niceStep * 0.5); tickValue -= niceStep) {
      tickValues.push(tickValue);
    }

    ctx.strokeStyle = "rgba(139, 154, 171, 0.18)";
    ctx.lineWidth = 1;
    for (i = 0; i < tickValues.length; i += 1) {
      var tickY = plotHeight - (((tickValues[i] - minValue) / range) * plotHeight);
      ctx.beginPath();
      ctx.moveTo(0, tickY);
      ctx.lineTo(plotWidth, tickY);
      ctx.stroke();
    }

    var zeroY = plotHeight - (((0 - minValue) / range) * plotHeight);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.32)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(plotWidth, zeroY);
    ctx.stroke();

    ctx.fillStyle = "#8b9aab";
    ctx.font = Math.round(11 * (window.devicePixelRatio || 1)) + "px sans-serif";
    ctx.textAlign = "left";
    for (i = 0; i < tickValues.length; i += 1) {
      var labelValue = tickValues[i];
      var labelY = plotHeight - (((labelValue - minValue) / range) * plotHeight);
      ctx.fillText(labelValue.toFixed(0) + " W", 6, Math.max(12, labelY - 4));
    }

    drawSeries(ctx, plotWidth, plotHeight, now, minValue, range, "#ff9f43", "netzbezug");
    drawSeries(ctx, plotWidth, plotHeight, now, minValue, range, "#18a56b", "solar");
    drawSeries(ctx, plotWidth, plotHeight, now, minValue, range, "#2f7cf6", "verbrauch");

    ctx.fillStyle = "#8b9aab";
    ctx.textAlign = "left";
    ctx.fillText("-120 s", 0, plotHeight + 18);
    ctx.textAlign = "right";
    ctx.fillText("jetzt", plotWidth, plotHeight + 18);
    ctx.restore();
  }

  function recordHistoryPoint() {
    if (!currentSessionId) return;

    var now = Date.now();
    var sample = { t: now, netzbezug: netzbezug, solar: solar, verbrauch: netzbezug - solar };
    powerHistory.push(sample);
    pruneHistory(now);
    renderChart();
    persistHistoryPoint(sample);
  }

  function normalizeBase(raw) {
    var s = String(raw || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "http://" + s;
    return s.replace(/\/+$/, "");
  }

  function httpBaseToWsRpcUrl(base) {
    var u = new URL(base);
    return (u.protocol === "https:" ? "wss:" : "ws:") + "//" + u.host + "/rpc";
  }
  function applyMessage(text) {
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      setOut(text);
      return;
    }

    if (obj.result && obj.result["em:0"] && obj.result["em:0"].total_act_power !== undefined) {
      netzbezug = Number(obj.result["em:0"].total_act_power);
      powerValueEl.textContent = netzbezug.toFixed(1);
      updateVerbrauch();
      recordHistoryPoint();
    } else if (obj.params && obj.params["em:0"] && obj.params["em:0"].total_act_power !== undefined) {
      netzbezug = Number(obj.params["em:0"].total_act_power);
      powerValueEl.textContent = netzbezug.toFixed(1);
      updateVerbrauch();
      recordHistoryPoint();
    }

    if (obj.id == 1 && (obj.result !== undefined || obj.error !== undefined)) {
      showError("");
      setOut(JSON.stringify(obj, null, 2));
      return;
    }

    if (obj.method === "NotifyStatus" && obj.params !== undefined) {
      setOut(JSON.stringify(obj.params, null, 2));
      return;
    }

    if (obj.params !== undefined && obj.method) {
      setOut(JSON.stringify(obj.params, null, 2));
    }
  }

  function clearWaitTimer() {
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
  }

  function clearWaitTimer2() {
    if (waitTimer2) {
      clearTimeout(waitTimer2);
      waitTimer2 = null;
    }
  }

  function disconnect() {
    userClosed = true;
    clearWaitTimer();
    clearWaitTimer2();

    if (updateIntervalId) {
      clearInterval(updateIntervalId);
      updateIntervalId = null;
    }
    if (updateIntervalId2) {
      clearInterval(updateIntervalId2);
      updateIntervalId2 = null;
    }
    if (wsConn) {
      try { wsConn.close(); } catch (_) {}
      wsConn = null;
    }
    if (wsConn2) {
      try { wsConn2.close(); } catch (_) {}
      wsConn2 = null;
    }

    stopCurrentSession();
    netzbezug = 0;
    solar = 0;
    updateVerbrauch();
    renderChart();
    setConnectUi(false);
  }

  function connect() {
    if ((wsConn && wsConn.readyState === WebSocket.OPEN) || (wsConn2 && wsConn2.readyState === WebSocket.OPEN)) {
      disconnect();
      return;
    }

    showError("");
    showNote("");
    powerHistory = [];
    renderChart();

    startSession().then(function () {
      userClosed = false;
      var base = normalizeBase(SHELLY1_BASE_URL);
      var wsUrl = httpBaseToWsRpcUrl(base);

      if (wsConn) {
        try { wsConn.close(); } catch (_) {}
        wsConn = null;
      }

      setOut("Verbinde Shelly 52 ... " + wsUrl);

      waitTimer = setTimeout(function () {
        showError("Keine Antwort innerhalb von " + WS_WAIT_MS / 1000 + " s.");
        disconnect();
        setOut("-- Timeout --");
      }, WS_WAIT_MS);

      try {
        wsConn = new WebSocket(wsUrl);
      } catch (e) {
        clearWaitTimer();
        stopCurrentSession();
        showError((e && e.message) || String(e));
        setOut("-- Fehler --");
        return;
      }

      setConnectUi(true);

      wsConn.addEventListener("open", function () {
        setOut("Shelly 52 verbunden, request Shelly.GetStatus");
        wsConn.send(JSON.stringify({ id: 1, src: "user_1", method: "Shelly.GetStatus" }));
        clearInterval(updateIntervalId);
        updateIntervalId = setInterval(function () {
          if (wsConn && wsConn.readyState === WebSocket.OPEN) {
            wsConn.send(JSON.stringify({ id: 1, src: "user_1", method: "Shelly.GetStatus" }));
          }
        }, 500);
      });

      wsConn.addEventListener("message", function (ev) {
        var text = typeof ev.data === "string" ? ev.data : "";
        if (!text) return;
        clearWaitTimer();
        applyMessage(text);
      });

      wsConn.addEventListener("error", function () {
        clearWaitTimer();
        if (!userClosed) {
          showError("WebSocket-Fehler.");
          setOut("-- Fehler --");
        }
      });

      wsConn.addEventListener("close", function (ev) {
        clearWaitTimer();
        wsConn = null;
        setConnectUi(false);
        if (!userClosed && ev.code !== 1000) {
          showError("Verbindung beendet (Code " + ev.code + ").");
        }
      });

      checkShelly2Ws();
    }).catch(function (err) {
      showError("Session konnte nicht gestartet werden: " + ((err && err.message) || String(err)));
    });
  }

  function checkShelly2Ws() {
    if (wsConn2 && wsConn2.readyState === WebSocket.OPEN) return;

    if (wsConn2) {
      try { wsConn2.close(); } catch (_) {}
      wsConn2 = null;
    }

    var base = normalizeBase(SHELLY2_BASE_URL);
    var wsUrl = httpBaseToWsRpcUrl(base);

    waitTimer2 = setTimeout(function () {
      if (wsConn2) {
        try { wsConn2.close(); } catch (_) {}
        wsConn2 = null;
      }
    }, WS_WAIT_MS);

    try {
      wsConn2 = new WebSocket(wsUrl);
    } catch (_) {
      clearWaitTimer2();
      return;
    }

    wsConn2.addEventListener("open", function () {
      clearWaitTimer2();
      if (wsConn2 && wsConn2.readyState === WebSocket.OPEN) {
        wsConn2.send(JSON.stringify({ id: 1, src: "user_2", method: "Shelly.GetStatus" }));
      }
      if (updateIntervalId2) clearInterval(updateIntervalId2);
      updateIntervalId2 = setInterval(function () {
        if (wsConn2 && wsConn2.readyState === WebSocket.OPEN) {
          wsConn2.send(JSON.stringify({ id: 1, src: "user_2", method: "Shelly.GetStatus" }));
        }
      }, 500);
    });

    wsConn2.addEventListener("message", function (ev) {
      var text = typeof ev.data === "string" ? ev.data : "";
      if (!text) return;
      try {
        var obj = JSON.parse(text);
        if (obj.result && obj.result["pm1:0"] && obj.result["pm1:0"].apower !== undefined) {
          solar = Number(obj.result["pm1:0"].apower);
          powerValueEl2.textContent = solar.toFixed(1);
          updateVerbrauch();
          recordHistoryPoint();
        } else if (obj.params && obj.params["pm1:0"] && obj.params["pm1:0"].apower !== undefined) {
          solar = Number(obj.params["pm1:0"].apower);
          powerValueEl2.textContent = solar.toFixed(1);
          updateVerbrauch();
          recordHistoryPoint();
        }
      } catch (_) {}
    });

    wsConn2.addEventListener("error", function () { clearWaitTimer2(); });
    wsConn2.addEventListener("close", function () {
      clearWaitTimer2();
      if (updateIntervalId2) {
        clearInterval(updateIntervalId2);
        updateIntervalId2 = null;
      }
      wsConn2 = null;
    });
  }

  function hintIfHttpsPage() {
    if (location.protocol === "https:") {
      showNote("Seite ueber HTTPS: ws:// zu Shelly kann blockiert werden. Seite lieber ueber http:// oeffnen.");
    }
  }

  function removeLegacyPwaArtifacts() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.getRegistrations().then(function (registrations) {
          return Promise.all(registrations.map(function (registration) {
            return registration.unregister();
          }));
        }).catch(function () {
          return [];
        });
      });
    }

    if ("caches" in window) {
      window.addEventListener("load", function () {
        caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (key) {
            return caches.delete(key);
          }));
        }).catch(function () {
          return [];
        });
      });
    }
  }
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    connect();
  });

  btnConnect.addEventListener("click", function (e) {
    e.preventDefault();
    connect();
  });

  if (btnClearHistory) {
    btnClearHistory.addEventListener("click", function () {
      clearPersistedHistory();
    });
  }

  tabButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      setActiveTab(button.getAttribute("data-tab-target"));
    });
  });

  if (historySessionsEl) {
    historySessionsEl.addEventListener("click", function (event) {
      var exportButton = event.target.closest("[data-session-export]");
      if (!exportButton) return;
      exportSessionAsJson(Number(exportButton.getAttribute("data-session-export")));
    });
  }

  window.addEventListener("beforeunload", function () {
    userClosed = true;
    if (chartRefreshIntervalId) {
      clearInterval(chartRefreshIntervalId);
      chartRefreshIntervalId = null;
    }
    if (wsConn) {
      try { wsConn.close(); } catch (_) {}
    }
    if (wsConn2) {
      try { wsConn2.close(); } catch (_) {}
    }
    stopCurrentSession();
  });

  window.addEventListener("resize", renderChart);

  showNote("Shelly 192.168.178.52 + 192.168.178.53 fest konfiguriert.");
  hintIfHttpsPage();
  removeLegacyPwaArtifacts();
  setActiveTab("dashboard");
  updateStorageUi();

  if (supportsIndexedDb()) {
    loadStorageStats();
    loadRecentHistoryFromDb();
    loadSessions();
  }

  chartRefreshIntervalId = setInterval(renderChart, 1000);
  renderChart();
})();
