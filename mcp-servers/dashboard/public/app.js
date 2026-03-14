/** PerfAgent Dashboard — vanilla JS, no framework */

// ── State ──────────────────────────────────────────────────────────────────
let services = [];
let currentMode = "deterministic";
let latencyChart = null;
let activeRunController = null;

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initModeToggle();
  loadServices();
  loadResultsList();
});

// ── Tab navigation ─────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${tab}`).classList.add("active");
      if (tab === "results") loadResultsList();
    });
  });
}

// ── Mode toggle ────────────────────────────────────────────────────────────
function initModeToggle() {
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentMode = btn.dataset.mode;
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("form-deterministic").style.display =
        currentMode === "deterministic" ? "" : "none";
      document.getElementById("form-agent").style.display =
        currentMode === "agent" ? "" : "none";
    });
  });

  document.getElementById("d-run-btn").addEventListener("click", runDeterministic);
  document.getElementById("a-run-btn").addEventListener("click", runAgent);
}

// ── Load services into dropdown ────────────────────────────────────────────
async function loadServices() {
  try {
    const { services: list } = await api("/api/services");
    services = list;
    const sel = document.getElementById("d-service");
    sel.innerHTML = list
      .map((s) => `<option value="${s.name}">${s.name} — ${s.description}</option>`)
      .join("");
    sel.addEventListener("change", updateEnvDropdown);
    updateEnvDropdown();
  } catch (e) {
    document.getElementById("d-service").innerHTML =
      '<option value="">Could not load services</option>';
  }
}

function updateEnvDropdown() {
  const name = document.getElementById("d-service").value;
  const svc = services.find((s) => s.name === name);
  const envSel = document.getElementById("d-env");
  if (svc) {
    envSel.innerHTML = svc.environments
      .map((e) => `<option value="${e}">${e}</option>`)
      .join("");
  }
}

// ── Run deterministic ──────────────────────────────────────────────────────
function runDeterministic() {
  const service = document.getElementById("d-service").value;
  if (!service) return alert("Please select a service.");

  const payload = {
    service,
    env: document.getElementById("d-env").value || "local",
    users: document.getElementById("d-users").value || undefined,
    duration: document.getElementById("d-duration").value || undefined,
    baseline: document.getElementById("d-baseline").value || undefined,
    save_as: document.getElementById("d-save-as").value || undefined,
  };

  startRunStream("/api/run/deterministic", payload);
}

// ── Run agent ──────────────────────────────────────────────────────────────
function runAgent() {
  const message = document.getElementById("a-message").value.trim();
  if (!message) return alert("Please describe what you want to test.");
  startRunStream("/api/run/agent", { message });
}

// ── SSE stream handler ─────────────────────────────────────────────────────
function startRunStream(url, payload) {
  // Cancel any active run
  if (activeRunController) activeRunController.abort();

  const output = document.getElementById("run-output");
  const log = document.getElementById("log-stream");
  const badge = document.getElementById("run-badge");

  output.style.display = "";
  log.innerHTML = "";
  setBadge(badge, "running");

  // Disable run buttons during run
  setRunBtnsDisabled(true);

  // Scroll log to bottom on new content
  const observer = new MutationObserver(() => {
    log.scrollTop = log.scrollHeight;
  });
  observer.observe(log, { childList: true });

  activeRunController = new AbortController();

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: activeRunController.signal,
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      function readChunk() {
        return reader.read().then(({ done, value }) => {
          if (done) {
            observer.disconnect();
            setRunBtnsDisabled(false);
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const event = JSON.parse(dataLine.slice(6));
              handleStreamEvent(event, log, badge);
            } catch {}
          }
          return readChunk();
        });
      }
      return readChunk();
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        appendLog(log, `[error] ${err.message}`, true);
        setRunBtnsDisabled(false);
        observer.disconnect();
      }
    });
}

function handleStreamEvent(event, log, badge) {
  if (event.type === "log") {
    appendLog(log, event.text);
  } else if (event.type === "done") {
    setBadge(badge, event.verdict === "PASS" ? "pass" : "fail");
    appendLog(log, `\n── Run complete: ${event.verdict} ──`, event.verdict !== "PASS");
    setRunBtnsDisabled(false);
  } else if (event.type === "error") {
    appendLog(log, `[error] ${event.text}`, true);
    setBadge(badge, "fail");
    setRunBtnsDisabled(false);
  }
}

function appendLog(container, text, isError = false) {
  const line = document.createElement("div");
  line.className = "log-line" + (isError ? " error" : "");
  line.textContent = text;
  container.appendChild(line);
}

