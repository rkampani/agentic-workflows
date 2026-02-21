#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { parse } from "yaml";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config Loading ---

interface ServiceEnvironments {
  [env: string]: string;
}

interface ServiceConfig {
  description: string;
  team: string;
  swagger_path: string;
  environments: ServiceEnvironments;
}

interface ServicesYaml {
  services: Record<string, ServiceConfig>;
  defaults: {
    max_concurrent_users: number;
    max_duration_seconds: number;
    allowed_environments: string[];
  };
}

function loadServicesConfig(): ServicesYaml {
  const configPath = process.env.SERVICES_CONFIG_PATH
    || resolve(__dirname, "../../../config/services.yaml");
  const raw = readFileSync(configPath, "utf-8");
  return parse(raw) as ServicesYaml;
}

// --- MCP Server Setup ---

const server = new Server(
  { name: "service-registry", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// --- Tool Definitions ---

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
            description: "Optional: specific environment to get URL for (local/dev/staging)",
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

// --- Tool Implementations ---

async function fetchSwagger(baseUrl: string, swaggerPath: string): Promise<any> {
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

function extractEndpoints(spec: any): Array<{ method: string; path: string; summary: string; tags: string[] }> {
  const endpoints: Array<{ method: string; path: string; summary: string; tags: string[] }> = [];
  const paths = spec.paths || {};

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, details] of Object.entries(methods as Record<string, any>)) {
      if (["get", "post", "put", "patch", "delete"].includes(method.toLowerCase())) {
        endpoints.push({
          method: method.toUpperCase(),
          path,
          summary: details.summary || details.description || "",
          tags: details.tags || [],
        });
      }
    }
  }

  return endpoints;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const config = loadServicesConfig();

  switch (name) {
    case "list_services": {
      const teamFilter = args?.team as string | undefined;
      const services = Object.entries(config.services)
        .filter(([_, svc]) => !teamFilter || svc.team === teamFilter)
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

    case "get_service_config": {
      const serviceName = args?.service_name as string;
      const env = args?.environment as string | undefined;
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

      const result: any = {
        name: serviceName,
        description: svc.description,
        team: svc.team,
        swagger_path: svc.swagger_path,
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

    case "discover_endpoints": {
      const serviceName = args?.service_name as string;
      const env = (args?.environment as string) || "local";
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
        const endpoints = extractEndpoints(spec);

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
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Failed to fetch Swagger spec from ${baseUrl}${svc.swagger_path}`,
                details: error.message,
                hint: "Make sure the service is running and /v3/api-docs is accessible",
              }),
            },
          ],
          isError: true,
        };
      }
    }

    case "get_swagger_spec": {
      const serviceName = args?.service_name as string;
      const env = (args?.environment as string) || "local";
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
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Failed to fetch spec: ${error.message}`,
              }),
            },
          ],
          isError: true,
        };
      }
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// --- Start Server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Service Registry MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
