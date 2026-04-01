
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
  var btnImportJson = document.getElementById("btnImportJson");
  var importJsonInput = document.getElementById("importJsonInput");
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
  var viewChartCanvas = document.getElementById("viewChart");
  var viewLegendLoadValueEl = document.getElementById("viewLegendLoadValue");
  var viewLegendGridValueEl = document.getElementById("viewLegendGridValue");
  var viewLegendSolarValueEl = document.getElementById("viewLegendSolarValue");
  var viewTitleEl = document.getElementById("viewTitle");
  var viewSubtitleEl = document.getElementById("viewSubtitle");
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
  var selectedViewSamples = [];
  var viewWindowMs = HISTORY_WINDOW_MS;
  var viewWindowStart = null;
  var viewDragging = false;
  var viewDragStartX = 0;
  var viewDragStartWindow = 0;

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

  function updateLegendValuesForSamples(samples, loadEl, gridEl, solarEl) {
    var latest = samples && samples.length ? samples[samples.length - 1] : null;
    var load = latest ? latest.verbrauch : 0;
    var grid = latest ? latest.netzbezug : 0;
    var sun = latest ? latest.solar : 0;
    if (loadEl) loadEl.textContent = formatWatts(load);
    if (gridEl) gridEl.textContent = formatWatts(grid);
    if (solarEl) solarEl.textContent = formatWatts(sun);
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

    if (tabName === "view") {
      window.requestAnimationFrame(function () {
        renderViewChart();
      });
    }
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

  }

  function formatBytes(bytes) {
    var value = Number(bytes || 0);
    if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(2) + " MB";
    return (value / 1024).toFixed(1) + " KB";
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
        var transaction = db.transaction([SESSIONS_STORE, SAMPLES_STORE], "readonly");
        var request = transaction.objectStore(SESSIONS_STORE).getAll();
        var samplesRequest = transaction.objectStore(SAMPLES_STORE).getAll();

        request.onsuccess = function () {
          sessionList = (request.result || []);
        };
        samplesRequest.onsuccess = function () {
          var samples = samplesRequest.result || [];
          var samplesBySessionId = {};

          samples.forEach(function (sample) {
            if (!samplesBySessionId[sample.sessionId]) samplesBySessionId[sample.sessionId] = [];
            samplesBySessionId[sample.sessionId].push(sample);
          });

          sessionList = sessionList.map(function (session) {
            var sessionSamples = (samplesBySessionId[session.id] || []).map(function (sample) {
              return {
                t: sample.t,
                netzbezug: sample.netzbezug,
                solar: sample.solar,
                verbrauch: sample.verbrauch
              };
            });
            var payloadForSize = {
              session: {
                startedAt: session.startedAt,
                stoppedAt: session.stoppedAt,
                sampleCount: session.sampleCount || sessionSamples.length
              },
              samples: sessionSamples
            };
            var approxBytes = new Blob([JSON.stringify(payloadForSize)]).size;
            session.storageBytes = approxBytes;
            return session;
          }).sort(function (a, b) {
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
      var storageText = formatBytes(session.storageBytes || 0);

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
          '<p><span>Speicher</span><strong>' + storageText + '</strong></p>' +
        '</div>' +
        '<div class="session-actions">' +
          '<button type="button" class="secondary-action session-action-btn" data-session-view="' + session.id + '"' + (sampleCount ? '' : ' disabled') + '>View</button>' +
          '<button type="button" class="secondary-action session-action-btn session-export" data-session-export="' + session.id + '"' + (sampleCount ? '' : ' disabled') + '>Export</button>' +
          '<button type="button" class="secondary-action session-action-btn session-delete" data-session-delete="' + session.id + '">Loeschen</button>' +
        '</div>';
      historySessionsEl.appendChild(article);
    });
  }

  function drawSeriesForRange(ctx, width, height, samples, startTime, endTime, minValue, range, color, key) {
    if (!samples.length || endTime <= startTime) return;
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;

    for (var i = 0; i < samples.length; i += 1) {
      var point = samples[i];
      var x = ((point.t - startTime) / (endTime - startTime)) * width;
      var y = height - (((point[key] - minValue) / range) * height);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function formatAxisTime(timestamp) {
    return new Intl.DateTimeFormat("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(timestamp));
  }

  function getViewBounds() {
    if (!selectedViewSamples.length) return null;
    return {
      min: selectedViewSamples[0].t,
      max: selectedViewSamples[selectedViewSamples.length - 1].t
    };
  }

  function clampViewWindowStart(start, boundsMin, boundsMax, windowMs) {
    var maxStart = Math.max(boundsMin, boundsMax - windowMs);
    if (start < boundsMin) return boundsMin;
    if (start > maxStart) return maxStart;
    return start;
  }

  function resetViewWindow() {
    var bounds = getViewBounds();
    viewWindowMs = HISTORY_WINDOW_MS;
    if (!bounds) {
      viewWindowStart = null;
      return;
    }
    viewWindowStart = clampViewWindowStart(bounds.max - viewWindowMs, bounds.min, bounds.max, viewWindowMs);
  }

  function renderViewChart() {
    var bounds = getViewBounds();
    if (!bounds) {
      renderChartFromSamples(viewChartCanvas, selectedViewSamples, viewLegendLoadValueEl, viewLegendGridValueEl, viewLegendSolarValueEl, { xTickLabels: true });
      return;
    }

    var duration = Math.max(1, bounds.max - bounds.min);
    var minWindow = 5000;
    var maxWindow = Math.max(HISTORY_WINDOW_MS, duration);
    viewWindowMs = Math.min(maxWindow, Math.max(minWindow, viewWindowMs));
    if (viewWindowStart === null) viewWindowStart = bounds.max - viewWindowMs;
    viewWindowStart = clampViewWindowStart(viewWindowStart, bounds.min, bounds.max, viewWindowMs);

    renderChartFromSamples(viewChartCanvas, selectedViewSamples, viewLegendLoadValueEl, viewLegendGridValueEl, viewLegendSolarValueEl, {
      startTime: viewWindowStart,
      endTime: viewWindowStart + viewWindowMs,
      xTickLabels: true
    });
  }

  function renderChartFromSamples(canvas, samples, legendLoadEl, legendGridEl, legendSunEl, options) {
    options = options || {};
    if (!canvas) return;
    updateLegendValuesForSamples(samples, legendLoadEl, legendGridEl, legendSunEl);

    var ctx = resizeCanvasToDisplaySize(canvas);
    if (!ctx) return;

    var width = canvas.width;
    var height = canvas.height;
    var paddingTop = 14;
    var paddingBottom = 22;
    var paddingLeft = 8;
    var paddingRight = 8;
    var plotWidth = width - paddingLeft - paddingRight;
    var plotHeight = height - paddingTop - paddingBottom;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
    ctx.fillRect(0, 0, width, height);

    if (!samples.length) {
      ctx.fillStyle = "#8b9aab";
      ctx.font = Math.round(14 * (window.devicePixelRatio || 1)) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Noch keine Messwerte", width / 2, height / 2);
      return;
    }

    var minValue = Infinity;
    var maxValue = -Infinity;
    for (var i = 0; i < samples.length; i += 1) {
      var sample = samples[i];
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

    var startTime = options.startTime;
    var endTime = options.endTime;
    if (typeof startTime !== "number" || typeof endTime !== "number") {
      startTime = samples[0].t;
      endTime = samples[samples.length - 1].t;
    }
    if (endTime === startTime) endTime = startTime + 1;
    drawSeriesForRange(ctx, plotWidth, plotHeight, samples, startTime, endTime, minValue, range, "#ff9f43", "netzbezug");
    drawSeriesForRange(ctx, plotWidth, plotHeight, samples, startTime, endTime, minValue, range, "#18a56b", "solar");
    drawSeriesForRange(ctx, plotWidth, plotHeight, samples, startTime, endTime, minValue, range, "#2f7cf6", "verbrauch");

    if (options.xTickLabels) {
      var xTickCount = 4;
      ctx.strokeStyle = "rgba(139, 154, 171, 0.12)";
      ctx.fillStyle = "#8b9aab";
      ctx.textAlign = "center";
      for (i = 0; i <= xTickCount; i += 1) {
        var ratio = i / xTickCount;
        var x = ratio * plotWidth;
        var t = startTime + ((endTime - startTime) * ratio);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, plotHeight);
        ctx.stroke();
        ctx.fillText(formatAxisTime(t), x, plotHeight + 18);
      }
    } else {
      ctx.fillStyle = "#8b9aab";
      ctx.textAlign = "left";
      ctx.fillText(options.labelStart || "Start", 0, plotHeight + 18);
      ctx.textAlign = "right";
      ctx.fillText(options.labelEnd || "Ende", plotWidth, plotHeight + 18);
    }
    ctx.restore();
  }

  function setViewSessionMeta(session, samples) {
    if (viewTitleEl) viewTitleEl.textContent = session ? "Abschnitt " + formatShortDateTime(session.startedAt) : "Kein Abschnitt ausgewaehlt";
    if (viewSubtitleEl) {
      if (!session) {
        viewSubtitleEl.textContent = "Waehle in Historie einen Abschnitt oder importiere eine JSON-Datei.";
      } else {
        viewSubtitleEl.textContent = formatDuration(session.startedAt, session.stoppedAt) + " | " + (samples ? samples.length : 0) + " Messpunkte";
      }
    }
  }

  function loadSessionSamples(sessionId) {
    return openHistoryDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction([SESSIONS_STORE, SAMPLES_STORE], "readonly");
        var sessionRequest = transaction.objectStore(SESSIONS_STORE).get(sessionId);
        var samplesRequest = transaction.objectStore(SAMPLES_STORE).index("sessionId").getAll(sessionId);
        transaction.oncomplete = function () {
          if (!sessionRequest.result) {
            reject(new Error("Session nicht gefunden."));
            return;
          }
          var samples = (samplesRequest.result || []).map(function (sample) {
            return { t: sample.t, netzbezug: sample.netzbezug, solar: sample.solar, verbrauch: sample.verbrauch };
          }).sort(function (a, b) { return a.t - b.t; });
          resolve({ session: sessionRequest.result, samples: samples });
        };
        transaction.onerror = function () { reject(transaction.error || new Error("Session-Daten konnten nicht geladen werden.")); };
      });
    });
  }

  function showSessionInView(sessionId) {
    loadSessionSamples(sessionId).then(function (result) {
      selectedViewSamples = result.samples;
      resetViewWindow();
      setViewSessionMeta(result.session, result.samples);
      setActiveTab("view");
    }).catch(function (err) {
      showError("Abschnitt konnte nicht angezeigt werden: " + ((err && err.message) || String(err)));
    });
  }

  function deleteSession(sessionId) {
    openHistoryDb().then(function (db) {
      var transaction = db.transaction([SESSIONS_STORE, SAMPLES_STORE], "readwrite");
      var sessionsStore = transaction.objectStore(SESSIONS_STORE);
      var samplesStore = transaction.objectStore(SAMPLES_STORE);
      var index = samplesStore.index("sessionId");
      var range = window.IDBKeyRange.only(sessionId);
      index.openCursor(range).onsuccess = function (event) {
        var cursor = event.target.result;
        if (!cursor) return;
        samplesStore.delete(cursor.primaryKey);
        cursor.continue();
      };
      sessionsStore.delete(sessionId);

      transaction.oncomplete = function () {
        if (currentSessionId === sessionId) currentSessionId = null;
        if (selectedViewSamples.length) {
          selectedViewSamples = [];
          resetViewWindow();
          setViewSessionMeta(null, []);
          renderViewChart();
        }
        loadStorageStats();
        loadSessions();
        showNote("Abschnitt wurde geloescht.");
      };
      transaction.onerror = function () { showError("Abschnitt konnte nicht geloescht werden."); };
    }).catch(function (err) {
      showError("Abschnitt konnte nicht geloescht werden: " + ((err && err.message) || String(err)));
    });
  }

  function importSessionFromJsonText(jsonText) {
    var payload;
    try {
      payload = JSON.parse(jsonText);
    } catch (_) {
      showError("JSON ist ungueltig.");
      return;
    }

    if (!payload || !payload.session || !Array.isArray(payload.samples)) {
      showError("JSON-Format wird nicht unterstuetzt.");
      return;
    }

    var startedAt = Number(payload.session.startedAt || Date.now());
    var stoppedAt = payload.session.stoppedAt ? Number(payload.session.stoppedAt) : null;
    var normalizedSamples = payload.samples.map(function (sample) {
      return {
        t: Number(sample.t || Date.now()),
        netzbezug: Number(sample.netzbezug || 0),
        solar: Number(sample.solar || 0),
        verbrauch: Number(sample.verbrauch || (Number(sample.netzbezug || 0) - Number(sample.solar || 0)))
      };
    }).sort(function (a, b) { return a.t - b.t; });

    openHistoryDb().then(function (db) {
      var transaction = db.transaction([SESSIONS_STORE, SAMPLES_STORE], "readwrite");
      var sessionStore = transaction.objectStore(SESSIONS_STORE);
      var sampleStore = transaction.objectStore(SAMPLES_STORE);
      var sessionId;

      sessionStore.add({
        startedAt: startedAt,
        stoppedAt: stoppedAt,
        sampleCount: normalizedSamples.length
      }).onsuccess = function (event) {
        sessionId = event.target.result;
        normalizedSamples.forEach(function (sample) {
          sampleStore.add({
            sessionId: sessionId,
            t: sample.t,
            netzbezug: sample.netzbezug,
            solar: sample.solar,
            verbrauch: sample.verbrauch
          });
        });
      };

      transaction.oncomplete = function () {
        loadStorageStats();
        loadSessions().then(function () {
          showSessionInView(sessionId);
          showNote("JSON importiert und im View angezeigt.");
        });
      };
      transaction.onerror = function () { showError("JSON konnte nicht importiert werden."); };
    }).catch(function (err) {
      showError("JSON konnte nicht importiert werden: " + ((err && err.message) || String(err)));
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
    renderChartFromSamples(chartCanvas, powerHistory, legendLoadValueEl, legendGridValueEl, legendSolarValueEl, {
      startTime: now - HISTORY_WINDOW_MS,
      endTime: now,
      labelStart: "-120 s",
      labelEnd: "jetzt"
    });
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

  tabButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      setActiveTab(button.getAttribute("data-tab-target"));
    });
  });

  if (historySessionsEl) {
    historySessionsEl.addEventListener("click", function (event) {
      var deleteButton = event.target.closest("[data-session-delete]");
      if (deleteButton) {
        deleteSession(Number(deleteButton.getAttribute("data-session-delete")));
        return;
      }
      var exportButton = event.target.closest("[data-session-export]");
      if (exportButton) {
        exportSessionAsJson(Number(exportButton.getAttribute("data-session-export")));
        return;
      }
      var viewButton = event.target.closest("[data-session-view]");
      if (!viewButton) return;
      showSessionInView(Number(viewButton.getAttribute("data-session-view")));
    });
  }

  if (btnImportJson && importJsonInput) {
    btnImportJson.addEventListener("click", function () {
      importJsonInput.value = "";
      importJsonInput.click();
    });

    importJsonInput.addEventListener("change", function () {
      var file = importJsonInput.files && importJsonInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () { importSessionFromJsonText(String(reader.result || "")); };
      reader.onerror = function () { showError("Datei konnte nicht gelesen werden."); };
      reader.readAsText(file, "utf-8");
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
  window.addEventListener("resize", function () {
    renderViewChart();
  });

  if (viewChartCanvas) {
    viewChartCanvas.addEventListener("wheel", function (event) {
      if (!selectedViewSamples.length) return;
      event.preventDefault();
      var bounds = getViewBounds();
      if (!bounds) return;

      var rect = viewChartCanvas.getBoundingClientRect();
      var ratio = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0.5;
      var oldWindow = viewWindowMs;
      var factor = event.deltaY > 0 ? 1.2 : 0.8;
      var duration = Math.max(1, bounds.max - bounds.min);
      var minWindow = 5000;
      var maxWindow = Math.max(HISTORY_WINDOW_MS, duration);
      var newWindow = Math.min(maxWindow, Math.max(minWindow, oldWindow * factor));
      var anchorTime = viewWindowStart + (oldWindow * ratio);
      viewWindowMs = newWindow;
      viewWindowStart = clampViewWindowStart(anchorTime - (newWindow * ratio), bounds.min, bounds.max, newWindow);
      renderViewChart();
    }, { passive: false });

    viewChartCanvas.addEventListener("mousedown", function (event) {
      if (event.button !== 0 || !selectedViewSamples.length) return;
      viewDragging = true;
      viewDragStartX = event.clientX;
      viewDragStartWindow = viewWindowStart || 0;
    });

    window.addEventListener("mousemove", function (event) {
      if (!viewDragging || !selectedViewSamples.length) return;
      var bounds = getViewBounds();
      if (!bounds) return;
      var rect = viewChartCanvas.getBoundingClientRect();
      if (rect.width <= 0) return;
      var deltaX = event.clientX - viewDragStartX;
      var msPerPixel = viewWindowMs / rect.width;
      var nextWindow = viewDragStartWindow - (deltaX * msPerPixel);
      viewWindowStart = clampViewWindowStart(nextWindow, bounds.min, bounds.max, viewWindowMs);
      renderViewChart();
    });

    window.addEventListener("mouseup", function () {
      viewDragging = false;
    });
  }

  showNote("Shelly 192.168.178.52 + 192.168.178.53 fest konfiguriert.");
  hintIfHttpsPage();
  removeLegacyPwaArtifacts();
  setActiveTab("dashboard");
  updateStorageUi();
  setViewSessionMeta(null, []);
  resetViewWindow();
  renderViewChart();

  if (supportsIndexedDb()) {
    loadStorageStats();
    loadRecentHistoryFromDb();
    loadSessions();
  }

  chartRefreshIntervalId = setInterval(renderChart, 1000);
  renderChart();
})();