function setBadge(badge, state) {
  badge.className = "badge";
  if (state === "running") { badge.classList.add("badge-running"); badge.textContent = "RUNNING"; }
  else if (state === "pass") { badge.classList.add("badge-pass"); badge.textContent = "PASS"; }
  else { badge.classList.add("badge-fail"); badge.textContent = "FAIL"; }
}

function setRunBtnsDisabled(disabled) {
  document.getElementById("d-run-btn").disabled = disabled;
  document.getElementById("a-run-btn").disabled = disabled;
}

// ── Results list ───────────────────────────────────────────────────────────
async function loadResultsList() {
  const container = document.getElementById("results-index");
  try {
    const { results } = await api("/api/results");
    if (!results.length) {
      container.innerHTML = '<p style="color:var(--muted);font-size:.85rem">No results yet.</p>';
      return;
    }
    container.innerHTML = results
      .map(
        (r) => `
        <div class="result-item" data-name="${r.name}">
          <div class="r-name">${r.name}</div>
          <div class="r-meta">
            ${r.p95_ms != null ? `p95: ${Math.round(r.p95_ms)}ms` : ""}
            ${r.error_rate != null ? ` · err: ${(r.error_rate * 100).toFixed(2)}%` : ""}
            ${r.rps != null ? ` · ${r.rps.toFixed(1)} rps` : ""}
          </div>
        </div>`
      )
      .join("");

    container.querySelectorAll(".result-item").forEach((el) => {
      el.addEventListener("click", () => {
        container.querySelectorAll(".result-item").forEach((e) => e.classList.remove("active"));
        el.classList.add("active");
        loadResultDetail(el.dataset.name);
      });
    });
  } catch (e) {
    container.innerHTML = '<p style="color:var(--danger);font-size:.85rem">Failed to load results.</p>';
  }
}

// ── Result detail ──────────────────────────────────────────────────────────
async function loadResultDetail(name) {
  document.getElementById("detail-empty").style.display = "none";
  document.getElementById("detail-content").style.display = "";

  try {
    const data = await api(`/api/results/${encodeURIComponent(name)}`);

    document.getElementById("detail-title").textContent = name;

    const dur = data.http_req_duration ?? {};
    const failed = data.http_req_failed ?? {};
    const reqs = data.http_reqs ?? {};

    setText("m-p95", dur["p(95)"] != null ? `${Math.round(dur["p(95)"])}ms` : "—");
    setText("m-p99", dur["p(99)"] != null ? `${Math.round(dur["p(99)"])}ms` : "—");
    setText("m-rps", reqs.rate != null ? `${reqs.rate.toFixed(1)}/s` : "—");
    const errRate = failed.rate ?? 0;
    const errEl = document.getElementById("m-err");
    errEl.textContent = `${(errRate * 100).toFixed(2)}%`;
    errEl.style.color = errRate > 0.01 ? "var(--danger)" : "var(--success)";

    renderLatencyChart(dur);
    renderThresholds(data.thresholds ?? {});
  } catch (e) {
    document.getElementById("detail-content").innerHTML =
      `<p style="color:var(--danger)">Failed to load: ${e.message}</p>`;
  }
}

function renderLatencyChart(dur) {
  const ctx = document.getElementById("chart-latency");
  if (latencyChart) latencyChart.destroy();

  const labels = ["min", "p50", "avg", "p90", "p95", "p99", "max"];
  const keys = ["min", "med", "avg", "p(90)", "p(95)", "p(99)", "max"];
  const values = keys.map((k) => (dur[k] != null ? Math.round(dur[k]) : 0));

  latencyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "ms",
          data: values,
          backgroundColor: values.map((v, i) => {
            if (i >= 4) return "rgba(239,68,68,0.7)";
            if (i >= 2) return "rgba(245,158,11,0.7)";
            return "rgba(99,102,241,0.7)";
          }),
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#64748b" }, grid: { color: "#1e2130" } },
        y: {
          ticks: { color: "#64748b", callback: (v) => `${v}ms` },
          grid: { color: "#1e2130" },
        },
      },
    },
  });
}

function renderThresholds(thresholds) {
  const container = document.getElementById("threshold-list");
  const entries = Object.entries(thresholds);
  if (!entries.length) {
    container.innerHTML = '<p style="color:var(--muted);font-size:.82rem">No threshold data.</p>';
    return;
  }
  container.innerHTML = entries
    .map(([key, t]) => {
      const ok = t.ok !== false;
      return `
        <div class="threshold-row">
          <span class="t-name">${key}</span>
          <span class="${ok ? "t-pass" : "t-fail"}">${ok ? "✓ PASS" : "✗ FAIL"}</span>
        </div>`;
    })
    .join("");
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function api(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}
