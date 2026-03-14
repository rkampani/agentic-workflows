import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AuthConfig {
  url: string;
  username: string;
  password: string;
  token_field: string;
}

export interface ServiceConfig {
  description: string;
  team: string;
  swagger_path: string;
  framework?: string;
  environments: Record<string, string>;
  include_endpoints?: string[];
  exclude_endpoints?: string[];
  test_data_file?: string;
  auth?: Partial<AuthConfig>;
  max_concurrent_users?: number;
  max_duration_seconds?: number;
}

export interface ServicesConfig {
  services: Record<string, ServiceConfig>;
  defaults: {
    max_concurrent_users: number;
    max_duration_seconds: number;
    allowed_environments: string[];
    auth?: Partial<AuthConfig>;
  };
}

interface DefaultsYaml {
  auth?: Partial<AuthConfig>;
}

let _servicesCache: ServicesConfig | undefined;
let _authDefaultsCache: Partial<AuthConfig> | undefined;

export function loadServicesConfig(): ServicesConfig {
  if (_servicesCache) return _servicesCache;
  const configPath =
    process.env.SERVICES_CONFIG_PATH ||
    resolve(__dirname, "../../../../config/services.yaml");
  const raw = readFileSync(configPath, "utf-8");
  _servicesCache = parse(raw) as ServicesConfig;
  return _servicesCache;
}

export function loadAuthDefaults(): Partial<AuthConfig> {
  if (_authDefaultsCache) return _authDefaultsCache;
  try {
    const defaultsPath =
      process.env.DEFAULTS_CONFIG_PATH ||
      resolve(__dirname, "../../../../config/defaults.yaml");
    const raw = readFileSync(defaultsPath, "utf-8");
    const parsed = parse(raw) as DefaultsYaml;
    _authDefaultsCache = parsed?.auth ?? {};
  } catch {
    _authDefaultsCache = {};
  }
  return _authDefaultsCache;
}

/** Merge global auth defaults with per-service auth overrides. */
export function resolveAuthConfig(
  serviceAuth?: Partial<AuthConfig>
): AuthConfig | undefined {
  if (!serviceAuth?.url) return undefined; // url is always required
  const defaults = loadAuthDefaults();
  return {
    token_field: defaults.token_field ?? "access_token",
    ...defaults,
    ...serviceAuth,
  } as AuthConfig;
}
