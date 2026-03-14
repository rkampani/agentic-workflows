import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { PROJECT_ROOT, RESULTS_DIR, SCRIPTS_DIR } from "../config/defaults.js";

export interface K6RunResult {
  status: string;
  exit_code: number | null;
  results_file: string;
  aggregate_stats: Record<string, unknown>;
  k6_stderr_preview?: string;
}

export function parseK6Results(resultsPath: string): Record<string, unknown> {
  try {
    const raw = readFileSync(resultsPath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;

    // Extract only aggregate statistics — no raw payloads
    const metrics = (data.metrics || {}) as Record<string, unknown>;
    const httpReqDuration = metrics.http_req_duration as
      | Record<string, unknown>
      | undefined;
    const httpReqFailed = metrics.http_req_failed as
      | Record<string, unknown>
      | undefined;
    const httpReqs = metrics.http_reqs as Record<string, unknown> | undefined;
    const iterations = metrics.iterations as Record<string, unknown> | undefined;
    const vusMax = metrics.vus_max as Record<string, unknown> | undefined;

    const durationValues = (httpReqDuration?.values || {}) as Record<
      string,
      unknown
    >;
    return {
      http_req_duration: {
        avg: durationValues.avg,
        min: durationValues.min,
        max: durationValues.max,
        p50: durationValues.med,
        p90: durationValues["p(90)"],
        p95: durationValues["p(95)"],
        p99: durationValues["p(99)"],
      },
      http_req_failed: httpReqFailed?.values || {},
      total_requests: (httpReqs?.values as Record<string, unknown>)?.count,
      requests_per_second: (httpReqs?.values as Record<string, unknown>)?.rate,
      iterations: (iterations?.values as Record<string, unknown>)?.count,
      vus_max: (vusMax?.values as Record<string, unknown>)?.max,
      thresholds: data.root_group ? undefined : data.thresholds,
    };
  } catch {
    return { error: "Could not parse results file" };
  }
}

export function runK6Test(
  scriptName: string,
  envVars: Record<string, string>
): Promise<K6RunResult> {
  const scriptPath = resolve(SCRIPTS_DIR, scriptName);

  return new Promise((resolvePromise, rejectPromise) => {
    const env = { ...process.env, ...envVars };
    const k6 = spawn(
      "k6",
      [
        "run",
        "--summary-trend-stats",
        "avg,min,med,max,p(90),p(95),p(99)",
        scriptPath,
      ],
      {
        env,
        cwd: PROJECT_ROOT,
      }
    );

    let stdout = "";
    let stderr = "";

    k6.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    k6.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    k6.on("close", (code: number | null) => {
      const testName = scriptName.replace(".js", "");
      const resultsPath = resolve(RESULTS_DIR, `${testName}-results.json`);

      // Log k6 output for debugging
      if (stderr) {
        console.error(`[k6 stderr] exit=${code}\n${stderr.slice(0, 2000)}`);
      }
      if (stdout) {
        console.error(`[k6 stdout] ${stdout.slice(0, 500)}`);
      }

      let aggregateStats: Record<string, unknown>;
      if (existsSync(resultsPath)) {
        aggregateStats = parseK6Results(resultsPath);
      } else {
        // No results file — k6 likely failed. Include stderr for diagnosis
        aggregateStats = {
          raw_summary: stdout.slice(0, 3000) || "(no stdout)",
          k6_errors: stderr.slice(0, 3000) || "(no stderr)",
          hint: "k6 did not produce a results file. Check k6_errors for details.",
        };
      }

      const status =
        code === 0
          ? "completed"
          : code === null
          ? "crashed"
          : "completed_with_threshold_failures";

      const result: K6RunResult = {
        status,
        exit_code: code,
        results_file: resultsPath,
        aggregate_stats: aggregateStats,
        ...(code !== 0 && stderr
          ? { k6_stderr_preview: stderr.slice(0, 1000) }
          : {}),
      };

      resolvePromise(result);
    });

    k6.on("error", (err: Error) => {
      rejectPromise(err);
    });
  });
}
