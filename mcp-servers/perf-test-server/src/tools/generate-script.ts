import { writeFileSync } from "fs";
import { resolve } from "path";
import { loadTestingDefaults, SCRIPTS_DIR } from "../config/defaults.js";
import { buildK6Script } from "../script-builder/assembler.js";

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export type ErrorResult = ToolResult;

export function handleGenerateScript(args: unknown): ToolResult | ErrorResult {
  const TESTING_DEFAULTS = loadTestingDefaults();
  const DEFAULT_MAX_USERS = TESTING_DEFAULTS.default_max_users;
  const DEFAULT_MAX_DURATION_SECONDS = TESTING_DEFAULTS.default_max_duration_seconds;

  const a = args as Record<string, unknown> | undefined;
  const testName = a?.test_name as string;
  const baseUrl = a?.base_url as string;
  const endpoints = a?.endpoints as Array<{
    method: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
    requiredBodyFields?: string[];
    bodyFieldExamples?: Record<string, unknown>;
  }>;
  const virtualUsers = a?.virtual_users as number;
  const durationSeconds = a?.duration_seconds as number;
  const rampUpSeconds = a?.ramp_up_seconds as number | undefined;
  const thresholds = a?.thresholds as Record<string, string[]> | undefined;
  const testDataFile = a?.test_data_file as string | undefined;
  const authUrl = a?.auth_url as string | undefined;
  const authUsername = a?.auth_username as string | undefined;
  const authPassword = a?.auth_password as string | undefined;
  const authTokenField = a?.auth_token_field as string | undefined;
  const maxConcurrentUsers =
    (a?.max_concurrent_users as number) || DEFAULT_MAX_USERS;
  const maxDurationSeconds =
    (a?.max_duration_seconds as number) || DEFAULT_MAX_DURATION_SECONDS;

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

  const script = buildK6Script({
    testName,
    baseUrl,
    endpoints,
    virtualUsers,
    durationSeconds,
    rampUpSeconds,
    thresholds,
    testDataFile,
    authUrl,
    authUsername,
    authPassword,
    authTokenField,
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
              ...(authUrl && { auth_url: authUrl }),
            },
          },
          null,
          2
        ),
      },
    ],
  };
}
