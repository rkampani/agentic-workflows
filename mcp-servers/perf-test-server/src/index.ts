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

// Global safety limits (used as defaults; per-service limits can be lower)
const DEFAULT_MAX_USERS = 500;
const DEFAULT_MAX_DURATION_SECONDS = 600;

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
            description: `Target number of concurrent virtual users (capped by max_concurrent_users)`,
          },
          duration_seconds: {
            type: "number",
            description: `Test duration in seconds (capped by max_duration_seconds)`,
          },
          max_concurrent_users: {
            type: "number",
            description: `Per-service safety cap for virtual users (from service config, default: ${DEFAULT_MAX_USERS})`,
          },
          max_duration_seconds: {
            type: "number",
            description: `Per-service safety cap for duration (from service config, default: ${DEFAULT_MAX_DURATION_SECONDS})`,
          },
          ramp_up_seconds: {
            type: "number",
            description: "Ramp-up time in seconds (default: 10% of duration)",
          },
          thresholds: {
            type: "object",
            description: "Optional k6 thresholds (e.g., {\"http_req_duration\": [\"p(95)<500\"]})",
          },
          test_data_file: {
            type: "string",
            description: "Path to JSON test data file (relative to project root). Array of objects with path param values (entityType, entityId...) and body_<name> fields. Each VU gets a different row round-robin.",
          },
          token_file: {
            type: "string",
            description: "Path to JSON token file (relative to project root). Nested object keyed by service name then environment: {\"payment-service\": {\"local\": \"Bearer eyJ...\", \"dev\": \"Bearer eyJ...\"}}. Token is selected by service_name + environment — one token per env, shared across all VUs.",
          },
          service_name: {
            type: "string",
            description: "Service name — used to look up the correct token in token_file (e.g. 'payment-service'). Required when token_file is provided.",
          },
          environment: {
            type: "string",
            description: "Environment name — used to look up the correct token in token_file (e.g. 'local', 'dev', 'staging'). Required when token_file is provided.",
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
  testDataFile?: string;
  tokenFile?: string;
  serviceName?: string;
  environment?: string;
  maxConcurrentUsers?: number;
  maxDurationSeconds?: number;
}): string {
  const {
    testName,
    baseUrl,
    endpoints,
    virtualUsers,
    durationSeconds,
    rampUpSeconds,
    thresholds,
    testDataFile,
    tokenFile,
    serviceName = '',
    environment = '',
    maxConcurrentUsers = DEFAULT_MAX_USERS,
    maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS,
  } = params;

  const safeUsers = Math.min(virtualUsers, maxConcurrentUsers);
  const safeDuration = Math.min(durationSeconds, maxDurationSeconds);
  const rampUp = rampUpSeconds ?? Math.max(5, Math.floor(safeDuration * 0.1));
  const steadyState = safeDuration - rampUp * 2;

  const defaultThresholds = {
    http_req_duration: ["p(95)<2000", "p(99)<5000"],
    http_req_failed: ["rate<0.1"],
    ...thresholds,
  };

  const hasTestData = !!testDataFile;
  const hasTokenFile = !!tokenFile;

  // Generate endpoint calls — with or without test data
  const endpointCalls = endpoints
    .map((ep) => {
      const method = ep.method.toLowerCase();

      // With test data: resolve {placeholders} from data row at runtime
      // Without test data: use path as-is
      const pathExpr = hasTestData
        ? `resolvePath('${ep.path}', row)`
        : `'${ep.path}'`;

      const headersExpr = (hasTestData || hasTokenFile) ? "headers" : `{ 'Content-Type': 'application/json' }`;

      if (method === "get" || method === "delete") {
        return `
    // ${ep.method} ${ep.path}
    {
      const url = \`\${BASE_URL}\${${pathExpr}}\`;
      const res = http.${method}(url, { headers: ${headersExpr}, tags: { endpoint: '${ep.method} ${ep.path}' } });
      check(res, {
        '${ep.method} ${ep.path} status 2xx': (r) => r.status >= 200 && r.status < 300,
      });
      sleep(Math.random() * 1 + 0.5);
    }`;
      } else {
        // For POST/PUT — look for body_<last_segment> in test data, or use provided body
        const pathSegments = ep.path.split('/').filter(Boolean);
        const lastSegment = pathSegments[pathSegments.length - 1]?.replace(/[{}]/g, '') || 'default';
        const bodyExpr = hasTestData
          ? `JSON.stringify(row['body_${lastSegment}'] || ${ep.body || '{}'})`
          : `JSON.stringify(${ep.body || '{}'})`;

        return `
    // ${ep.method} ${ep.path}
    {
      const url = \`\${BASE_URL}\${${pathExpr}}\`;
      const payload = ${bodyExpr};
      const res = http.${method}(url, payload, { headers: ${headersExpr}, tags: { endpoint: '${ep.method} ${ep.path}' } });
      check(res, {
        '${ep.method} ${ep.path} status 2xx': (r) => r.status >= 200 && r.status < 300,
      });
      sleep(Math.random() * 1 + 0.5);
    }`;
      }
    })
    .join("\n");

  // Resolve absolute paths — forward slashes for safe JS string embedding on Windows
  const testDataAbsPath = hasTestData ? resolve(PROJECT_ROOT, testDataFile!).replace(/\\/g, '/') : '';
  const tokenAbsPath   = hasTokenFile ? resolve(PROJECT_ROOT, tokenFile!).replace(/\\/g, '/') : '';

  // SharedArray import — only needed for test data (token is a plain module-level constant)
  const sharedArrayImport = hasTestData ? `import { SharedArray } from 'k6/data';` : '';

  const testDataBlock = hasTestData ? `
// Test data: path params + request bodies — each VU gets a different row (round-robin)
const testData = new SharedArray('test-data', function () {
  return JSON.parse(open('${testDataAbsPath}'));
});

// Resolve {placeholders} in paths using data row values
function resolvePath(path, row) {
  return path.replace(/\\{(\\w+)\\}/g, (match, key) => row[key] !== undefined ? row[key] : match);
}
` : '';

  // Token is a single value per service+environment — loaded at init time, shared across all VUs
  const tokenBlock = hasTokenFile ? `
// Token: loaded from ${tokenFile} — keyed by service '${serviceName}' and environment '${environment}'
const _tokenData = JSON.parse(open('${tokenAbsPath}'));
const token = ((_tokenData['${serviceName}'] || {})['${environment}']) || null;
` : '';

  // VU setup: row from test data (per-VU round-robin) + headers
  // If only token_file (no test data), token is already a module-level constant
  const vuDataSetup = (hasTestData || hasTokenFile) ? `
    ${hasTestData ? `const row = testData[__VU % testData.length];` : ''}
    ${hasTestData && !hasTokenFile ? `const token = row.token;` : ''}
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': token } : {}),
    };
` : '';

  return `// Auto-generated k6 test: ${testName}
// Generated at: ${new Date().toISOString()}
// Target: ${baseUrl}
// Endpoints: ${endpoints.length}
// Max VUs: ${safeUsers}, Duration: ${safeDuration}s
${hasTestData  ? `// Test data:  ${testDataFile} (path params + request bodies, round-robin per VU)` : '// No test data file — using static paths'}
${hasTokenFile ? `// Token file: ${tokenFile} (Bearer tokens, round-robin per VU independently)` : '// No token file — token sourced from test data row or omitted'}

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
${sharedArrayImport}
${testDataBlock}${tokenBlock}
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
${vuDataSetup}
${endpointCalls}
}

