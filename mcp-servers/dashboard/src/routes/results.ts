import { Router } from "express";
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { RESULTS_DIR } from "../config.js";

const router = Router();

/** GET /api/results — list all result files */
router.get("/", (_req, res) => {
  if (!existsSync(RESULTS_DIR)) {
    res.json({ results: [] });
    return;
  }
  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith("-results.json"))
    .map((f) => {
      const name = f.replace("-results.json", "");
      const path = resolve(RESULTS_DIR, f);
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        const metrics = raw.metrics ?? {};
        return {
          name,
          file: f,
          timestamp: raw.root_group?.start ?? null,
          p95_ms: metrics.http_req_duration?.values?.["p(95)"] ?? null,
          error_rate: metrics.http_req_failed?.values?.rate ?? null,
          rps: metrics.http_reqs?.values?.rate ?? null,
        };
      } catch {
        return { name, file: f };
      }
    })
    .sort((a, b) => {
      const ta = a.timestamp ?? "";
      const tb = b.timestamp ?? "";
      return tb.localeCompare(ta);
    });

  res.json({ results: files });
});

/** GET /api/results/:name — full result JSON for chart rendering */
router.get("/:name", (req, res) => {
  const file = resolve(RESULTS_DIR, `${req.params.name}-results.json`);
  if (!existsSync(file)) {
    res.status(404).json({ error: "Result not found" });
    return;
  }
  const raw = JSON.parse(readFileSync(file, "utf-8"));
  const metrics = raw.metrics ?? {};

  res.json({
    name: req.params.name,
    http_req_duration: metrics.http_req_duration?.values ?? {},
    http_req_failed: metrics.http_req_failed?.values ?? {},
    http_reqs: metrics.http_reqs?.values ?? {},
    iterations: metrics.iterations?.values ?? {},
    vus_max: metrics.vus_max?.values ?? {},
    thresholds: raw.thresholds ?? {},
  });
});

export default router;
