import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, "../../..");
export const RESULTS_DIR = resolve(PROJECT_ROOT, "results");
export const SCRIPTS_DIR = resolve(PROJECT_ROOT, "test-scripts");
export const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3000", 10);

export interface ServiceEnvironments {
  [env: string]: string;
}

export interface ServiceEntry {
  description: string;
  team: string;
  environments: ServiceEnvironments;
  max_concurrent_users?: number;
  max_duration_seconds?: number;
}

export interface ServicesConfig {
  services: Record<string, ServiceEntry>;
  defaults: {
    max_concurrent_users: number;
    max_duration_seconds: number;
  };
}

let _cache: ServicesConfig | null = null;

export function loadServicesConfig(): ServicesConfig {
  if (!_cache) {
    const path = resolve(PROJECT_ROOT, "config/services.yaml");
    _cache = parse(readFileSync(path, "utf-8")) as ServicesConfig;
  }
  return _cache;
}
