import type { ServicesConfig } from "../config/loader.js";
import { fetchSwagger } from "../openapi/extractor.js";
import type { ToolResult } from "./list-services.js";

export async function handleGetSwaggerSpec(
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
            error: `Environment '${env}' not configured`,
          }),
        },
      ],
      isError: true,
    };
  }

  try {
    const spec = await fetchSwagger(baseUrl, svc.swagger_path);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(spec, null, 2),
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
            error: `Failed to fetch spec: ${err.message}`,
          }),
        },
      ],
      isError: true,
    };
  }
}
