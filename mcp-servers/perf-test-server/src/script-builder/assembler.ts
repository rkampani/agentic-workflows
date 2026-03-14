import { resolve } from "path";
import { loadTestingDefaults, PROJECT_ROOT, RESULTS_DIR } from "../config/defaults.js";
import { buildBodyExpression } from "./body-resolver.js";
import { buildSetupBlock } from "./auth-block.js";
import { buildTestDataBlock, buildVuDataSetup } from "./data-block.js";

export interface ScriptParams {
  testName: string;
  baseUrl: string;
  endpoints: Array<{
    method: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
    requiredBodyFields?: string[];
    bodyAllFields?: string[];
    bodyFieldExamples?: Record<string, unknown>;
  }>;
  virtualUsers: number;
  durationSeconds: number;
  rampUpSeconds?: number;
  thresholds?: Record<string, string[]>;
  testDataFile?: string;
  authUrl?: string;
  authUsername?: string;
  authPassword?: string;
  authTokenField?: string;
  maxConcurrentUsers?: number;
  maxDurationSeconds?: number;
}

export function buildK6Script(params: ScriptParams): string {
  const TESTING_DEFAULTS = loadTestingDefaults();
  const DEFAULT_MAX_USERS = TESTING_DEFAULTS.default_max_users;
  const DEFAULT_MAX_DURATION_SECONDS = TESTING_DEFAULTS.default_max_duration_seconds;

  const {
    testName,
    baseUrl,
    endpoints,
    virtualUsers,
    durationSeconds,
    rampUpSeconds,
    thresholds,
    testDataFile,
    authUrl,
    authUsername = "",
    authPassword = "",
    authTokenField = "",
    maxConcurrentUsers = DEFAULT_MAX_USERS,
    maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS,
  } = params;

  const safeUsers = Math.min(virtualUsers, maxConcurrentUsers);
  const safeDuration = Math.min(durationSeconds, maxDurationSeconds);
  const rampUp =
    rampUpSeconds ??
    Math.max(
      TESTING_DEFAULTS.min_ramp_up_seconds,
      Math.floor(safeDuration * TESTING_DEFAULTS.ramp_up_ratio)
    );
  const steadyState = safeDuration - rampUp * 2;

  const defaultThresholds = {
    ...TESTING_DEFAULTS.k6_thresholds,
    ...thresholds,
  };

  const hasTestData = !!testDataFile;
  const hasAuth = !!authUrl;

  // Generate endpoint calls — with or without test data
  const endpointCalls = endpoints
    .map((ep) => {
      const method = ep.method.toLowerCase();

      // With test data: resolve {placeholders} from data row at runtime
      // Without test data: use path as-is
      const pathExpr = hasTestData
        ? `resolvePath('${ep.path}', row)`
        : `'${ep.path}'`;

      const headersExpr =
        hasTestData || hasAuth
          ? "headers"
          : `{ 'Content-Type': 'application/json' }`;

      if (method === "get" || method === "delete") {
        return `
    // ${ep.method} ${ep.path}
    {
      const url = \`\${BASE_URL}\${${pathExpr}}\`;
      const res = http.${method}(url, { headers: ${headersExpr}, tags: { endpoint: '${ep.method} ${ep.path}' } });
      check(res, {
        '${ep.method} ${ep.path} status 2xx': (r) => r.status >= 200 && r.status < 300,
      });
      sleep(Math.random() * ${TESTING_DEFAULTS.default_sleep_max_s - TESTING_DEFAULTS.default_sleep_min_s} + ${TESTING_DEFAULTS.default_sleep_min_s});
    }`;
      } else {
        const { bodyExpr, comment } = buildBodyExpression(ep, hasTestData);
        const requiredFieldNames = (ep.requiredBodyFields || []).join(", ") || "(none)";
        const allFieldNames = (ep.bodyAllFields || []).join(", ") || "(none from OpenAPI)";

        return `
    // ${ep.method} ${ep.path}
    // required fields (OpenAPI): ${requiredFieldNames}
    // all body fields (OpenAPI): ${allFieldNames}
    {
      const url = \`\${BASE_URL}\${${pathExpr}}\`;
      const payload = ${bodyExpr};
      const res = http.${method}(url, payload, { headers: ${headersExpr}, tags: { endpoint: '${ep.method} ${ep.path}' } });
      check(res, {
        '${ep.method} ${ep.path} status 2xx': (r) => r.status >= 200 && r.status < 300,
      });
      sleep(Math.random() * ${TESTING_DEFAULTS.default_sleep_max_s - TESTING_DEFAULTS.default_sleep_min_s} + ${TESTING_DEFAULTS.default_sleep_min_s});
    }`;
      }
    })
    .join("\n");

  // Resolve absolute path for test data — forward slashes for safe JS string embedding on Windows
  const testDataAbsPath = hasTestData
    ? resolve(PROJECT_ROOT, testDataFile!).replace(/\\/g, "/")
    : "";

  // SharedArray import — only needed for test data
  const sharedArrayImport = hasTestData
    ? `import { SharedArray } from 'k6/data';`
    : "";

  const testDataBlock = hasTestData
    ? buildTestDataBlock(testDataAbsPath)
    : "";

  // Auth setup block
  const setupBlock = hasAuth
    ? buildSetupBlock({
        url: authUrl!,
        username: authUsername,
        password: authPassword,
        tokenField: authTokenField || undefined,
      })
    : "";

  // VU setup lines
  const vuDataSetup = buildVuDataSetup(hasTestData, hasAuth);

  return `// Auto-generated k6 test: ${testName}
// Generated at: ${new Date().toISOString()}
// Target: ${baseUrl}
// Endpoints: ${endpoints.length}
// Max VUs: ${safeUsers}, Duration: ${safeDuration}s
${hasTestData ? `// Test data:  ${testDataFile} (flat fields auto-filtered by OpenAPI schema, round-robin per VU)` : "// No test data file — using static paths"}
${hasAuth ? `// Auth:       setup() fetches token from ${authUrl} before load starts` : "// No auth — requests sent without Authorization header"}

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
${sharedArrayImport}
${testDataBlock}
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
${setupBlock}
export default function (data) {
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
