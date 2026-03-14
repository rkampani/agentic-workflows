import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { SCRIPTS_DIR } from "../config/defaults.js";
import type { ToolResult } from "./generate-script.js";

export function handleListScripts(): ToolResult {
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
