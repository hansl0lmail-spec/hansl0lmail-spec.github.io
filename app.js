(function () {
  "use strict";

  var WS_WAIT_MS = 15000;
  var HISTORY_WINDOW_MS = 120000;
  var SHELLY1_BASE_URL = "http://192.168.178.52";
  var SHELLY2_BASE_URL = "http://192.168.178.53";

  var form = document.getElementById("form");
  var btnConnect = document.getElementById("btnConnect");
  var wsConn = null;
  var wsConn2 = null;
  var waitTimer = null;
  var waitTimer2 = null;
  var userClosed = false;

  var out = document.getElementById("out");
  var errEl = document.getElementById("err");
  var noteEl = document.getElementById("note");
  var powerValueEl = document.getElementById("powerValue");
  var powerValueEl2 = document.getElementById("powerValue2");
  var powerValueEl3 = document.getElementById("powerValue3");
  var chartCanvas = document.getElementById("powerChart");
  var legendLoadValueEl = document.getElementById("legendLoadValue");
  var legendGridValueEl = document.getElementById("legendGridValue");
  var legendSolarValueEl = document.getElementById("legendSolarValue");
  var powerStatusEl2 = document.getElementById("powerStatus2");
  var updateIntervalId = null;
  var updateIntervalId2 = null;
  var chartRefreshIntervalId = null;

  var netzbezug = 0;
  var solar = 0;
  var powerHistory = [];

  function appendNote(msg) {
    if (!msg) return;
    if (!noteEl) return;
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

  function setPowerStatus2(msg) {
    if (!powerStatusEl2) return;
    powerStatusEl2.textContent = msg || "";
  }

  function updateVerbrauch() {
    var verbrauch = netzbezug - solar;
    if (powerValueEl3) {
      powerValueEl3.textContent = verbrauch.toFixed(1);
    }
  }

  function formatWatts(value) {
    return Number(value || 0).toFixed(1) + " W";
  }

  function getNiceStep(rawStep) {
    if (!isFinite(rawStep) || rawStep <= 0) return 1;

    var exponent = Math.floor(Math.log(rawStep) / Math.LN10);
    var fraction = rawStep / Math.pow(10, exponent);
    var niceFraction;

    if (fraction <= 1) {
      niceFraction = 1;
    } else if (fraction <= 2) {
      niceFraction = 2;
    } else if (fraction <= 5) {
      niceFraction = 5;
    } else {
      niceFraction = 10;
    }

    return niceFraction * Math.pow(10, exponent);
  }

  function updateLegendValues() {
    if (legendLoadValueEl) {
      legendLoadValueEl.textContent = formatWatts(netzbezug - solar);
    }
    if (legendGridValueEl) {
      legendGridValueEl.textContent = formatWatts(netzbezug);
    }
    if (legendSolarValueEl) {
      legendSolarValueEl.textContent = formatWatts(solar);
    }
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

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
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
    minValue -= paddingValue;
    maxValue += paddingValue;

    minValue = Math.min(minValue, 0);
    maxValue = Math.max(maxValue, 0);

    var lineCount = 4;
    var niceStep = getNiceStep((maxValue - minValue) / lineCount);
    var scaledMinValue = Math.floor(minValue / niceStep) * niceStep;
    var scaledMaxValue = Math.ceil(maxValue / niceStep) * niceStep;

    if (scaledMinValue === scaledMaxValue) {
      scaledMaxValue = scaledMinValue + niceStep;
    }

    minValue = scaledMinValue;
    maxValue = scaledMaxValue;

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
    var now = Date.now();
    powerHistory.push({
      t: now,
      netzbezug: netzbezug,
      solar: solar,
      verbrauch: netzbezug - solar
    });
    pruneHistory(now);
    renderChart();
  }

  function normalizeBase(raw) {
    var s = String(raw || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) {
      s = "http://" + s;
    }
    return s.replace(/\/+$/, "");
  }

  function httpBaseToWsRpcUrl(base) {
    var u = new URL(base);
    return (u.protocol === "https:" ? "wss:" : "ws:") + "//" + u.host + "/rpc";
  }

  function setConnectUi(connected) {
    if (!btnConnect) return;
    btnConnect.textContent = connected ? "Stop" : "Start";
    btnConnect.setAttribute("aria-pressed", connected ? "true" : "false");
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

    netzbezug = 0;
    solar = 0;
    updateVerbrauch();
    powerHistory = [];
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

    var base = normalizeBase(SHELLY1_BASE_URL);
    var wsUrl = httpBaseToWsRpcUrl(base);

    if (wsConn) {
      try { wsConn.close(); } catch (_) {}
      wsConn = null;
    }

    userClosed = false;
    setOut("Verbinde Shelly 52 … " + wsUrl);

    waitTimer = setTimeout(function () {
      showError("Keine Antwort innerhalb von " + WS_WAIT_MS / 1000 + " s.");
      disconnect();
      setOut("— Timeout —");
    }, WS_WAIT_MS);

    try {
      wsConn = new WebSocket(wsUrl);
    } catch (e) {
      clearWaitTimer();
      showError((e && e.message) || String(e));
      setOut("— Fehler —");
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
        setOut("— Fehler —");
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

    // Zweites Shelly/pm1:0 zeitgleich starten
    checkShelly2Ws();
  }

  function checkShelly2Ws() {
    if (wsConn2 && wsConn2.readyState === WebSocket.OPEN) {
      setPowerStatus2("Shelly 53 bereits verbunden.");
      return;
    }

    if (wsConn2) {
      try { wsConn2.close(); } catch (_) {}
      wsConn2 = null;
    }

    setPowerStatus2("Teste WS-Verbindung Shelly 53 ...");

    var base = normalizeBase(SHELLY2_BASE_URL);
    var wsUrl = httpBaseToWsRpcUrl(base);

    waitTimer2 = setTimeout(function () {
      setPowerStatus2("Keine Antwort von Shelly 53 innerhalb " + WS_WAIT_MS / 1000 + " s.");
      if (wsConn2) {
        try { wsConn2.close(); } catch (_) {}
        wsConn2 = null;
      }
    }, WS_WAIT_MS);

    try {
      wsConn2 = new WebSocket(wsUrl);
    } catch (e) {
      clearWaitTimer2();
      setPowerStatus2("WS-Verbindung Shelly 53 fehlgeschlagen: " + ((e && e.message) || String(e)));
      return;
    }

    wsConn2.addEventListener("open", function () {
      clearWaitTimer2();
      setPowerStatus2("Shelly 53 verbunden, Starte 2Hz Abfrage");
      if (wsConn2 && wsConn2.readyState === WebSocket.OPEN) {
        wsConn2.send(JSON.stringify({ id: 1, src: "user_2", method: "Shelly.GetStatus" }));
      }

      if (updateIntervalId2) {
        clearInterval(updateIntervalId2);
      }
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
          setPowerStatus2("pm1:0 apower empfangen");
          updateVerbrauch();
          recordHistoryPoint();
        } else if (obj.params && obj.params["pm1:0"] && obj.params["pm1:0"].apower !== undefined) {
          solar = Number(obj.params["pm1:0"].apower);
          powerValueEl2.textContent = solar.toFixed(1);
          setPowerStatus2("pm1:0 apower empfangen");
          updateVerbrauch();
          recordHistoryPoint();
        } else {
          setPowerStatus2("pm1:0 apower nicht gefunden in Antwort");
        }
      } catch (e) {
        setPowerStatus2("Ungültige JSON-Antwort von Shelly 53.");
      }
    });

    wsConn2.addEventListener("error", function () {
      clearWaitTimer2();
      setPowerStatus2("WebSocket-Fehler Shelly 53.");
    });

    wsConn2.addEventListener("close", function (ev) {
      clearWaitTimer2();
      if (updateIntervalId2) {
        clearInterval(updateIntervalId2);
        updateIntervalId2 = null;
      }
      wsConn2 = null;
      if (!userClosed && ev.code !== 1000) {
        setPowerStatus2("Shelly 53 Verbindung beendet (Code " + ev.code + ").");
      }
    });
  }

  function hintIfHttpsPage() {
    if (location.protocol === "https:") {
      showNote("Seite über HTTPS: ws:// zu Shelly kann blockiert werden — Seite über http:// öffnen.");
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      appendNote("Dieser Browser unterstuetzt keine Service Worker.");
      return;
    }

    if (!window.isSecureContext) {
      appendNote("Offline-PWA braucht HTTPS oder localhost. Ueber eine lokale IP per http kann der Service Worker nicht gespeichert werden.");
      return;
    }

    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./service-worker.js").then(function () {
        appendNote("PWA-Offlinecache ist aktiv.");
      }).catch(function (err) {
        appendNote("Service Worker konnte nicht registriert werden: " + ((err && err.message) || String(err)));
      });
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    connect();
  });

  btnConnect.addEventListener("click", function (e) {
    e.preventDefault();
    connect();
  });

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
  });

  window.addEventListener("resize", renderChart);

  showNote("Shelly 192.168.178.52 + 192.168.178.53 fest konfiguriert.");
  hintIfHttpsPage();
  registerServiceWorker();
  chartRefreshIntervalId = setInterval(renderChart, 1000);
  renderChart();
})();
