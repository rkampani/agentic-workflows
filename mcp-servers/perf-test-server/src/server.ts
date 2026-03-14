import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadTestingDefaults } from "./config/defaults.js";
import { handleGenerateScript } from "./tools/generate-script.js";
import { handleRunTest } from "./tools/run-test.js";
import { handleListScripts } from "./tools/list-scripts.js";

export function createServer(): Server {
  const TESTING_DEFAULTS = loadTestingDefaults();
  const DEFAULT_MAX_USERS = TESTING_DEFAULTS.default_max_users;
  const DEFAULT_MAX_DURATION_SECONDS = TESTING_DEFAULTS.default_max_duration_seconds;

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
              description:
                "Name for the test (used as filename, e.g., 'order-service-baseline')",
            },
            base_url: {
              type: "string",
              description:
                "Base URL of the service (e.g., 'http://localhost:8081')",
            },
            endpoints: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  method: {
                    type: "string",
                    description: "HTTP method (GET, POST, PUT, DELETE)",
                  },
                  path: {
                    type: "string",
                    description: "Endpoint path (e.g., '/api/orders')",
                  },
                  body: {
                    type: "string",
                    description: "Optional JSON body for POST/PUT requests",
                  },
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
              description:
                'Optional k6 thresholds (e.g., {"http_req_duration": ["p(95)<500"]})',
            },
            test_data_file: {
              type: "string",
              description:
                "Path to JSON test data file (relative to project root). Array of row objects. Flat fields are auto-filtered by the OpenAPI schema for each endpoint (e.g. {\"user_id\": \"1\", \"billToId\": 1223}). Explicit body_<METHOD>_<path> keys override the auto-filter. Each VU gets a different row round-robin.",
            },
            auth_url: {
              type: "string",
              description:
                "Auth token endpoint URL (e.g. 'http://localhost:9080/auth/token'). k6 calls this once in setup() before the load starts and shares the token across all VUs.",
            },
            auth_username: {
              type: "string",
              description:
                "Username credential for the auth endpoint. Required when auth_url is provided.",
            },
            auth_password: {
              type: "string",
              description:
                "Password credential for the auth endpoint. Required when auth_url is provided.",
            },
            auth_token_field: {
              type: "string",
              description:
                "Which JSON field in the auth response holds the token (default: tries access_token, then token, then id_token).",
            },
          },
          required: [
            "test_name",
            "base_url",
            "endpoints",
            "virtual_users",
            "duration_seconds",
          ],
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
              description:
                "Name of the test script file (e.g., 'order-service-baseline.js')",
            },
            environment_vars: {
              type: "object",
              description:
                'Optional environment variables to pass to k6 (e.g., {"BASE_URL": "..."})',
            },
          },
          required: ["script_name"],
        },
      },
      {
        name: "list_test_scripts",
        description:
          "List all saved k6 test scripts in the test-scripts/ directory.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "generate_k6_script":
        return handleGenerateScript(args) as never;

      case "run_k6_test":
        return (await handleRunTest(args)) as never;

      case "list_test_scripts":
        return handleListScripts() as never;

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        } as never;
    }
  });

  return server;
}
