import type { ServicesConfig } from "../config/loader.js";
import { resolveAuthConfig } from "../config/loader.js";
import { fetchSwagger, extractEndpoints, filterEndpoints } from "../openapi/extractor.js";
import type { ToolResult } from "./list-services.js";

export async function handleDiscoverEndpoints(
  args: unknown,
  config: ServicesConfig
): Promise<ToolResult> {
  const a = args as Record<string, unknown> | undefined;
  const serviceName = a?.service_name as string;
  const env = (a?.environment as string) || "local";
  const svc = config.services[serviceName];

  if (!svc) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: `Service '${serviceName}' not found` }),
        },
      ],
      isError: true,
    };
  }

  const baseUrl = svc.environments[env];
  if (!baseUrl) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Environment '${env}' not configured for '${serviceName}'`,
            available: Object.keys(svc.environments),
          }),
        },
      ],
      isError: true,
    };
  }

  try {
    const spec = await fetchSwagger(baseUrl, svc.swagger_path);
    const allEndpoints = extractEndpoints(spec);
    const endpoints = filterEndpoints(
      allEndpoints,
      svc.include_endpoints,
      svc.exclude_endpoints
    );

    const filterInfo: Record<string, unknown> = {};
    if (svc.include_endpoints || svc.exclude_endpoints) {
      filterInfo.filtering_applied = true;
      filterInfo.total_discovered = allEndpoints.length;
      filterInfo.after_filtering = endpoints.length;
      filterInfo.filtered_out = allEndpoints.length - endpoints.length;
      if (svc.include_endpoints)
        filterInfo.include_patterns = svc.include_endpoints;
      if (svc.exclude_endpoints)
        filterInfo.exclude_patterns = svc.exclude_endpoints;
    }

    const resolvedAuth = resolveAuthConfig(svc.auth);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              service: serviceName,
              environment: env,
              base_url: baseUrl,
              endpoints,
              total_endpoints: endpoints.length,
              ...filterInfo,
              ...(svc.test_data_file && {
                test_data_file: svc.test_data_file,
              }),
              ...(resolvedAuth && { auth_config: resolvedAuth }),
              max_concurrent_users:
                svc.max_concurrent_users ??
                config.defaults.max_concurrent_users,
              max_duration_seconds:
                svc.max_duration_seconds ?? config.defaults.max_duration_seconds,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error: unknown) {
    const err = error as Error;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Failed to fetch Swagger spec from ${baseUrl}${svc.swagger_path}`,
            details: err.message,
            hint: "Make sure the service is running and /v3/api-docs is accessible",
          }),
        },
      ],
      isError: true,
    };
  }
}
