import { Router } from "express";
import { loadServicesConfig } from "../config.js";

const router = Router();

/** GET /api/services — list all registered services with their environments */
router.get("/", (_req, res) => {
  const config = loadServicesConfig();
  const services = Object.entries(config.services).map(([name, svc]) => ({
    name,
    description: svc.description,
    team: svc.team,
    environments: Object.keys(svc.environments),
    max_concurrent_users: svc.max_concurrent_users ?? config.defaults.max_concurrent_users,
    max_duration_seconds: svc.max_duration_seconds ?? config.defaults.max_duration_seconds,
  }));
  res.json({ services });
});

export default router;
