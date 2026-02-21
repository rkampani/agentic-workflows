#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../..");
const RESULTS_DIR = resolve(PROJECT_ROOT, "results");
const BASELINES_DIR = resolve(PROJECT_ROOT, "baselines");
const REPORTS_DIR = resolve(PROJECT_ROOT, "results", "reports");

for (const dir of [RESULTS_DIR, BASELINES_DIR, REPORTS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const server = new Server(
  { name: "results-analyzer", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// --- Helper Functions ---

function loadK6Results(filePath: string): any {
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function extractAggregateStats(data: any): Record<string, any> {
  const metrics = data.metrics || {};
  const duration = metrics.http_req_duration?.values || {};
  const failed = metrics.http_req_failed?.values || {};
  const reqs = metrics.http_reqs?.values || {};

  return {
    http_req_duration: {
      avg_ms: round(duration.avg),
      min_ms: round(duration.min),
      max_ms: round(duration.max),
      p50_ms: round(duration.med),
      p90_ms: round(duration["p(90)"]),
      p95_ms: round(duration["p(95)"]),
      p99_ms: round(duration["p(99)"]),
    },
    error_rate_percent: round((failed.rate || 0) * 100),
    total_requests: reqs.count || 0,
    requests_per_second: round(reqs.rate),
    total_errors: round((failed.rate || 0) * (reqs.count || 0)),
  };
}

function round(n: number | undefined | null, decimals = 2): number | null {
  if (n === undefined || n === null || isNaN(n)) return null;
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

function computeDelta(current: number | null, baseline: number | null): {
  absolute: number | null;
  percent: number | null;
  direction: string;
} {
  if (current === null || baseline === null) {
    return { absolute: null, percent: null, direction: "unknown" };
  }
  const abs = round(current - baseline);
  const pct = baseline !== 0 ? round(((current - baseline) / baseline) * 100) : null;
  const dir = abs === null ? "unknown" : abs > 0 ? "increased" : abs < 0 ? "decreased" : "unchanged";
  return { absolute: abs, percent: pct, direction: dir };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "analyze_results",
      description:
        "Analyze a k6 test results JSON file and return structured aggregate statistics. " +
        "Provides p50/p90/p95/p99 latencies, throughput, error rates, and a performance grade. " +
        "Only returns aggregate stats — no raw request/response data.",
      inputSchema: {
        type: "object" as const,
        properties: {
          results_file: {
            type: "string",
            description: "Path to k6 results JSON file (absolute or relative to results/)",
          },
        },
        required: ["results_file"],
      },
    },
    {
      name: "compare_baseline",
      description:
        "Compare current test results against a saved baseline. " +
        "Returns percentage changes for all key metrics (latency, throughput, error rate). " +
        "Flags regressions (>10% slower) and improvements (>10% faster).",
      inputSchema: {
        type: "object" as const,
        properties: {
          current_results_file: {
            type: "string",
            description: "Path to current test results JSON",
          },
          baseline_name: {
            type: "string",
            description: "Name of the saved baseline to compare against",
          },
        },
        required: ["current_results_file", "baseline_name"],
      },
    },
    {
      name: "save_baseline",
      description:
        "Save current test results as a named baseline for future comparison. " +
        "Baselines persist across sessions and enable trend tracking over time.",
      inputSchema: {
        type: "object" as const,
        properties: {
          results_file: {
            type: "string",
            description: "Path to k6 results JSON file to save as baseline",
          },
          baseline_name: {
            type: "string",
            description: "Name for this baseline (e.g., 'order-service-v2.3', 'sprint-42')",
          },
          metadata: {
            type: "object",
            description: "Optional metadata (service, environment, git commit, notes)",
          },
        },
        required: ["results_file", "baseline_name"],
      },
    },
    {
      name: "generate_report",
      description:
        "Generate a comprehensive Markdown performance report including test configuration, " +
        "latency distribution, throughput analysis, error analysis, baseline comparison, " +
        "and recommendations. Suitable for PR comments or team sharing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          results_file: {
            type: "string",
            description: "Path to k6 results JSON file",
          },
          baseline_name: {
            type: "string",
            description: "Optional: baseline to compare against in the report",
          },
          service_name: {
            type: "string",
            description: "Name of the service tested",
          },
          environment: {
            type: "string",
            description: "Environment tested (e.g., 'staging')",
          },
          test_description: {
            type: "string",
            description: "Description of what was tested and why",
          },
          metrics_snapshots: {
            type: "array",
            items: { type: "string" },
            description: "Optional: paths to metrics snapshot files to include in report",
          },
        },
        required: ["results_file", "service_name"],
      },
    },
  ],
}));

