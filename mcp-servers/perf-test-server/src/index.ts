#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, mkdirSync } from "fs";
import { createServer } from "./server.js";
import { SCRIPTS_DIR, RESULTS_DIR } from "./config/defaults.js";

// Ensure directories exist
for (const dir of [SCRIPTS_DIR, RESULTS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Perf Test MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
