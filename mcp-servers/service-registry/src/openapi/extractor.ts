export interface DiscoveredEndpoint {
  method: string;
  path: string;
  summary: string;
  tags: string[];
  requiredBodyFields?: string[];
  bodyAllFields?: string[];
  bodyFieldExamples?: Record<string, unknown>;
}

export async function fetchSwagger(
  baseUrl: string,
  swaggerPath: string
): Promise<unknown> {
  const url = `${baseUrl}${swaggerPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function extractEndpoints(spec: unknown): DiscoveredEndpoint[] {
  const endpoints: DiscoveredEndpoint[] = [];
  const paths = (spec as Record<string, unknown>).paths as Record<string, unknown> || {};

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, details] of Object.entries(
      methods as Record<string, unknown>
    )) {
      if (
        ["get", "post", "put", "patch", "delete"].includes(method.toLowerCase())
      ) {
        const det = details as Record<string, unknown>;
        const endpoint: DiscoveredEndpoint = {
          method: method.toUpperCase(),
          path,
          summary: (det.summary as string) || (det.description as string) || "",
          tags: (det.tags as string[]) || [],
        };

        const requestBody = det.requestBody as Record<string, unknown> | undefined;
        const schema = (
          (requestBody?.content as Record<string, unknown>)?.[
            "application/json"
          ] as Record<string, unknown>
        )?.schema as Record<string, unknown> | undefined;

        if (schema) {
          const properties =
            (schema.properties as Record<string, unknown>) || {};
          endpoint.requiredBodyFields = (schema.required as string[]) || [];
          endpoint.bodyAllFields = Object.keys(properties);

          const bodyFieldExamples: Record<string, unknown> = {};
          for (const [field, def] of Object.entries(properties)) {
            const example = (def as Record<string, unknown>).example;
            if (example !== undefined) bodyFieldExamples[field] = example;
          }
          // fallback: top-level schema.example object
          if (schema.example && typeof schema.example === "object") {
            for (const [field, val] of Object.entries(
              schema.example as Record<string, unknown>
            )) {
              if (!(field in bodyFieldExamples)) bodyFieldExamples[field] = val;
            }
          }
          endpoint.bodyFieldExamples = bodyFieldExamples;
        }

        endpoints.push(endpoint);
      }
    }
  }

  return endpoints;
}

// Match an endpoint against a pattern like "GET /api/orders*", "DELETE *".
// Patterns support: "*" as wildcard, "METHOD /path" for method+path, "/path" for any method.
function matchesPattern(
  method: string,
  path: string,
  pattern: string
): boolean {
  const trimmed = pattern.trim();

  let patternMethod = "*";
  let patternPath = trimmed;

  // If pattern starts with an HTTP method, split it
  const methodMatch = trimmed.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i);
  if (methodMatch) {
    patternMethod = methodMatch[1].toUpperCase();
    patternPath = methodMatch[2];
  }

  // Check method match
  if (patternMethod !== "*" && patternMethod !== method.toUpperCase()) {
    return false;
  }

  // Convert glob pattern to regex: * → .*, escape the rest
  const regexStr =
    "^" +
    patternPath
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*") +
    "$";
  return new RegExp(regexStr).test(path);
}

export function filterEndpoints(
  endpoints: DiscoveredEndpoint[],
  include?: string[],
  exclude?: string[]
): DiscoveredEndpoint[] {
  let filtered = endpoints;

  // If include is defined, keep only matching endpoints
  if (include && include.length > 0) {
    filtered = filtered.filter((ep) =>
      include.some((pattern) => matchesPattern(ep.method, ep.path, pattern))
    );
  }

  // If exclude is defined, remove matching endpoints
  if (exclude && exclude.length > 0) {
    filtered = filtered.filter(
      (ep) =>
        !exclude.some((pattern) => matchesPattern(ep.method, ep.path, pattern))
    );
  }

  return filtered;
}
