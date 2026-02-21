#!/usr/bin/env node

/**
 * App Metrics MCP Server — Framework-Agnostic
 *
 * Supports multiple metric sources:
 *   - Spring Boot Actuator (/actuator/health, /actuator/metrics/*)
 *   - Prometheus format     (/metrics — FastAPI, Flask, Django, Go, Node.js)
 *   - Generic health        (/health, /healthz, /actuator/health)
 *
 * Auto-detects which format a service exposes and adapts accordingly.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../..");
const SNAPSHOTS_DIR = resolve(PROJECT_ROOT, "results", "snapshots");

if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });

const server = new Server(
  { name: "app-metrics", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Fetch Helpers ───────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<any> {
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return await res.json();
}

async function fetchText(url: string, timeoutMs = 5000): Promise<string> {
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return await res.text();
}

// ─── Metrics Source Detection ────────────────────────────────────────────────

type MetricsSource = "spring_actuator" | "prometheus" | "none";

async function detectMetricsSource(baseUrl: string): Promise<MetricsSource> {
  // Try Spring Actuator first
  try {
    const res = await fetchWithTimeout(`${baseUrl}/actuator/health`, 3000);
    if (res.ok) return "spring_actuator";
  } catch {}

  // Try Prometheus /metrics
  try {
    const res = await fetchWithTimeout(`${baseUrl}/metrics`, 3000);
    if (res.ok) {
      const text = await res.text();
      // Prometheus format has lines like: metric_name{labels} value
      if (text.includes("# HELP") || text.includes("# TYPE") || /^\w+[\s{]/m.test(text)) {
        return "prometheus";
      }
    }
  } catch {}

  return "none";
}

// ─── Health Check (multi-path) ───────────────────────────────────────────────

const HEALTH_PATHS = ["/health", "/healthz", "/actuator/health", "/api/health", "/_health"];

async function checkHealthMultiPath(baseUrl: string): Promise<{ path: string; status: string; details: any }> {
  for (const path of HEALTH_PATHS) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}${path}`, 3000);
      if (res.ok) {
        const contentType = res.headers.get("content-type") || "";
        let details: any;
        if (contentType.includes("json")) {
          details = await res.json();
        } else {
          const text = await res.text();
          details = { raw: text.slice(0, 500) };
        }
        return {
          path,
          status: details.status || "UP",
          details,
        };
      }
    } catch {}
  }
  return { path: "none", status: "UNREACHABLE", details: {} };
}

// ─── Spring Actuator Metrics ─────────────────────────────────────────────────

async function fetchActuatorMetric(baseUrl: string, metricName: string): Promise<any> {
  try {
    return await fetchJson(`${baseUrl}/actuator/metrics/${metricName}`);
  } catch {
    return null;
  }
}

function extractActuatorValue(metric: any): number | null {
  if (!metric?.measurements) return null;
  const m = metric.measurements.find((m: any) => m.statistic === "VALUE" || m.statistic === "COUNT");
  return m?.value ?? null;
}

async function getSpringRuntimeMetrics(baseUrl: string): Promise<Record<string, any>> {
  const [heapUsed, heapMax, heapCommitted, threadsLive, threadsPeak, gcPause, cpuUsage, cpuCount] =
    await Promise.all([
      fetchActuatorMetric(baseUrl, "jvm.memory.used"),
      fetchActuatorMetric(baseUrl, "jvm.memory.max"),
      fetchActuatorMetric(baseUrl, "jvm.memory.committed"),
      fetchActuatorMetric(baseUrl, "jvm.threads.live"),
      fetchActuatorMetric(baseUrl, "jvm.threads.peak"),
      fetchActuatorMetric(baseUrl, "jvm.gc.pause"),
      fetchActuatorMetric(baseUrl, "process.cpu.usage"),
      fetchActuatorMetric(baseUrl, "system.cpu.count"),
    ]);

  const toMB = (bytes: number | null) => (bytes ? Math.round(bytes / 1024 / 1024) : null);
  const gcMeasurements = gcPause?.measurements || [];

  return {
    runtime: "jvm",
    memory: {
      used_mb: toMB(extractActuatorValue(heapUsed)),
      max_mb: toMB(extractActuatorValue(heapMax)),
      committed_mb: toMB(extractActuatorValue(heapCommitted)),
      usage_percent:
        extractActuatorValue(heapUsed) && extractActuatorValue(heapMax)
          ? Math.round((extractActuatorValue(heapUsed)! / extractActuatorValue(heapMax)!) * 100)
          : null,
    },
    threads: {
      live: extractActuatorValue(threadsLive),
      peak: extractActuatorValue(threadsPeak),
    },
    gc: {
      pause_count: gcMeasurements.find((m: any) => m.statistic === "COUNT")?.value ?? 0,
      total_pause_seconds:
        Math.round((gcMeasurements.find((m: any) => m.statistic === "TOTAL_TIME")?.value ?? 0) * 1000) / 1000,
      max_pause_ms: Math.round(
        (gcMeasurements.find((m: any) => m.statistic === "MAX")?.value ?? 0) * 1000
      ),
    },
    cpu: {
      process_usage_percent: cpuUsage ? Math.round(extractActuatorValue(cpuUsage)! * 100) : null,
      available_processors: extractActuatorValue(cpuCount),
    },
  };
}

async function getSpringDbMetrics(baseUrl: string): Promise<Record<string, any>> {
  const [active, idle, pending, max] = await Promise.all([
    fetchActuatorMetric(baseUrl, "hikaricp.connections.active"),
    fetchActuatorMetric(baseUrl, "hikaricp.connections.idle"),
    fetchActuatorMetric(baseUrl, "hikaricp.connections.pending"),
    fetchActuatorMetric(baseUrl, "hikaricp.connections.max"),
  ]);

  const activeVal = extractActuatorValue(active);
  const maxVal = extractActuatorValue(max);

  return {
    pool_type: "hikaricp",
    active_connections: activeVal,
    idle_connections: extractActuatorValue(idle),
    pending_threads: extractActuatorValue(pending),
    max_pool_size: maxVal,
    pool_usage_percent: activeVal !== null && maxVal ? Math.round((activeVal / maxVal) * 100) : null,
  };
}

async function getSpringHttpMetrics(baseUrl: string): Promise<Record<string, any>> {
  const httpMetric = await fetchActuatorMetric(baseUrl, "http.server.requests");
  if (!httpMetric) return { available: false };

  const measurements = httpMetric.measurements || [];
  const tags = httpMetric.availableTags || [];

  return {
    available: true,
    total_requests: measurements.find((m: any) => m.statistic === "COUNT")?.value ?? 0,
    total_time_seconds: measurements.find((m: any) => m.statistic === "TOTAL_TIME")?.value ?? 0,
    max_duration_ms: Math.round(
      (measurements.find((m: any) => m.statistic === "MAX")?.value ?? 0) * 1000
    ),
    breakdowns: tags.map((t: any) => ({ tag: t.tag, values: t.values?.slice(0, 20) })),
  };
}

// ─── Prometheus Metrics Parser ───────────────────────────────────────────────

function parsePrometheusText(text: string): Map<string, number> {
  const metrics = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;

    // Match: metric_name{labels} value  OR  metric_name value
    const match = line.match(/^(\S+?)(?:\{[^}]*\})?\s+([\d.eE+-]+)/);
    if (match) {
      const name = match[1];
      const value = parseFloat(match[2]);
      if (!isNaN(value)) {
        // For counters/gauges with same name, keep the first or sum
        if (!metrics.has(name)) {
          metrics.set(name, value);
        }
      }
    }
  }
  return metrics;
}

async function getPrometheusRuntimeMetrics(baseUrl: string): Promise<Record<string, any>> {
  let text: string;
  try {
    text = await fetchText(`${baseUrl}/metrics`);
  } catch {
    return { runtime: "unknown", error: "Could not fetch /metrics" };
  }

  const m = parsePrometheusText(text);

  // Detect runtime from metric names
  let runtime = "unknown";
  if (m.has("python_info") || m.has("python_gc_collections_total")) runtime = "python";
  else if (m.has("nodejs_version_info") || m.has("nodejs_heap_size_total_bytes")) runtime = "nodejs";
  else if (m.has("go_goroutines") || m.has("go_memstats_alloc_bytes")) runtime = "go";
  else if (m.has("jvm_memory_used_bytes")) runtime = "jvm";

  const result: Record<string, any> = { runtime };

  // Memory — try multiple conventions
  const memUsed =
    m.get("process_resident_memory_bytes") ??
    m.get("nodejs_heap_size_used_bytes") ??
    m.get("go_memstats_alloc_bytes") ??
    m.get("jvm_memory_used_bytes");
  const memMax =
    m.get("nodejs_heap_size_total_bytes") ??
    m.get("go_memstats_sys_bytes") ??
    m.get("jvm_memory_max_bytes");

  const toMB = (b: number | undefined) => (b !== undefined ? Math.round(b / 1024 / 1024) : null);

  result.memory = {
    used_mb: toMB(memUsed),
    max_mb: toMB(memMax),
    usage_percent: memUsed && memMax ? Math.round((memUsed / memMax) * 100) : null,
  };

  // CPU
  const cpuSeconds = m.get("process_cpu_seconds_total");
  result.cpu = {
    process_cpu_seconds_total: cpuSeconds ?? null,
  };

  // Threads / Goroutines / Asyncio
  if (runtime === "go") {
    result.concurrency = { goroutines: m.get("go_goroutines") ?? null };
  } else if (runtime === "python") {
    result.concurrency = {
      threads: m.get("python_threads") ?? m.get("process_threads_total") ?? null,
    };
    // Python GC
    const gcCollections = m.get("python_gc_collections_total");
    if (gcCollections !== undefined) {
      result.gc = { collections_total: gcCollections };
    }
  } else if (runtime === "nodejs") {
    result.concurrency = {
      active_handles: m.get("nodejs_active_handles_total") ?? null,
      active_requests: m.get("nodejs_active_requests_total") ?? null,
      event_loop_lag_seconds: m.get("nodejs_eventloop_lag_seconds") ?? null,
    };
  } else if (runtime === "jvm") {
    result.threads = {
      live: m.get("jvm_threads_live_threads") ?? null,
      peak: m.get("jvm_threads_peak_threads") ?? null,
    };
    result.gc = {
      pause_seconds_total: m.get("jvm_gc_pause_seconds_sum") ?? null,
      pause_count: m.get("jvm_gc_pause_seconds_count") ?? null,
    };
  }

  // DB connection pool — multiple ORMs/pools
  const dbActive =
    m.get("db_pool_active_connections") ??
    m.get("sqlalchemy_pool_checked_out") ??
    m.get("hikaricp_connections_active") ??
    m.get("pgpool_active_connections");
  const dbIdle =
    m.get("db_pool_idle_connections") ??
    m.get("sqlalchemy_pool_checked_in") ??
    m.get("hikaricp_connections_idle");
  const dbMax =
    m.get("db_pool_max_connections") ??
    m.get("sqlalchemy_pool_size") ??
    m.get("hikaricp_connections_max");

  if (dbActive !== undefined || dbIdle !== undefined) {
    result.db_pool = {
      active_connections: dbActive ?? null,
      idle_connections: dbIdle ?? null,
      max_pool_size: dbMax ?? null,
      pool_usage_percent: dbActive !== undefined && dbMax ? Math.round((dbActive / dbMax) * 100) : null,
    };
  }

  // HTTP metrics from Prometheus
  const httpTotal =
    m.get("http_requests_total") ??
    m.get("http_request_duration_seconds_count") ??
    m.get("starlette_requests_total") ??
    m.get("flask_http_request_total") ??
    m.get("django_http_requests_total_by_method_total");

  if (httpTotal !== undefined) {
    result.http = {
      total_requests: httpTotal,
      duration_seconds_sum:
        m.get("http_request_duration_seconds_sum") ??
        m.get("starlette_request_duration_seconds_sum") ??
        m.get("flask_http_request_duration_seconds_sum") ??
        null,
    };
  }

  // Open file descriptors (universal)
  const openFds = m.get("process_open_fds");
  const maxFds = m.get("process_max_fds");
  if (openFds !== undefined) {
    result.file_descriptors = {
      open: openFds,
      max: maxFds ?? null,
    };
  }

  return result;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "check_health",
      description:
        "Check the health status of any API service. Auto-detects the health endpoint " +
        "by trying /health, /healthz, /actuator/health, /api/health, /_health. " +
        "Works with Spring Boot, FastAPI, Flask, Django, Express, Go — any framework.",
      inputSchema: {
        type: "object" as const,
        properties: {
          base_url: {
            type: "string",
            description: "Base URL of the service (e.g., 'http://localhost:8081')",
          },
        },
        required: ["base_url"],
      },
    },
    {
      name: "get_runtime_metrics",
      description:
        "Get runtime metrics from any service. Auto-detects the metrics source:\n" +
        "- Spring Boot: reads /actuator/metrics/* (JVM heap, threads, GC)\n" +
        "- Prometheus /metrics: parses Python (process memory, GC), Node.js (heap, event loop), " +
        "Go (goroutines, memstats), or JVM metrics\n" +
        "Returns normalized memory, CPU, concurrency, and GC data regardless of framework.",
      inputSchema: {
        type: "object" as const,
        properties: {
          base_url: {
            type: "string",
            description: "Base URL of the service",
          },
        },
        required: ["base_url"],
      },
    },
    {
      name: "get_http_metrics",
      description:
        "Get server-side HTTP request metrics. Works with:\n" +
        "- Spring Actuator (http.server.requests)\n" +
        "- Prometheus (http_requests_total, starlette_requests_total, flask_http_request_total)\n" +
        "Returns request count and duration from the server's perspective.",
      inputSchema: {
        type: "object" as const,
        properties: {
          base_url: {
            type: "string",
            description: "Base URL of the service",
          },
        },
        required: ["base_url"],
      },
    },
    {
      name: "get_db_pool_metrics",
      description:
        "Get database connection pool metrics. Supports:\n" +
        "- Spring/HikariCP (via Actuator)\n" +
        "- SQLAlchemy pool (via Prometheus)\n" +
        "- Generic db_pool_* Prometheus metrics\n" +
        "Returns active/idle connections, max pool size, and usage percentage.",
      inputSchema: {
        type: "object" as const,
        properties: {
          base_url: {
            type: "string",
            description: "Base URL of the service",
          },
        },
        required: ["base_url"],
      },
    },
    {
      name: "snapshot_metrics",
      description:
        "Take a point-in-time snapshot of ALL available metrics and save to a file. " +
        "Auto-detects Spring Actuator or Prometheus format. Use before and after load tests " +
        "to measure the delta. Works with any framework that exposes health or /metrics.",
      inputSchema: {
        type: "object" as const,
        properties: {
          base_url: {
            type: "string",
            description: "Base URL of the service",
          },
          label: {
            type: "string",
            description: "Label for this snapshot (e.g., 'pre-test', 'post-10x')",
          },
          service_name: {
            type: "string",
            description: "Name of the service for file naming",
          },
        },
        required: ["base_url", "label", "service_name"],
      },
    },
  ],
}));

// ─── Tool Implementations ────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "check_health": {
      const baseUrl = args?.base_url as string;
      const result = await checkHealthMultiPath(baseUrl);

      if (result.status === "UNREACHABLE") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "UNREACHABLE",
                tried_paths: HEALTH_PATHS,
                hint: "Service may be down, or expose health on a custom path. " +
                      "Common setups: FastAPI → /health, Spring → /actuator/health, K8s → /healthz",
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "get_runtime_metrics": {
      const baseUrl = args?.base_url as string;
      const source = await detectMetricsSource(baseUrl);

      if (source === "spring_actuator") {
        const metrics = await getSpringRuntimeMetrics(baseUrl);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ source: "spring_actuator", ...metrics }, null, 2),
            },
          ],
        };
      }

      if (source === "prometheus") {
        const metrics = await getPrometheusRuntimeMetrics(baseUrl);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ source: "prometheus", ...metrics }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              source: "none",
              error: "No metrics endpoint detected",
              hint: "Service needs one of: /actuator/metrics (Spring), /metrics (Prometheus). " +
                    "Python: pip install prometheus-fastapi-instrumentator or prometheus-flask-exporter. " +
                    "Node.js: npm install prom-client. Go: import promhttp.",
            }),
          },
        ],
        isError: true,
      };
    }

    case "get_http_metrics": {
      const baseUrl = args?.base_url as string;
      const source = await detectMetricsSource(baseUrl);

      if (source === "spring_actuator") {
        const metrics = await getSpringHttpMetrics(baseUrl);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ source: "spring_actuator", ...metrics }, null, 2),
            },
          ],
        };
      }

      if (source === "prometheus") {
        const allMetrics = await getPrometheusRuntimeMetrics(baseUrl);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { source: "prometheus", ...(allMetrics.http || { available: false }) },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No HTTP metrics endpoint found" }),
          },
        ],
        isError: true,
      };
    }

    case "get_db_pool_metrics": {
      const baseUrl = args?.base_url as string;
      const source = await detectMetricsSource(baseUrl);

      if (source === "spring_actuator") {
        const metrics = await getSpringDbMetrics(baseUrl);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ source: "spring_actuator", ...metrics }, null, 2),
            },
          ],
        };
      }

      if (source === "prometheus") {
        const allMetrics = await getPrometheusRuntimeMetrics(baseUrl);
        if (allMetrics.db_pool) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ source: "prometheus", ...allMetrics.db_pool }, null, 2),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                source: "prometheus",
                error: "No DB pool metrics found in /metrics output",
                hint: "For SQLAlchemy: pip install prometheus-client, then expose pool metrics. " +
                      "Metrics should match: sqlalchemy_pool_*, db_pool_*, or hikaricp_*",
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No metrics endpoint found" }),
          },
        ],
        isError: true,
      };
    }

    case "snapshot_metrics": {
      const baseUrl = args?.base_url as string;
      const label = args?.label as string;
      const serviceName = args?.service_name as string;

      try {
        const source = await detectMetricsSource(baseUrl);
        const health = await checkHealthMultiPath(baseUrl);

        let runtimeMetrics: Record<string, any>;
        let dbMetrics: Record<string, any> | null = null;
        let httpMetrics: Record<string, any> | null = null;

        if (source === "spring_actuator") {
          runtimeMetrics = await getSpringRuntimeMetrics(baseUrl);
          dbMetrics = await getSpringDbMetrics(baseUrl);
          httpMetrics = await getSpringHttpMetrics(baseUrl);
        } else if (source === "prometheus") {
          const allMetrics = await getPrometheusRuntimeMetrics(baseUrl);
          runtimeMetrics = allMetrics;
          dbMetrics = allMetrics.db_pool || null;
          httpMetrics = allMetrics.http || null;
        } else {
          runtimeMetrics = { error: "No metrics source detected" };
        }

        const snapshot = {
          timestamp: new Date().toISOString(),
          service: serviceName,
          label,
          metrics_source: source,
          health: health.status,
          health_path: health.path,
          runtime: runtimeMetrics,
          db_pool: dbMetrics,
          http: httpMetrics,
        };

        const filename = `${serviceName}-${label}-${Date.now()}.json`;
        const filepath = resolve(SNAPSHOTS_DIR, filename);
        writeFileSync(filepath, JSON.stringify(snapshot, null, 2), "utf-8");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ snapshot, saved_to: filepath }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `Snapshot failed: ${error.message}` }),
            },
          ],
          isError: true,
        };
      }
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("App Metrics MCP Server running on stdio (framework-agnostic)");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
