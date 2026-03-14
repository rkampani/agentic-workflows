import type { ServicesConfig } from "../config/loader.js";
import type { ToolResult } from "./list-services.js";

export function handleGetServiceConfig(
  args: unknown,
  config: ServicesConfig
): ToolResult {
  const a = args as Record<string, unknown> | undefined;
  const serviceName = a?.service_name as string;
  const env = a?.environment as string | undefined;
  const svc = config.services[serviceName];

  if (!svc) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Service '${serviceName}' not found`,
            available: Object.keys(config.services),
          }),
        },
      ],
      isError: true,
    };
  }

  const result: Record<string, unknown> = {
    name: serviceName,
    description: svc.description,
    team: svc.team,
    swagger_path: svc.swagger_path,
    ...(svc.include_endpoints && { include_endpoints: svc.include_endpoints }),
    ...(svc.exclude_endpoints && { exclude_endpoints: svc.exclude_endpoints }),
    ...(svc.test_data_file && { test_data_file: svc.test_data_file }),
    max_concurrent_users:
      svc.max_concurrent_users ?? config.defaults.max_concurrent_users,
    max_duration_seconds:
      svc.max_duration_seconds ?? config.defaults.max_duration_seconds,
  };

  if (env) {
    const url = svc.environments[env];
    if (!url) {
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
    result.environment = env;
    result.base_url = url;
  } else {
    result.environments = svc.environments;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
