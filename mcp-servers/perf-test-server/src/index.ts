#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../..");
const SCRIPTS_DIR = resolve(PROJECT_ROOT, "test-scripts");
const RESULTS_DIR = resolve(PROJECT_ROOT, "results");

// Ensure directories exist
for (const dir of [SCRIPTS_DIR, RESULTS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Safety limits
const MAX_USERS = 500;
const MAX_DURATION_SECONDS = 600;

const server = new Server(
  { name: "perf-test-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_k6_script",
      description:
        "Generate a k6 load test JavaScript file for given endpoints. " +
        "Creates a .js file in test-scripts/ ready to run. " +
        "Supports configuring virtual users, duration, and which endpoints to test. " +
        "The script uses k6's ramping-vus executor for realistic load patterns.",
      inputSchema: {
        type: "object" as const,
        properties: {
          test_name: {
            type: "string",
            description: "Name for the test (used as filename, e.g., 'order-service-baseline')",
          },
          base_url: {
            type: "string",
            description: "Base URL of the service (e.g., 'http://localhost:8081')",
          },
          endpoints: {
            type: "array",
            items: {
              type: "object",
              properties: {
                method: { type: "string", description: "HTTP method (GET, POST, PUT, DELETE)" },
                path: { type: "string", description: "Endpoint path (e.g., '/api/orders')" },
                body: { type: "string", description: "Optional JSON body for POST/PUT requests" },
                headers: {
                  type: "object",
                  description: "Optional extra headers",
                },
              },
              required: ["method", "path"],
            },
            description: "List of endpoints to test",
          },
          virtual_users: {
            type: "number",
            description: `Target number of concurrent virtual users (max: ${MAX_USERS})`,
          },
          duration_seconds: {
            type: "number",
            description: `Test duration in seconds (max: ${MAX_DURATION_SECONDS})`,
          },
          ramp_up_seconds: {
            type: "number",
            description: "Ramp-up time in seconds (default: 10% of duration)",
          },
          thresholds: {
            type: "object",
            description: "Optional k6 thresholds (e.g., {\"http_req_duration\": [\"p(95)<500\"]})",
          },
        },
        required: ["test_name", "base_url", "endpoints", "virtual_users", "duration_seconds"],
      },
    },
    {
      name: "run_k6_test",
      description:
        "Execute a k6 load test script and return AGGREGATE results only. " +
        "Raw response bodies and payloads are never returned — only statistical summaries " +
        "(p50, p95, p99, throughput, error rate, etc.). " +
        "Requires k6 to be installed (brew install k6).",
      inputSchema: {
        type: "object" as const,
        properties: {
          script_name: {
            type: "string",
            description: "Name of the test script file (e.g., 'order-service-baseline.js')",
          },
          environment_vars: {
            type: "object",
            description: "Optional environment variables to pass to k6 (e.g., {\"BASE_URL\": \"...\"})",
          },
        },
        required: ["script_name"],
      },
    },
    {
      name: "list_test_scripts",
      description: "List all saved k6 test scripts in the test-scripts/ directory.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

function generateK6Script(params: {
  testName: string;
  baseUrl: string;
  endpoints: Array<{ method: string; path: string; body?: string; headers?: Record<string, string> }>;
  virtualUsers: number;
  durationSeconds: number;
  rampUpSeconds?: number;
  thresholds?: Record<string, string[]>;
}): string {
  const {
    testName,
    baseUrl,
    endpoints,
    virtualUsers,
    durationSeconds,
    rampUpSeconds,
    thresholds,
  } = params;

  const safeUsers = Math.min(virtualUsers, MAX_USERS);
  const safeDuration = Math.min(durationSeconds, MAX_DURATION_SECONDS);
  const rampUp = rampUpSeconds ?? Math.max(5, Math.floor(safeDuration * 0.1));
  const steadyState = safeDuration - rampUp * 2;

  const defaultThresholds = {
    http_req_duration: ["p(95)<2000", "p(99)<5000"],
    http_req_failed: ["rate<0.1"],
    ...thresholds,
  };

  const endpointCalls = endpoints
    .map((ep, i) => {
      const method = ep.method.toLowerCase();
      const headers = JSON.stringify({
        "Content-Type": "application/json",
        ...ep.headers,
      });

      if (method === "get" || method === "delete") {
        return `
    // ${ep.method} ${ep.path}
    {
      const res = http.${method}(\`\${BASE_URL}${ep.path}\`, { headers: ${headers}, tags: { endpoint: '${ep.method} ${ep.path}' } });
      check(res, {
        '${ep.method} ${ep.path} status 2xx': (r) => r.status >= 200 && r.status < 300,
      });
      sleep(Math.random() * 1 + 0.5);
    }`;
      } else {
        const body = ep.body || '{}';
        return `
    // ${ep.method} ${ep.path}
    {
      const payload = JSON.stringify(${body});
      const res = http.${method}(\`\${BASE_URL}${ep.path}\`, payload, { headers: ${headers}, tags: { endpoint: '${ep.method} ${ep.path}' } });
      check(res, {
        '${ep.method} ${ep.path} status 2xx': (r) => r.status >= 200 && r.status < 300,
      });
      sleep(Math.random() * 1 + 0.5);
    }`;
      }
    })
    .join("\n");

  return `// Auto-generated k6 test: ${testName}
// Generated at: ${new Date().toISOString()}
// Target: ${baseUrl}
// Endpoints: ${endpoints.length}
// Max VUs: ${safeUsers}, Duration: ${safeDuration}s

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || '${baseUrl}';

const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    load_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '${rampUp}s', target: ${safeUsers} },
        { duration: '${steadyState}s', target: ${safeUsers} },
        { duration: '${rampUp}s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: ${JSON.stringify(defaultThresholds, null, 4)},
};

export default function () {
${endpointCalls}
}

export function handleSummary(data) {
  const resultPath = './results/${testName}-results.json';
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    [resultPath]: JSON.stringify(data, null, 2),
  };
}

function textSummary(data, opts) {
  // k6 built-in text summary
  return JSON.stringify({
    test_name: '${testName}',
    timestamp: new Date().toISOString(),
    metrics: {
      http_req_duration: data.metrics?.http_req_duration?.values || {},
      http_req_failed: data.metrics?.http_req_failed?.values || {},
      http_reqs: data.metrics?.http_reqs?.values || {},
      iterations: data.metrics?.iterations?.values || {},
      vus_max: data.metrics?.vus_max?.values || {},
      errors: data.metrics?.errors?.values || {},
    },
  }, null, 2);
}
`;
}

function parseK6Results(resultsPath: string): Record<string, any> {
  try {
    const raw = readFileSync(resultsPath, "utf-8");
    const data = JSON.parse(raw);

    // Extract only aggregate statistics — no raw payloads
    const metrics = data.metrics || {};
    return {
      http_req_duration: {
        avg: metrics.http_req_duration?.values?.avg,
        min: metrics.http_req_duration?.values?.min,
        max: metrics.http_req_duration?.values?.max,
        p50: metrics.http_req_duration?.values?.med,
        p90: metrics.http_req_duration?.values?.["p(90)"],
        p95: metrics.http_req_duration?.values?.["p(95)"],
        p99: metrics.http_req_duration?.values?.["p(99)"],
      },
      http_req_failed: metrics.http_req_failed?.values || {},
      total_requests: metrics.http_reqs?.values?.count,
      requests_per_second: metrics.http_reqs?.values?.rate,
      iterations: metrics.iterations?.values?.count,
      vus_max: metrics.vus_max?.values?.max,
      thresholds: data.root_group ? undefined : data.thresholds,
    };
  } catch {
    return { error: "Could not parse results file" };
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "generate_k6_script": {
      const testName = args?.test_name as string;
      const baseUrl = args?.base_url as string;
      const endpoints = args?.endpoints as Array<{
        method: string;
        path: string;
        body?: string;
        headers?: Record<string, string>;
      }>;
      const virtualUsers = args?.virtual_users as number;
      const durationSeconds = args?.duration_seconds as number;
      const rampUpSeconds = args?.ramp_up_seconds as number | undefined;
      const thresholds = args?.thresholds as Record<string, string[]> | undefined;

      // Safety validation
      if (virtualUsers > MAX_USERS) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Virtual users (${virtualUsers}) exceeds maximum (${MAX_USERS}). Capping at ${MAX_USERS}.`,
              }),
            },
          ],
          isError: true,
        };
      }

      if (durationSeconds > MAX_DURATION_SECONDS) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Duration (${durationSeconds}s) exceeds maximum (${MAX_DURATION_SECONDS}s).`,
              }),
            },
          ],
          isError: true,
        };
      }

      const script = generateK6Script({
        testName,
        baseUrl,
        endpoints,
        virtualUsers,
        durationSeconds,
        rampUpSeconds,
        thresholds,
      });

      const scriptPath = resolve(SCRIPTS_DIR, `${testName}.js`);
      writeFileSync(scriptPath, script, "utf-8");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "script_generated",
                script_name: `${testName}.js`,
                script_path: scriptPath,
                config: {
                  base_url: baseUrl,
                  endpoints_count: endpoints.length,
                  virtual_users: Math.min(virtualUsers, MAX_USERS),
                  duration_seconds: Math.min(durationSeconds, MAX_DURATION_SECONDS),
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "run_k6_test": {
      const scriptName = args?.script_name as string;
      const envVars = (args?.environment_vars as Record<string, string>) || {};

      const scriptPath = resolve(SCRIPTS_DIR, scriptName);
      if (!existsSync(scriptPath)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Script not found: ${scriptName}`,
                available: readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".js")),
              }),
            },
          ],
          isError: true,
        };
      }

      // Run k6
      return new Promise((resolvePromise) => {
        const env = { ...process.env, ...envVars };
        const k6 = spawn("k6", ["run", "--summary-trend-stats", "avg,min,med,max,p(90),p(95),p(99)", scriptPath], {
          env,
          cwd: PROJECT_ROOT,
        });

        let stdout = "";
        let stderr = "";

        k6.stdout.on("data", (data) => {
          stdout += data.toString();
        });

        k6.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        k6.on("close", (code) => {
          // Try to read the JSON results file
          const testName = scriptName.replace(".js", "");
          const resultsPath = resolve(RESULTS_DIR, `${testName}-results.json`);

          let aggregateStats: Record<string, any>;
          if (existsSync(resultsPath)) {
            aggregateStats = parseK6Results(resultsPath);
          } else {
            aggregateStats = { raw_summary: stdout.slice(0, 3000) };
          }

          resolvePromise({
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: code === 0 ? "completed" : "completed_with_threshold_failures",
                    exit_code: code,
                    test_script: scriptName,
                    results_file: resultsPath,
                    aggregate_stats: aggregateStats,
                    // GUARDRAIL: Only aggregate stats returned. Raw logs stay in results/ locally.
                  },
                  null,
                  2
                ),
              },
            ],
          });
        });

        k6.on("error", (err) => {
          resolvePromise({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Failed to spawn k6: ${err.message}`,
                  hint: "Make sure k6 is installed: brew install k6",
                }),
              },
            ],
            isError: true,
          });
        });
      });
    }

    case "list_test_scripts": {
      const scripts = existsSync(SCRIPTS_DIR)
        ? readdirSync(SCRIPTS_DIR)
            .filter((f) => f.endsWith(".js"))
            .map((f) => {
              const fullPath = resolve(SCRIPTS_DIR, f);
              const content = readFileSync(fullPath, "utf-8");
              const headerMatch = content.match(/\/\/ Auto-generated k6 test: (.+)/);
              const targetMatch = content.match(/\/\/ Target: (.+)/);
              const endpointsMatch = content.match(/\/\/ Endpoints: (\d+)/);
              return {
                filename: f,
                test_name: headerMatch?.[1] || f,
                target: targetMatch?.[1] || "unknown",
                endpoints: parseInt(endpointsMatch?.[1] || "0"),
              };
            })
        : [];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ scripts, total: scripts.length }, null, 2),
          },
        ],
      };
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
  console.error("Perf Test MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