export function handleSummary(data) {
  const resultPath = '${resolve(RESULTS_DIR, testName + "-results.json").replace(/\\/g, "/")}';
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
      const testDataFile = args?.test_data_file as string | undefined;
      const tokenFile = args?.token_file as string | undefined;
      const serviceName = args?.service_name as string | undefined;
      const environment = args?.environment as string | undefined;
      const maxConcurrentUsers = (args?.max_concurrent_users as number) || DEFAULT_MAX_USERS;
      const maxDurationSeconds = (args?.max_duration_seconds as number) || DEFAULT_MAX_DURATION_SECONDS;

      // Safety validation — use per-service limits (or global defaults)
      if (virtualUsers > maxConcurrentUsers) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Virtual users (${virtualUsers}) exceeds service limit (${maxConcurrentUsers}). Capping at ${maxConcurrentUsers}.`,
              }),
            },
          ],
          isError: true,
        };
      }

      if (durationSeconds > maxDurationSeconds) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Duration (${durationSeconds}s) exceeds service limit (${maxDurationSeconds}s).`,
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
        testDataFile,
        tokenFile,
        serviceName,
        environment,
        maxConcurrentUsers,
        maxDurationSeconds,
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
                  virtual_users: Math.min(virtualUsers, maxConcurrentUsers),
                  duration_seconds: Math.min(durationSeconds, maxDurationSeconds),
                  max_concurrent_users: maxConcurrentUsers,
                  max_duration_seconds: maxDurationSeconds,
                  ...(testDataFile && { test_data_file: testDataFile }),
                  ...(tokenFile && { token_file: tokenFile }),
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

          // Log k6 output for debugging
          if (stderr) {
            console.error(`[k6 stderr] exit=${code}\n${stderr.slice(0, 2000)}`);
          }
          if (stdout) {
            console.error(`[k6 stdout] ${stdout.slice(0, 500)}`);
          }

          let aggregateStats: Record<string, any>;
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

          resolvePromise({
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: code === 0 ? "completed" : (code === null ? "crashed" : "completed_with_threshold_failures"),
                    exit_code: code,
                    test_script: scriptName,
                    results_file: resultsPath,
                    aggregate_stats: aggregateStats,
                    ...(code !== 0 && stderr ? { k6_stderr_preview: stderr.slice(0, 1000) } : {}),
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
