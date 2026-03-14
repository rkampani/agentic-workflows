import type { ServicesConfig } from "../config/loader.js";

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export function handleListServices(
  args: unknown,
  config: ServicesConfig
): ToolResult {
  const a = args as Record<string, unknown> | undefined;
  const teamFilter = a?.team as string | undefined;
  const services = Object.entries(config.services)
    .filter(([, svc]) => !teamFilter || svc.team === teamFilter)
    .map(([name, svc]) => ({
      name,
      description: svc.description,
      team: svc.team,
      environments: Object.keys(svc.environments),
    }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ services, total: services.length }, null, 2),
      },
    ],
  };
}