function resolveResultsPath(filePath: string): string {
  if (existsSync(filePath)) return filePath;
  const inResults = resolve(RESULTS_DIR, filePath);
  if (existsSync(inResults)) return inResults;
  // Try adding -results.json suffix
  const withSuffix = resolve(RESULTS_DIR, `${filePath}-results.json`);
  if (existsSync(withSuffix)) return withSuffix;
  throw new Error(`Results file not found: ${filePath}`);
}

function gradePerformance(stats: Record<string, any>): { grade: string; notes: string[] } {
  const notes: string[] = [];
  let score = 100;

  const p95 = stats.http_req_duration?.p95_ms;
  const p99 = stats.http_req_duration?.p99_ms;
  const errorRate = stats.error_rate_percent;

  if (p95 !== null) {
    if (p95 > 2000) { score -= 30; notes.push(`p95 latency is very high (${p95}ms)`); }
    else if (p95 > 1000) { score -= 15; notes.push(`p95 latency is elevated (${p95}ms)`); }
    else if (p95 > 500) { score -= 5; notes.push(`p95 latency is moderate (${p95}ms)`); }
  }

  if (p99 !== null && p95 !== null) {
    const tailRatio = p99 / p95;
    if (tailRatio > 3) { score -= 15; notes.push(`High tail latency ratio (p99/p95 = ${round(tailRatio)}x)`); }
    else if (tailRatio > 2) { score -= 5; notes.push(`Moderate tail latency (p99/p95 = ${round(tailRatio)}x)`); }
  }

  if (errorRate !== null) {
    if (errorRate > 5) { score -= 30; notes.push(`Error rate is critical (${errorRate}%)`); }
    else if (errorRate > 1) { score -= 15; notes.push(`Error rate is elevated (${errorRate}%)`); }
    else if (errorRate > 0.1) { score -= 5; notes.push(`Minor error rate (${errorRate}%)`); }
  }

  score = Math.max(0, score);
  let grade: string;
  if (score >= 90) grade = "A";
  else if (score >= 80) grade = "B";
  else if (score >= 70) grade = "C";
  else if (score >= 50) grade = "D";
  else grade = "F";

  return { grade, notes };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "analyze_results": {
      try {
        const filePath = resolveResultsPath(args?.results_file as string);
        const data = loadK6Results(filePath);
        const stats = extractAggregateStats(data);
        const { grade, notes } = gradePerformance(stats);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  file: filePath,
                  aggregate_stats: stats,
                  performance_grade: grade,
                  notes,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: error.message }) }],
          isError: true,
        };
      }
    }

    case "compare_baseline": {
      try {
        const currentPath = resolveResultsPath(args?.current_results_file as string);
        const baselineName = args?.baseline_name as string;
        const baselinePath = resolve(BASELINES_DIR, `${baselineName}.json`);

        if (!existsSync(baselinePath)) {
          const available = readdirSync(BASELINES_DIR)
            .filter((f) => f.endsWith(".json"))
            .map((f) => f.replace(".json", ""));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Baseline '${baselineName}' not found`,
                  available_baselines: available,
                }),
              },
            ],
            isError: true,
          };
        }

        const currentData = loadK6Results(currentPath);
        const baselineRaw = JSON.parse(readFileSync(baselinePath, "utf-8"));
        const baselineData = baselineRaw.results_data || baselineRaw;

        const currentStats = extractAggregateStats(currentData);
        const baselineStats = extractAggregateStats(baselineData);

        const comparison: Record<string, any> = {};
        const regressions: string[] = [];
        const improvements: string[] = [];

        // Compare latencies
        for (const metric of ["avg_ms", "p50_ms", "p90_ms", "p95_ms", "p99_ms"] as const) {
          const delta = computeDelta(
            currentStats.http_req_duration[metric],
            baselineStats.http_req_duration[metric]
          );
          comparison[`latency_${metric}`] = {
            current: currentStats.http_req_duration[metric],
            baseline: baselineStats.http_req_duration[metric],
            ...delta,
          };
          if (delta.percent !== null && delta.percent > 10) {
            regressions.push(`${metric} increased ${delta.percent}%`);
          } else if (delta.percent !== null && delta.percent < -10) {
            improvements.push(`${metric} decreased ${Math.abs(delta.percent)}%`);
          }
        }

        // Compare throughput
        const throughputDelta = computeDelta(
          currentStats.requests_per_second,
          baselineStats.requests_per_second
        );
        comparison.throughput = {
          current: currentStats.requests_per_second,
          baseline: baselineStats.requests_per_second,
          ...throughputDelta,
        };
        if (throughputDelta.percent !== null && throughputDelta.percent < -10) {
          regressions.push(`Throughput decreased ${Math.abs(throughputDelta.percent)}%`);
        }

        // Compare error rate
        const errorDelta = computeDelta(
          currentStats.error_rate_percent,
          baselineStats.error_rate_percent
        );
        comparison.error_rate = {
          current: currentStats.error_rate_percent,
          baseline: baselineStats.error_rate_percent,
          ...errorDelta,
        };
        if (currentStats.error_rate_percent > 1 && baselineStats.error_rate_percent <= 1) {
          regressions.push(`Error rate crossed 1% threshold`);
        }

        const hasRegression = regressions.length > 0;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  baseline_name: baselineName,
                  baseline_metadata: baselineRaw.metadata || {},
                  comparison,
                  regressions,
                  improvements,
                  verdict: hasRegression ? "REGRESSION_DETECTED" : "PASS",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: error.message }) }],
          isError: true,
        };
      }
    }

    case "save_baseline": {
      try {
        const filePath = resolveResultsPath(args?.results_file as string);
        const baselineName = args?.baseline_name as string;
        const metadata = (args?.metadata as Record<string, any>) || {};

        const data = loadK6Results(filePath);
        const stats = extractAggregateStats(data);

        const baseline = {
          baseline_name: baselineName,
          saved_at: new Date().toISOString(),
          metadata,
          aggregate_stats: stats,
          results_data: data,
        };

        const baselinePath = resolve(BASELINES_DIR, `${baselineName}.json`);
        writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), "utf-8");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "baseline_saved",
                  baseline_name: baselineName,
                  saved_to: baselinePath,
                  aggregate_stats: stats,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: error.message }) }],
          isError: true,
        };
      }
    }

    case "generate_report": {
      try {
        const filePath = resolveResultsPath(args?.results_file as string);
        const baselineName = args?.baseline_name as string | undefined;
        const serviceName = args?.service_name as string;
        const environment = (args?.environment as string) || "unknown";
        const testDescription = (args?.test_description as string) || "";
        const snapshotPaths = (args?.metrics_snapshots as string[]) || [];

        const data = loadK6Results(filePath);
        const stats = extractAggregateStats(data);
        const { grade, notes } = gradePerformance(stats);

        let report = `# Performance Test Report: ${serviceName}\n\n`;
        report += `**Environment:** ${environment}  \n`;
        report += `**Date:** ${new Date().toISOString()}  \n`;
        report += `**Grade:** ${grade}  \n`;
        if (testDescription) report += `**Description:** ${testDescription}  \n`;
        report += `\n---\n\n`;

        // Latency section
        report += `## Latency Distribution\n\n`;
        report += `| Metric | Value |\n|--------|-------|\n`;
        report += `| Average | ${stats.http_req_duration.avg_ms}ms |\n`;
        report += `| p50 (Median) | ${stats.http_req_duration.p50_ms}ms |\n`;
        report += `| p90 | ${stats.http_req_duration.p90_ms}ms |\n`;
        report += `| p95 | ${stats.http_req_duration.p95_ms}ms |\n`;
        report += `| p99 | ${stats.http_req_duration.p99_ms}ms |\n`;
        report += `| Max | ${stats.http_req_duration.max_ms}ms |\n\n`;

        // Throughput section
        report += `## Throughput & Errors\n\n`;
        report += `| Metric | Value |\n|--------|-------|\n`;
        report += `| Total Requests | ${stats.total_requests} |\n`;
        report += `| Requests/sec | ${stats.requests_per_second} |\n`;
        report += `| Error Rate | ${stats.error_rate_percent}% |\n`;
        report += `| Total Errors | ${stats.total_errors} |\n\n`;

        // Baseline comparison
        if (baselineName) {
          const baselinePath = resolve(BASELINES_DIR, `${baselineName}.json`);
          if (existsSync(baselinePath)) {
            const baselineRaw = JSON.parse(readFileSync(baselinePath, "utf-8"));
            const baselineStats = baselineRaw.aggregate_stats || extractAggregateStats(baselineRaw.results_data || baselineRaw);

            report += `## Baseline Comparison (vs. ${baselineName})\n\n`;
            report += `| Metric | Current | Baseline | Change |\n|--------|---------|----------|--------|\n`;

            for (const m of ["avg_ms", "p50_ms", "p95_ms", "p99_ms"] as const) {
              const delta = computeDelta(
                stats.http_req_duration[m],
                baselineStats.http_req_duration?.[m]
              );
              const arrow = delta.percent !== null ? (delta.percent > 0 ? "⬆" : delta.percent < 0 ? "⬇" : "─") : "?";
              report += `| ${m} | ${stats.http_req_duration[m]}ms | ${baselineStats.http_req_duration?.[m]}ms | ${arrow} ${delta.percent ?? "?"}% |\n`;
            }

            const tpDelta = computeDelta(stats.requests_per_second, baselineStats.requests_per_second);
            report += `| req/s | ${stats.requests_per_second} | ${baselineStats.requests_per_second} | ${tpDelta.percent ?? "?"}% |\n`;
            report += `\n`;
          }
        }

        // Metrics snapshots
        if (snapshotPaths.length > 0) {
          report += `## Server-Side Metrics\n\n`;
          for (const sp of snapshotPaths) {
            try {
              const snap = JSON.parse(readFileSync(sp, "utf-8"));
              report += `### ${snap.label || "Snapshot"} (${snap.timestamp})\n\n`;
              if (snap.jvm) {
                report += `| JVM Metric | Value |\n|------------|-------|\n`;
                report += `| Heap Used | ${snap.jvm.heap_used_mb}MB |\n`;
                report += `| Heap Max | ${snap.jvm.heap_max_mb}MB |\n`;
                report += `| Threads | ${snap.jvm.threads_live} |\n`;
                report += `| GC Pauses | ${snap.jvm.gc_pause_count} (${snap.jvm.gc_total_pause_ms}ms total) |\n`;
                report += `| CPU | ${snap.jvm.cpu_usage_percent}% |\n\n`;
              }
              if (snap.datasource) {
                report += `| DB Pool | Value |\n|---------|-------|\n`;
                report += `| Active | ${snap.datasource.active_connections} |\n`;
                report += `| Idle | ${snap.datasource.idle_connections} |\n`;
                report += `| Max | ${snap.datasource.max_pool_size} |\n\n`;
              }
            } catch {
              report += `*Could not load snapshot: ${sp}*\n\n`;
            }
          }
        }

        // Notes
        if (notes.length > 0) {
          report += `## Performance Notes\n\n`;
          for (const note of notes) {
            report += `- ${note}\n`;
          }
          report += `\n`;
        }

        report += `---\n*Generated by Agentic Performance Testing Platform*\n`;

        // Save report
        const reportPath = resolve(REPORTS_DIR, `${serviceName}-${Date.now()}.md`);
        writeFileSync(reportPath, report, "utf-8");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  report_markdown: report,
                  saved_to: reportPath,
                  grade,
                  notes,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: error.message }) }],
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Results Analyzer MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
