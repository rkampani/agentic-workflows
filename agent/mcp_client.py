"""
MCP Client Manager — connects to MCP servers, discovers tools, routes calls.

Spawns each MCP server as a subprocess via stdio transport, discovers available
tools, and converts them to Claude API tool format.
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).parent.parent


@dataclass
class MCPServerConfig:
    """Configuration for a single MCP server."""
    name: str
    command: str
    args: list[str]
    env: dict[str, str] = field(default_factory=dict)


@dataclass
class ConnectedServer:
    """A connected MCP server with its session and tools."""
    config: MCPServerConfig
    session: ClientSession
    tools: list[dict[str, Any]]
    _read: Any = None
    _write: Any = None


# Default MCP server configurations
DEFAULT_SERVERS = [
    MCPServerConfig(
        name="service-registry",
        command="node",
        args=[str(PROJECT_ROOT / "mcp-servers" / "service-registry" / "dist" / "index.js")],
    ),
    MCPServerConfig(
        name="perf-test",
        command="node",
        args=[str(PROJECT_ROOT / "mcp-servers" / "perf-test-server" / "dist" / "index.js")],
    ),
    MCPServerConfig(
        name="spring-metrics",
        command="node",
        args=[str(PROJECT_ROOT / "mcp-servers" / "spring-metrics" / "dist" / "index.js")],
    ),
    MCPServerConfig(
        name="results-analyzer",
        command="node",
        args=[str(PROJECT_ROOT / "mcp-servers" / "results-analyzer" / "dist" / "index.js")],
    ),
]


class MCPClientManager:
    """Manages connections to multiple MCP servers."""

    def __init__(self, servers: list[MCPServerConfig] | None = None):
        self.server_configs = servers or DEFAULT_SERVERS
        self.connected_servers: dict[str, ConnectedServer] = {}
        self._tool_to_server: dict[str, str] = {}
        self._claude_tools: list[dict[str, Any]] = []
        self._contexts: list[Any] = []

    async def connect_all(self) -> list[dict[str, Any]]:
        """Connect to all MCP servers and discover tools. Returns Claude-format tools."""
        all_tools: list[dict[str, Any]] = []

        for config in self.server_configs:
            try:
                tools = await self._connect_server(config)
                all_tools.extend(tools)
                logger.info(f"Connected to {config.name}: {len(tools)} tools")
            except Exception as e:
                logger.warning(f"Failed to connect to {config.name}: {e}")

        self._claude_tools = all_tools
        return all_tools

    async def _connect_server(self, config: MCPServerConfig) -> list[dict[str, Any]]:
        """Connect to a single MCP server and discover its tools."""
        server_params = StdioServerParameters(
            command=config.command,
            args=config.args,
            env={**dict(config.env)} if config.env else None,
        )

        # Create stdio connection
        ctx = stdio_client(server_params)
        read_stream, write_stream = await ctx.__aenter__()
        self._contexts.append(ctx)

        # Create and initialize session
        session = ClientSession(read_stream, write_stream)
        await session.__aenter__()
        self._contexts.append(session)

        await session.initialize()

        # Discover tools
        tools_response = await session.list_tools()
        claude_tools = []

        for tool in tools_response.tools:
            tool_name = tool.name
            claude_tool = {
                "name": tool_name,
                "description": tool.description or "",
                "input_schema": tool.inputSchema,
            }
            claude_tools.append(claude_tool)
            self._tool_to_server[tool_name] = config.name

        self.connected_servers[config.name] = ConnectedServer(
            config=config,
            session=session,
            tools=claude_tools,
        )

        return claude_tools

    async def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Route a tool call to the correct MCP server and return result."""
        server_name = self._tool_to_server.get(tool_name)
        if not server_name:
            return json.dumps({"error": f"Unknown tool: {tool_name}"})

        server = self.connected_servers.get(server_name)
        if not server:
            return json.dumps({"error": f"Server '{server_name}' not connected"})

        try:
            result = await server.session.call_tool(tool_name, arguments)
            # Combine all content blocks into a single string
            text_parts = []
            for content in result.content:
                if hasattr(content, "text"):
                    text_parts.append(content.text)
                else:
                    text_parts.append(str(content))
            return "\n".join(text_parts)
        except Exception as e:
            return json.dumps({"error": f"Tool call failed: {str(e)}"})

    def get_claude_tools(self) -> list[dict[str, Any]]:
        """Get all discovered tools in Claude API format."""
        return self._claude_tools

    def get_tool_summary(self) -> str:
        """Get a human-readable summary of connected servers and tools."""
        lines = ["Connected MCP Servers:"]
        for name, server in self.connected_servers.items():
            tool_names = [t["name"] for t in server.tools]
            lines.append(f"  {name}: {', '.join(tool_names)}")
        lines.append(f"\nTotal: {len(self._claude_tools)} tools available")
        return "\n".join(lines)

    async def disconnect_all(self):
        """Disconnect from all MCP servers."""
        for ctx in reversed(self._contexts):
            try:
                await ctx.__aexit__(None, None, None)
            except Exception:
                pass
        self._contexts.clear()
        self.connected_servers.clear()
        self._tool_to_server.clear()
        self._claude_tools.clear()
