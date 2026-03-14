import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(__dirname, "../../../../..");
export const SCRIPTS_DIR = resolve(PROJECT_ROOT, "test-scripts");
export const RESULTS_DIR = resolve(PROJECT_ROOT, "results");

export interface TestingDefaults {
  ramp_up_ratio: number;
  min_ramp_up_seconds: number;
  default_sleep_min_s: number;
  default_sleep_max_s: number;
  default_max_users: number;
  default_max_duration_seconds: number;
  k6_thresholds: Record<string, string[]>;
}

let _defaultsCache: TestingDefaults | undefined;

export function loadTestingDefaults(): TestingDefaults {
  if (_defaultsCache) return _defaultsCache;

  const fallback: TestingDefaults = {
    ramp_up_ratio: 0.1,
    min_ramp_up_seconds: 5,
    default_sleep_min_s: 0.5,
    default_sleep_max_s: 1.5,
    default_max_users: 500,
    default_max_duration_seconds: 600,
    k6_thresholds: {
      http_req_duration: ["p(95)<2000", "p(99)<5000"],
      http_req_failed: ["rate<0.1"],
    },
  };

  try {
    const configPath =
      process.env.DEFAULTS_CONFIG_PATH ||
      resolve(PROJECT_ROOT, "config/defaults.yaml");
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parse(raw) as Record<string, unknown>;
    const t = (parsed?.testing as Record<string, unknown>) || {};
    _defaultsCache = {
      ramp_up_ratio:
        (t.ramp_up_ratio as number) ?? fallback.ramp_up_ratio,
      min_ramp_up_seconds:
        (t.min_ramp_up_seconds as number) ?? fallback.min_ramp_up_seconds,
      default_sleep_min_s:
        (t.default_sleep_min_s as number) ?? fallback.default_sleep_min_s,
      default_sleep_max_s:
        (t.default_sleep_max_s as number) ?? fallback.default_sleep_max_s,
      default_max_users:
        (t.default_max_users as number) ?? fallback.default_max_users,
      default_max_duration_seconds:
        (t.default_max_duration_seconds as number) ??
        fallback.default_max_duration_seconds,
      k6_thresholds:
        (t.k6_thresholds as Record<string, string[]>) ??
        fallback.k6_thresholds,
    };
  } catch {
    _defaultsCache = fallback;
  }

  return _defaultsCache;
}
