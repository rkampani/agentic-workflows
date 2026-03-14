/**
 * /api/run — SSE endpoint for streaming test runs.
 *
 * Supports two modes:
 *   POST /api/run/deterministic  — fixed 6-step pipeline via `python -m agent run`
 *   POST /api/run/agent          — natural language → agentic via `python -m agent`
 *
 * Both stream newline-delimited SSE events:
 *   data: {"type":"log","text":"..."}
 *   data: {"type":"done","verdict":"PASS"}
 *   data: {"type":"error","text":"..."}
 */

import { Router, Request, Response } from "express";
import { spawn } from "child_process";
import { PROJECT_ROOT } from "../config.js";

const router = Router();

function sseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function send(res: Response, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamProcess(
  res: Response,
  cmd: string,
  args: string[],
): void {
  const child = spawn(cmd, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
  });

  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) send(res, { type: "log", text: line });
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) send(res, { type: "log", text: line });
    }
  });

  child.on("close", (code) => {
    const verdict = code === 0 ? "PASS" : "FAIL";
    send(res, { type: "done", exit_code: code, verdict });
    res.end();
  });

  child.on("error", (err) => {
    send(res, { type: "error", text: err.message });
    res.end();
  });
}

/**
 * POST /api/run/deterministic
 * Body: { service, env, users?, duration?, baseline?, save_as? }
 */
router.post("/deterministic", (req: Request, res: Response) => {
  const { service, env = "local", users, duration, baseline, save_as } = req.body as Record<string, string>;

  if (!service) {
    res.status(400).json({ error: "service is required" });
    return;
  }

  sseHeaders(res);

  const args = ["-m", "agent", "run", "--service", service, "--env", env];
  if (users) args.push("--users", users);
  if (duration) args.push("--duration", duration);
  if (baseline) args.push("--baseline", baseline);
  if (save_as) args.push("--save-as", save_as);

  streamProcess(res, "python3", args);
});

/**
 * POST /api/run/agent
 * Body: { message }
 */
router.post("/agent", (req: Request, res: Response) => {
  const { message } = req.body as { message: string };

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  sseHeaders(res);
  streamProcess(res, "python3", ["-m", "agent", message]);
});

export default router;
