
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
  var btnDeleteAllSessions = document.getElementById("btnDeleteAllSessions");
  var importJsonInput = document.getElementById("importJsonInput");
  var noteEl = document.getElementById("note");
  var errEl = document.getElementById("err");
  var out = document.getElementById("out");
  var powerValueEl = document.getElementById("powerValue");
  var powerEnergyValueEl = document.getElementById("powerEnergyValue");
  var powerValueEl2 = document.getElementById("powerValue2");
  var powerEnergyValueEl2 = document.getElementById("powerEnergyValue2");
  var powerValueEl3 = document.getElementById("powerValue3");
  var powerEnergyValueEl3 = document.getElementById("powerEnergyValue3");
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
  var historyStorageUsedEl = document.getElementById("historyStorageUsed");
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
  var netzbezugImportEnergyWh = 0;
  var netzbezugExportEnergyWh = 0;
  var prevTotalActWh = null;
  var prevTotalActRetWh = null;
  var solar = 0;
  var solarEnergyWh = 0;
  var prevSolarTotalWh = null;
  var powerHistory = [];
  var currentSessionId = null;
  var sessionList = [];
  var storageStats = { sessions: 0, samples: 0, lastStart: null };
  var selectedViewSamples = [];
  var viewWindowMs = HISTORY_WINDOW_MS;
  var viewWindowStart = null;
  var viewDragging = false;
  var viewDragStartX = 0;
  var viewDragStartY = 0;
  var viewDragStartWindow = 0;
  var viewYMin = null;
  var viewYMax = null;
  var viewYDragStartMin = 0;
  var viewYDragStartMax = 0;
  var viewDragMode = "x";
  var viewTouchPinching = false;
  var viewTouchDragging = false;
  var viewTouchDragMode = "x";
  var viewTouchStartDistance = 0;
  var viewTouchStartWindowMs = 0;
  var viewTouchStartWindowStart = 0;
  var viewTouchAnchorRatio = 0.5;
  var viewTouchDragStartX = 0;
  var viewTouchDragStartY = 0;
  var viewTouchDragStartWindow = 0;
  var viewTouchDragStartMin = 0;
  var viewTouchDragStartMax = 0;
  var VIEW_Y_CONTROL_ZONE_PX = 52;

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
    if (powerEnergyValueEl) powerEnergyValueEl.textContent = "Energie: +" + formatEnergy(netzbezugImportEnergyWh) + " | -" + formatEnergy(netzbezugExportEnergyWh);
    if (powerEnergyValueEl2) powerEnergyValueEl2.textContent = "Energie: " + formatEnergy(solarEnergyWh);
    if (powerEnergyValueEl3) powerEnergyValueEl3.textContent = "Energie: " + formatEnergy(getLoadEnergyWh());
  }

  function formatWatts(value) {
    return Number(value || 0).toFixed(1) + " W";
  }

  function formatLegendValue(currentValue, averageValue) {
    return formatWatts(currentValue) + " | Avg " + formatWatts(averageValue);
  }

  function formatEnergy(energyWh) {
    var value = Number(energyWh);
    if (!isFinite(value)) return "--";
    if (Math.abs(value) >= 1000) return (value / 1000).toFixed(2) + " kWh";
    return value.toFixed(2) + " Wh";
  }

  function readNumberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    value = Number(value);
    return isFinite(value) ? value : null;
  }

  function normalizeStoredSample(sample) {
    var normalized = {
      t: Number(sample.t || Date.now()),
      netzbezug: Number(sample.netzbezug || 0),
      solar: Number(sample.solar || 0),
      verbrauch: Number(sample.verbrauch || (Number(sample.netzbezug || 0) - Number(sample.solar || 0))),
      netzbezugImportEnergyWh: readNumberOrNull(sample.netzbezugImportEnergyWh),
      netzbezugExportEnergyWh: readNumberOrNull(sample.netzbezugExportEnergyWh),
      solarEnergyWh: readNumberOrNull(sample.solarEnergyWh),
      verbrauchEnergyWh: readNumberOrNull(sample.verbrauchEnergyWh)
    };

    if (
      normalized.verbrauchEnergyWh === null &&
      normalized.netzbezugImportEnergyWh !== null &&
      normalized.netzbezugExportEnergyWh !== null &&
      normalized.solarEnergyWh !== null
    ) {
      normalized.verbrauchEnergyWh = Math.max(0, normalized.netzbezugImportEnergyWh + normalized.solarEnergyWh - normalized.netzbezugExportEnergyWh);
    }

    return normalized;
  }

  function deriveEnergySeriesFromPowerSamples(samples) {
    var derived = samples.map(function (sample) { return Object.assign({}, sample); });
    var gridImportWh = 0;
    var gridExportWh = 0;
    var solarWh = 0;
    var loadWh = 0;

    for (var i = 0; i < derived.length; i += 1) {
      if (i > 0) {
        var previousSample = derived[i - 1];
        var currentSample = derived[i];
        var durationHours = Math.max(0, currentSample.t - previousSample.t) / 3600000;

        gridImportWh += Math.max(0, Number(previousSample.netzbezug || 0)) * durationHours;
        gridExportWh += Math.max(0, -Number(previousSample.netzbezug || 0)) * durationHours;
        solarWh += Math.max(0, -Number(previousSample.solar || 0)) * durationHours;
        loadWh += Math.max(0, Number(previousSample.verbrauch || 0)) * durationHours;
      }

      derived[i].netzbezugImportEnergyWh = gridImportWh;
      derived[i].netzbezugExportEnergyWh = gridExportWh;
      derived[i].solarEnergyWh = solarWh;
      derived[i].verbrauchEnergyWh = loadWh;
    }

    return derived;
  }

  function ensureSampleEnergySeries(samples) {
    var hasStoredEnergy = samples.some(function (sample) {
      return (
        sample.netzbezugImportEnergyWh !== null ||
        sample.netzbezugExportEnergyWh !== null ||
        sample.solarEnergyWh !== null ||
        sample.verbrauchEnergyWh !== null
      );
    });

    return hasStoredEnergy ? samples : deriveEnergySeriesFromPowerSamples(samples);
  }

  function normalizeAndSortSamples(samples) {
    return ensureSampleEnergySeries((samples || []).map(function (sample) {
      return normalizeStoredSample(sample);
    }).sort(function (a, b) { return a.t - b.t; }));
  }

  function getEnergyWindowDelta(startSample, endSample, key) {
    var startValue;
    var endValue;
    if (!startSample || !endSample) return null;
    startValue = readNumberOrNull(startSample[key]);
    endValue = readNumberOrNull(endSample[key]);
    if (startValue === null || endValue === null) return null;
    return Math.max(0, endValue - startValue);
  }

  function getLoadEnergyWh() {
    return Math.max(0, netzbezugImportEnergyWh + solarEnergyWh - netzbezugExportEnergyWh);
  }

  function formatLoadLegendValue(currentValue, averageValue) {
    return formatLegendValue(currentValue, averageValue) + " | " + formatEnergy(getLoadEnergyWh());
  }

  function formatGridLegendValue(currentValue, averageValue) {
    return formatLegendValue(currentValue, averageValue) + " | +" + formatEnergy(netzbezugImportEnergyWh) + " | -" + formatEnergy(netzbezugExportEnergyWh);
  }

  function formatSolarLegendValue(currentValue, averageValue) {
    return formatLegendValue(currentValue, averageValue) + " | " + formatEnergy(solarEnergyWh);
  }

  function formatViewLoadLegendValue(stats) {
    return "Avg " + formatWatts(stats.avgLoad) + " | " + formatEnergy(stats.loadEnergyWh);
  }

  function formatViewGridLegendValue(stats) {
    return "Avg " + formatWatts(stats.avgGrid) + " | +" + formatEnergy(stats.gridImportEnergyWh) + " | -" + formatEnergy(stats.gridExportEnergyWh);
  }

  function formatViewSolarLegendValue(stats) {
    return "Avg " + formatWatts(stats.avgSolar) + " | " + formatEnergy(stats.solarEnergyWh);
  }

  function extractGridEnergyTotals(statusPayload) {
    var energyStatus = statusPayload && statusPayload["emdata:0"];
    if (!energyStatus || typeof energyStatus !== "object") return null;
    if (energyStatus.total_act === undefined || energyStatus.total_act_ret === undefined) return null;
    return {
      totalActWh: Number(energyStatus.total_act),
      totalActRetWh: Number(energyStatus.total_act_ret)
    };
  }

  function getNetEnergyDelta(totalActWh, totalActRetWh) {
    if (!isFinite(totalActWh) || !isFinite(totalActRetWh)) return null;

    if (prevTotalActWh === null || prevTotalActRetWh === null) {
      prevTotalActWh = totalActWh;
      prevTotalActRetWh = totalActRetWh;
      return { verbrauchWh: 0, einspeisungWh: 0 };
    }

    var deltaActWh = totalActWh - prevTotalActWh;
    var deltaActRetWh = totalActRetWh - prevTotalActRetWh;

    prevTotalActWh = totalActWh;
    prevTotalActRetWh = totalActRetWh;

    if (!isFinite(deltaActWh) || !isFinite(deltaActRetWh) || deltaActWh < 0 || deltaActRetWh < 0) {
      return { verbrauchWh: 0, einspeisungWh: 0 };
    }

    var nettoWh = deltaActWh - deltaActRetWh;
    if (nettoWh > 0) return { verbrauchWh: nettoWh, einspeisungWh: 0 };
    if (nettoWh < 0) return { verbrauchWh: 0, einspeisungWh: Math.abs(nettoWh) };
    return { verbrauchWh: 0, einspeisungWh: 0 };
  }

  function updateGridEnergyFromStatus(statusPayload) {
    var totals = extractGridEnergyTotals(statusPayload);
    var delta;
    if (!totals) return;
    delta = getNetEnergyDelta(totals.totalActWh, totals.totalActRetWh);
    if (!delta) return;
    netzbezugImportEnergyWh += delta.verbrauchWh;
    netzbezugExportEnergyWh += delta.einspeisungWh;
  }

  function resetGridEnergyTracking() {
    netzbezugImportEnergyWh = 0;
    netzbezugExportEnergyWh = 0;
    prevTotalActWh = null;
    prevTotalActRetWh = null;
  }

  function extractSolarEnergyTotal(statusPayload) {
    var solarStatus = statusPayload && statusPayload["pm1:0"];
    if (!solarStatus || !solarStatus.aenergy || solarStatus.aenergy.total === undefined) return null;
    return Number(solarStatus.aenergy.total);
  }

  function updateSolarEnergyFromStatus(statusPayload) {
    var totalSolarWh = extractSolarEnergyTotal(statusPayload);
    var deltaSolarWh;
    if (!isFinite(totalSolarWh)) return;

    if (prevSolarTotalWh === null) {
      prevSolarTotalWh = totalSolarWh;
      return;
    }

    deltaSolarWh = totalSolarWh - prevSolarTotalWh;
    prevSolarTotalWh = totalSolarWh;
    if (!isFinite(deltaSolarWh) || deltaSolarWh < 0) return;

    solarEnergyWh += deltaSolarWh;
  }

  function resetSolarEnergyTracking() {
    solarEnergyWh = 0;
    prevSolarTotalWh = null;
  }

  function getStatusPayload(obj) {
    if (obj && obj.result && typeof obj.result === "object") return obj.result;
    if (obj && obj.params && typeof obj.params === "object") return obj.params;
    return null;
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
    if (legendLoadValueEl) legendLoadValueEl.textContent = formatLoadLegendValue(netzbezug - solar, netzbezug - solar);
    if (legendGridValueEl) legendGridValueEl.textContent = formatGridLegendValue(netzbezug, netzbezug);
    if (legendSolarValueEl) legendSolarValueEl.textContent = formatSolarLegendValue(solar, solar);
  }

  function getLegendStatsForSamples(samples, startTime, endTime) {
    var relevantSamples = [];
    var baselineSample = null;
    var latest = null;
    var totals = { load: 0, grid: 0, solar: 0 };

    if (samples && samples.length) {
      for (var i = 0; i < samples.length; i += 1) {
        var sample = samples[i];
        var inRange = true;
        if (typeof startTime === "number" && sample.t <= startTime) baselineSample = sample;
        if (typeof startTime === "number" && sample.t < startTime) inRange = false;
        if (typeof endTime === "number" && sample.t > endTime) inRange = false;
        if (!inRange) continue;
        relevantSamples.push(sample);
      }
    }

    if (relevantSamples.length) {
      latest = relevantSamples[relevantSamples.length - 1];
      for (var j = 0; j < relevantSamples.length; j += 1) {
        totals.load += Number(relevantSamples[j].verbrauch || 0);
        totals.grid += Number(relevantSamples[j].netzbezug || 0);
        totals.solar += Number(relevantSamples[j].solar || 0);
      }
    }

    var count = relevantSamples.length || 1;
    var energyStartSample = baselineSample || (relevantSamples.length ? relevantSamples[0] : null);
    var energyEndSample = relevantSamples.length ? relevantSamples[relevantSamples.length - 1] : null;

    return {
      load: latest ? latest.verbrauch : 0,
      grid: latest ? latest.netzbezug : 0,
      solar: latest ? latest.solar : 0,
      avgLoad: relevantSamples.length ? totals.load / count : 0,
      avgGrid: relevantSamples.length ? totals.grid / count : 0,
      avgSolar: relevantSamples.length ? totals.solar / count : 0,
      loadEnergyWh: getEnergyWindowDelta(energyStartSample, energyEndSample, "verbrauchEnergyWh"),
      gridImportEnergyWh: getEnergyWindowDelta(energyStartSample, energyEndSample, "netzbezugImportEnergyWh"),
      gridExportEnergyWh: getEnergyWindowDelta(energyStartSample, energyEndSample, "netzbezugExportEnergyWh"),
      solarEnergyWh: getEnergyWindowDelta(energyStartSample, energyEndSample, "solarEnergyWh")
    };
  }

  function updateLegendValuesForSamples(samples, loadEl, gridEl, solarEl, startTime, endTime, mode) {
    var stats = getLegendStatsForSamples(samples, startTime, endTime);
    if (mode === "view") {
      if (loadEl) loadEl.textContent = formatViewLoadLegendValue(stats);
      if (gridEl) gridEl.textContent = formatViewGridLegendValue(stats);
      if (solarEl) solarEl.textContent = formatViewSolarLegendValue(stats);
      return;
    }
    if (loadEl) loadEl.textContent = formatLoadLegendValue(stats.load, stats.avgLoad);
    if (gridEl) gridEl.textContent = formatGridLegendValue(stats.grid, stats.avgGrid);
    if (solarEl) solarEl.textContent = formatSolarLegendValue(stats.solar, stats.avgSolar);
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

  function updateHistoryStorageUsageUi(totalBytes) {
    if (!historyStorageUsedEl) return;
    historyStorageUsedEl.textContent = "Speicher gesamt: " + formatBytes(totalBytes || 0);
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
          powerHistory = normalizeAndSortSamples(request.result || []);
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
            var sessionSamples = normalizeAndSortSamples(samplesBySessionId[session.id] || []);
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
        transaction.oncomplete = function () {
          var totalBytes = sessionList.reduce(function (sum, session) {
            return sum + Number(session.storageBytes || 0);
          }, 0);
          updateHistoryStorageUsageUi(totalBytes);
          renderSessions();
          resolve(sessionList);
        };
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

  function getTouchDistance(touchA, touchB) {
    var dx = touchA.clientX - touchB.clientX;
    var dy = touchA.clientY - touchB.clientY;
    return Math.sqrt((dx * dx) + (dy * dy));
  }

  function getTouchCenterX(touchA, touchB) {
    return (touchA.clientX + touchB.clientX) / 2;
  }

  function ensureViewYRangeInitialized() {
    if (typeof viewYMin === "number" && typeof viewYMax === "number") return;
    var autoMin = Infinity;
    var autoMax = -Infinity;
    selectedViewSamples.forEach(function (sample) {
      autoMin = Math.min(autoMin, sample.netzbezug, sample.solar, sample.verbrauch);
      autoMax = Math.max(autoMax, sample.netzbezug, sample.solar, sample.verbrauch);
    });
    if (!isFinite(autoMin) || !isFinite(autoMax) || autoMin === autoMax) {
      autoMin = -100;
      autoMax = 100;
    }
    var autoPadding = Math.max(10, (autoMax - autoMin) * 0.15);
    viewYMin = Math.min(autoMin - autoPadding, 0);
    viewYMax = Math.max(autoMax + autoPadding, 0);
  }

  function isInViewYControlZone(clientX) {
    if (!viewChartCanvas) return false;
    var rect = viewChartCanvas.getBoundingClientRect();
    if (!rect.width) return false;
    return (clientX - rect.left) <= VIEW_Y_CONTROL_ZONE_PX;
  }

  function resetViewWindow() {
    var bounds = getViewBounds();
    viewWindowMs = HISTORY_WINDOW_MS;
    viewYMin = null;
    viewYMax = null;
    if (!bounds) {
      viewWindowStart = null;
      return;
    }
    viewWindowStart = clampViewWindowStart(bounds.max - viewWindowMs, bounds.min, bounds.max, viewWindowMs);
  }

  function renderViewChart() {
    var bounds = getViewBounds();
    if (!bounds) {
      renderChartFromSamples(viewChartCanvas, selectedViewSamples, viewLegendLoadValueEl, viewLegendGridValueEl, viewLegendSolarValueEl, {
        xTickLabels: true,
        legendMode: "view"
      });
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
      valueMin: viewYMin,
      valueMax: viewYMax,
      xTickLabels: true,
      legendMode: "view"
    });
  }

  function renderChartFromSamples(canvas, samples, legendLoadEl, legendGridEl, legendSunEl, options) {
    options = options || {};
    if (!canvas) return;
    var legendStartTime = options.startTime;
    var legendEndTime = options.endTime;
    updateLegendValuesForSamples(samples, legendLoadEl, legendGridEl, legendSunEl, legendStartTime, legendEndTime, options.legendMode);

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

    var computedMinValue = Infinity;
    var computedMaxValue = -Infinity;
    for (var i = 0; i < samples.length; i += 1) {
      var sample = samples[i];
      computedMinValue = Math.min(computedMinValue, sample.netzbezug, sample.solar, sample.verbrauch);
      computedMaxValue = Math.max(computedMaxValue, sample.netzbezug, sample.solar, sample.verbrauch);
    }

    if (!isFinite(computedMinValue) || !isFinite(computedMaxValue)) {
      computedMinValue = 0;
      computedMaxValue = 1;
    }
    if (computedMinValue === computedMaxValue) {
      computedMinValue -= 1;
      computedMaxValue += 1;
    }

    var computedPaddingValue = Math.max(10, (computedMaxValue - computedMinValue) * 0.15);
    computedMinValue = Math.min(computedMinValue - computedPaddingValue, 0);
    computedMaxValue = Math.max(computedMaxValue + computedPaddingValue, 0);

    var computedNiceStep = getNiceStep((computedMaxValue - computedMinValue) / 4);
    computedMinValue = Math.floor(computedMinValue / computedNiceStep) * computedNiceStep;
    computedMaxValue = Math.ceil(computedMaxValue / computedNiceStep) * computedNiceStep;
    if (computedMinValue === computedMaxValue) computedMaxValue = computedMinValue + computedNiceStep;

    var hasManualYRange = typeof options.valueMin === "number" && typeof options.valueMax === "number";
    var minValue = hasManualYRange ? options.valueMin : computedMinValue;
    var maxValue = hasManualYRange ? options.valueMax : computedMaxValue;
    if (!isFinite(minValue) || !isFinite(maxValue) || minValue === maxValue) {
      minValue = computedMinValue;
      maxValue = computedMaxValue;
      hasManualYRange = false;
    }

    var niceStep = getNiceStep((maxValue - minValue) / 6);
    if (!hasManualYRange) {
      minValue = Math.floor(minValue / niceStep) * niceStep;
      maxValue = Math.ceil(maxValue / niceStep) * niceStep;
      if (minValue === maxValue) maxValue = minValue + niceStep;
    }

    var range = maxValue - minValue;

    ctx.save();
    ctx.translate(paddingLeft, paddingTop);

    // Left control strip for Y-axis interactions (offset/range).
    var yZoneWidth = Math.min(plotWidth * 0.22, Math.max(28, VIEW_Y_CONTROL_ZONE_PX * (window.devicePixelRatio || 1)));
    ctx.fillStyle = "rgba(47, 124, 246, 0.08)";
    ctx.fillRect(0, 0, yZoneWidth, plotHeight);
    ctx.strokeStyle = "rgba(47, 124, 246, 0.32)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(yZoneWidth, 0);
    ctx.lineTo(yZoneWidth, plotHeight);
    ctx.stroke();

    var tickValues = [];
    var firstYTick = Math.ceil(minValue / niceStep) * niceStep;
    for (var tickValue = firstYTick; tickValue <= maxValue + (niceStep * 0.5); tickValue += niceStep) {
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
      var xTickStep = Math.max(500, getNiceStep((endTime - startTime) / 6));
      ctx.strokeStyle = "rgba(139, 154, 171, 0.12)";
      ctx.fillStyle = "#8b9aab";
      ctx.textAlign = "center";
      var firstXTick = Math.ceil(startTime / xTickStep) * xTickStep;
      for (var t = firstXTick; t <= endTime + (xTickStep * 0.5); t += xTickStep) {
        var x = ((t - startTime) / (endTime - startTime)) * plotWidth;
        if (x < -1 || x > plotWidth + 1) continue;
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
          var samples = normalizeAndSortSamples(samplesRequest.result || []);
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

  function deleteAllSessions() {
    if (!confirm("Wirklich alle gespeicherten Sessions und Messwerte loeschen?")) return;

    openHistoryDb().then(function (db) {
      var transaction = db.transaction([SESSIONS_STORE, SAMPLES_STORE], "readwrite");
      transaction.objectStore(SESSIONS_STORE).clear();
      transaction.objectStore(SAMPLES_STORE).clear();

      transaction.oncomplete = function () {
        currentSessionId = null;
        selectedViewSamples = [];
        resetViewWindow();
        setViewSessionMeta(null, []);
        renderViewChart();
        updateHistoryStorageUsageUi(0);
        loadStorageStats();
        loadSessions();
        showNote("Alle Sessions wurden geloescht.");
      };
      transaction.onerror = function () { showError("Alle Sessions konnten nicht geloescht werden."); };
    }).catch(function (err) {
      showError("Alle Sessions konnten nicht geloescht werden: " + ((err && err.message) || String(err)));
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
    var normalizedSamples = normalizeAndSortSamples(payload.samples);

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
            verbrauch: sample.verbrauch,
            netzbezugImportEnergyWh: sample.netzbezugImportEnergyWh,
            netzbezugExportEnergyWh: sample.netzbezugExportEnergyWh,
            solarEnergyWh: sample.solarEnergyWh,
            verbrauchEnergyWh: sample.verbrauchEnergyWh
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
      verbrauch: sample.verbrauch,
      netzbezugImportEnergyWh: sample.netzbezugImportEnergyWh,
      netzbezugExportEnergyWh: sample.netzbezugExportEnergyWh,
      solarEnergyWh: sample.solarEnergyWh,
      verbrauchEnergyWh: sample.verbrauchEnergyWh
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

  function getSessionExportFilename(session) {
    return "shelly-session-" + session.id + "-" + new Date(session.startedAt).toISOString().replace(/[:.]/g, "-") + ".json";
  }

  function buildSessionExportPayload(session, samples) {
    return {
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
          verbrauch: sample.verbrauch,
          netzbezugImportEnergyWh: sample.netzbezugImportEnergyWh,
          netzbezugExportEnergyWh: sample.netzbezugExportEnergyWh,
          solarEnergyWh: sample.solarEnergyWh,
          verbrauchEnergyWh: sample.verbrauchEnergyWh
        };
      })
    };
  }

  function isUserCancelledExport(err) {
    return !!(err && (err.name === "AbortError" || err.name === "NotAllowedError"));
  }

  function shouldUseShareSheetForExport() {
    var ua = navigator.userAgent || "";
    var platform = navigator.platform || "";
    var maxTouchPoints = navigator.maxTouchPoints || 0;
    var isAppleMobile = /iPad|iPhone|iPod/i.test(ua);
    var isiPadDesktopMode = platform === "MacIntel" && maxTouchPoints > 1;
    return isAppleMobile || isiPadDesktopMode;
  }

  function triggerBrowserDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return Promise.resolve("download");
  }

  function shareExportBlob(blob, filename) {
    var file;
    if (!navigator.share || typeof window.File === "undefined") {
      return Promise.reject(new Error("share-not-supported"));
    }

    try {
      file = new window.File([blob], filename, { type: "application/json" });
    } catch (_) {
      return Promise.reject(new Error("share-not-supported"));
    }

    try {
      if (navigator.canShare && !navigator.canShare({ files: [file] })) {
        return Promise.reject(new Error("share-not-supported"));
      }
    } catch (_) {
      return Promise.reject(new Error("share-not-supported"));
    }

    return navigator.share({
      files: [file]
    }).then(function () {
      return "share";
    });
  }

  function exportBlob(blob, filename) {
    if (!shouldUseShareSheetForExport()) {
      return triggerBrowserDownload(blob, filename);
    }

    return shareExportBlob(blob, filename).catch(function (shareErr) {
      if (isUserCancelledExport(shareErr)) throw shareErr;
      return triggerBrowserDownload(blob, filename);
    });
  }

  function exportSessionAsJson(sessionId) {
    openHistoryDb().then(function (db) {
      var transaction = db.transaction([SESSIONS_STORE, SAMPLES_STORE], "readonly");
      var sessionRequest = transaction.objectStore(SESSIONS_STORE).get(sessionId);
      var samplesRequest = transaction.objectStore(SAMPLES_STORE).index("sessionId").getAll(sessionId);

      transaction.oncomplete = function () {
        var session = sessionRequest.result;
        var samples = normalizeAndSortSamples(samplesRequest.result || []);
        if (!session) {
          showError("Session nicht gefunden.");
          return;
        }

        var payload = buildSessionExportPayload(session, samples);
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        var filename = getSessionExportFilename(session);

        exportBlob(blob, filename).then(function (method) {
          if (method === "share") {
            showNote("Session " + formatShortDateTime(session.startedAt) + " wurde ueber das Teilen-Menue exportiert.");
          } else {
            showNote("Session " + formatShortDateTime(session.startedAt) + " wurde exportiert.");
          }
        }).catch(function (err) {
          if (isUserCancelledExport(err)) {
            showNote("Export wurde abgebrochen.");
            return;
          }
          showError("Session-Export fehlgeschlagen: " + ((err && err.message) || String(err)));
        });
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
    var sample = {
      t: now,
      netzbezug: netzbezug,
      solar: solar,
      verbrauch: netzbezug - solar,
      netzbezugImportEnergyWh: netzbezugImportEnergyWh,
      netzbezugExportEnergyWh: netzbezugExportEnergyWh,
      solarEnergyWh: solarEnergyWh,
      verbrauchEnergyWh: getLoadEnergyWh()
    };
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
    var statusPayload;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      setOut(text);
      return;
    }

    statusPayload = getStatusPayload(obj);
    updateGridEnergyFromStatus(statusPayload);

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
    resetGridEnergyTracking();
    resetSolarEnergyTracking();
    updateVerbrauch();
    updateLegendValues();
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
    resetGridEnergyTracking();
    resetSolarEnergyTracking();
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
        var statusPayload = getStatusPayload(obj);
        updateSolarEnergyFromStatus(statusPayload);
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

  if (btnDeleteAllSessions) {
    btnDeleteAllSessions.addEventListener("click", function () {
      deleteAllSessions();
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
      var inYZone = isInViewYControlZone(event.clientX);
      var ratio = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0.5;
      if (inYZone) {
        ensureViewYRangeInitialized();
        var currentYRange = Math.max(1, viewYMax - viewYMin);
        var yFactor = event.deltaY > 0 ? 1.12 : 0.88;
        var nextYRange = Math.max(10, currentYRange * yFactor);
        var centerY = (viewYMin + viewYMax) / 2;
        viewYMin = centerY - (nextYRange / 2);
        viewYMax = centerY + (nextYRange / 2);
        renderViewChart();
        return;
      }
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
      viewDragMode = isInViewYControlZone(event.clientX) ? "y" : "x";
      viewDragStartX = event.clientX;
      viewDragStartY = event.clientY;
      viewDragStartWindow = viewWindowStart || 0;
      ensureViewYRangeInitialized();
      viewYDragStartMin = viewYMin;
      viewYDragStartMax = viewYMax;
    });

    viewChartCanvas.addEventListener("touchstart", function (event) {
      if (!selectedViewSamples.length || !event.touches || !event.touches.length) return;
      var bounds = getViewBounds();
      if (!bounds) return;

      if (event.touches.length === 1) {
        event.preventDefault();
        viewTouchPinching = false;
        viewTouchDragging = true;
        viewTouchDragMode = isInViewYControlZone(event.touches[0].clientX) ? "y" : "x";
        viewTouchDragStartX = event.touches[0].clientX;
        viewTouchDragStartY = event.touches[0].clientY;
        viewTouchDragStartWindow = viewWindowStart === null ? (bounds.max - viewWindowMs) : viewWindowStart;
        ensureViewYRangeInitialized();
        viewTouchDragStartMin = viewYMin;
        viewTouchDragStartMax = viewYMax;
        return;
      }

      if (!selectedViewSamples.length || !event.touches || event.touches.length !== 2) return;
      event.preventDefault();
      viewTouchDragging = false;
      var rect = viewChartCanvas.getBoundingClientRect();
      var touchA = event.touches[0];
      var touchB = event.touches[1];
      var distance = getTouchDistance(touchA, touchB);
      if (!isFinite(distance) || distance <= 0) return;

      var centerX = getTouchCenterX(touchA, touchB);
      var pinchInYZone = isInViewYControlZone(centerX);
      viewTouchAnchorRatio = rect.width > 0 ? Math.min(1, Math.max(0, (centerX - rect.left) / rect.width)) : 0.5;
      viewTouchDragMode = pinchInYZone ? "y" : "x";
      if (pinchInYZone) {
        ensureViewYRangeInitialized();
        viewYDragStartMin = viewYMin;
        viewYDragStartMax = viewYMax;
      }
      viewTouchPinching = true;
      viewTouchStartDistance = distance;
      viewTouchStartWindowMs = viewWindowMs;
      viewTouchStartWindowStart = viewWindowStart === null ? bounds.max - viewWindowMs : viewWindowStart;
    }, { passive: false });

    viewChartCanvas.addEventListener("touchmove", function (event) {
      if (viewTouchDragging && !viewTouchPinching && event.touches && event.touches.length === 1) {
        event.preventDefault();
        var bounds = getViewBounds();
        if (!bounds) return;
        var rect = viewChartCanvas.getBoundingClientRect();
        if (viewTouchDragMode === "x" && rect.width > 0) {
          var deltaX = event.touches[0].clientX - viewTouchDragStartX;
          var msPerPixel = viewWindowMs / rect.width;
          var nextWindow = viewTouchDragStartWindow - (deltaX * msPerPixel);
          viewWindowStart = clampViewWindowStart(nextWindow, bounds.min, bounds.max, viewWindowMs);
        }
        if (viewTouchDragMode === "y" && rect.height > 0) {
          ensureViewYRangeInitialized();
          var deltaY = event.touches[0].clientY - viewTouchDragStartY;
          var valueRange = Math.max(1, viewTouchDragStartMax - viewTouchDragStartMin);
          var valuePerPixel = valueRange / rect.height;
          var valueShift = deltaY * valuePerPixel;
          var center = ((viewTouchDragStartMin + viewTouchDragStartMax) / 2) + valueShift;
          viewYMin = center - (valueRange / 2);
          viewYMax = center + (valueRange / 2);
        }
        renderViewChart();
        return;
      }

      if (!viewTouchPinching || !selectedViewSamples.length || !event.touches || event.touches.length !== 2) return;
      event.preventDefault();
      var bounds = getViewBounds();
      if (!bounds) return;

      var distance = getTouchDistance(event.touches[0], event.touches[1]);
      if (!isFinite(distance) || distance <= 0 || viewTouchStartDistance <= 0) return;

      var pinchRatio = viewTouchStartDistance / distance;
      if (viewTouchDragMode === "y") {
        ensureViewYRangeInitialized();
        var startRangeY = Math.max(1, viewYDragStartMax - viewYDragStartMin);
        var newRangeY = Math.max(10, startRangeY * pinchRatio);
        var centerY = (viewYDragStartMin + viewYDragStartMax) / 2;
        viewYMin = centerY - (newRangeY / 2);
        viewYMax = centerY + (newRangeY / 2);
      } else {
        var duration = Math.max(1, bounds.max - bounds.min);
        var minWindow = 5000;
        var maxWindow = Math.max(HISTORY_WINDOW_MS, duration);
        var newWindow = Math.min(maxWindow, Math.max(minWindow, viewTouchStartWindowMs * pinchRatio));
        var anchorTime = viewTouchStartWindowStart + (viewTouchStartWindowMs * viewTouchAnchorRatio);
        viewWindowMs = newWindow;
        viewWindowStart = clampViewWindowStart(anchorTime - (newWindow * viewTouchAnchorRatio), bounds.min, bounds.max, newWindow);
      }
      renderViewChart();
    }, { passive: false });

    viewChartCanvas.addEventListener("touchend", function () {
      viewTouchDragging = false;
      if (!viewTouchPinching) return;
      viewTouchPinching = false;
      viewTouchStartDistance = 0;
    });

    viewChartCanvas.addEventListener("touchcancel", function () {
      viewTouchDragging = false;
      if (!viewTouchPinching) return;
      viewTouchPinching = false;
      viewTouchStartDistance = 0;
    });

    window.addEventListener("mousemove", function (event) {
      if (!viewDragging || !selectedViewSamples.length) return;
      var bounds = getViewBounds();
      if (!bounds) return;
      var rect = viewChartCanvas.getBoundingClientRect();
      if (viewDragMode === "x") {
        if (rect.width <= 0) return;
        var deltaX = event.clientX - viewDragStartX;
        var msPerPixel = viewWindowMs / rect.width;
        var nextWindow = viewDragStartWindow - (deltaX * msPerPixel);
        viewWindowStart = clampViewWindowStart(nextWindow, bounds.min, bounds.max, viewWindowMs);
      } else if (rect.height > 0) {
        ensureViewYRangeInitialized();
        var deltaY = event.clientY - viewDragStartY;
        var valueRange = Math.max(1, viewYDragStartMax - viewYDragStartMin);
        var valuePerPixel = valueRange / rect.height;
        var valueShift = deltaY * valuePerPixel;
        var center = ((viewYDragStartMin + viewYDragStartMax) / 2) + valueShift;
        viewYMin = center - (valueRange / 2);
        viewYMax = center + (valueRange / 2);
      }
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
  updateHistoryStorageUsageUi(0);
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
