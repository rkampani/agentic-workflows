import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { SCRIPTS_DIR } from "../config/defaults.js";
import { runK6Test } from "../runner/k6-runner.js";
import type { ToolResult } from "./generate-script.js";

export async function handleRunTest(args: unknown): Promise<ToolResult> {
  const a = args as Record<string, unknown> | undefined;
  const scriptName = a?.script_name as string;
  const envVars = (a?.environment_vars as Record<string, string>) || {};

  const scriptPath = resolve(SCRIPTS_DIR, scriptName);
  if (!existsSync(scriptPath)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Script not found: ${scriptName}`,
            available: readdirSync(SCRIPTS_DIR).filter((f) =>
              f.endsWith(".js")
            ),
          }),
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await runK6Test(scriptName, envVars);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: result.status,
              exit_code: result.exit_code,
              test_script: scriptName,
              results_file: result.results_file,
              aggregate_stats: result.aggregate_stats,
              ...(result.k6_stderr_preview
                ? { k6_stderr_preview: result.k6_stderr_preview }
                : {}),
              // GUARDRAIL: Only aggregate stats returned. Raw logs stay in results/ locally.
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: unknown) {
    const e = err as Error;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Failed to spawn k6: ${e.message}`,
            hint: "Make sure k6 is installed: brew install k6",
          }),
        },
      ],
      isError: true,
    };
  }
}
