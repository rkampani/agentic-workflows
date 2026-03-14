import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadServicesConfig } from "./config/loader.js";
import { handleListServices } from "./tools/list-services.js";
import { handleGetServiceConfig } from "./tools/get-service-config.js";
import { handleDiscoverEndpoints } from "./tools/discover-endpoints.js";
import { handleGetSwaggerSpec } from "./tools/get-swagger-spec.js";

export function createServer(): Server {
  const server = new Server(
    { name: "service-registry", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_services",
        description:
          "List all registered services with their team ownership and available environments. " +
          "Returns service names, descriptions, teams, and which environments (local/dev/staging) are configured.",
        inputSchema: {
          type: "object" as const,
          properties: {
            team: {
              type: "string",
              description: "Optional: filter by team name",
            },
          },
        },
      },
      {
        name: "get_service_config",
        description:
          "Get detailed configuration for a specific service including all environment URLs " +
          "and swagger path. Use this to find the base URL for a service in a specific environment.",
        inputSchema: {
          type: "object" as const,
          properties: {
            service_name: {
              type: "string",
              description: "Name of the service (e.g., 'order-service')",
            },
            environment: {
              type: "string",
              description:
                "Optional: specific environment to get URL for (local/dev/staging)",
            },
          },
          required: ["service_name"],
        },
      },
      {
        name: "discover_endpoints",
        description:
          "Discover all API endpoints for a service by fetching its live OpenAPI/Swagger spec. " +
          "Returns a list of endpoints with HTTP methods, paths, and descriptions. " +
          "Requires the service to be running and accessible.",
        inputSchema: {
          type: "object" as const,
          properties: {
            service_name: {
              type: "string",
              description: "Name of the service",
            },
            environment: {
              type: "string",
              description: "Environment to discover from (default: 'local')",
            },
          },
          required: ["service_name"],
        },
      },
      {
        name: "get_swagger_spec",
        description:
          "Get the full OpenAPI/Swagger JSON specification for a service. " +
          "Returns the complete spec including schemas, parameters, and response types. " +
          "Use this when you need detailed API information beyond just endpoint paths.",
        inputSchema: {
          type: "object" as const,
          properties: {
            service_name: {
              type: "string",
              description: "Name of the service",
            },
            environment: {
              type: "string",
              description: "Environment to fetch from (default: 'local')",
            },
          },
          required: ["service_name"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const config = loadServicesConfig();

    switch (name) {
      case "list_services":
        return handleListServices(args, config) as never;

      case "get_service_config":
        return handleGetServiceConfig(args, config) as never;

      case "discover_endpoints":
        return (await handleDiscoverEndpoints(args, config)) as never;

      case "get_swagger_spec":
        return (await handleGetSwaggerSpec(args, config)) as never;

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        } as never;
    }
  });

  return server;
}
