"""
MCP Client Manager — connects to MCP servers, discovers tools, routes calls.

Server list is loaded from config/mcp-servers.yaml so adding or removing a
server requires only a YAML edit — no Python code changes needed.
"""

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).parent.parent
MCP_SERVERS_CONFIG = PROJECT_ROOT / "config" / "mcp-servers.yaml"


@dataclass
class MCPServerConfig:
    """Configuration for a single MCP server subprocess."""
    name: str
    command: str
    args: list[str]
    env: dict[str, str] = field(default_factory=dict)


@dataclass
class ConnectedServer:
    """A live MCP server session with its discovered tools."""
    config: MCPServerConfig
    session: ClientSession
    tools: list[dict[str, Any]]


def _load_server_configs() -> list[MCPServerConfig]:
    """
    Load MCP server definitions from config/mcp-servers.yaml.
    Falls back to hardcoded defaults if the file is not found.
    """
    if MCP_SERVERS_CONFIG.exists():
        with open(MCP_SERVERS_CONFIG) as f:
            data = yaml.safe_load(f) or {}
        servers = []
        for name, cfg in (data.get("servers") or {}).items():
            # Resolve relative args paths against PROJECT_ROOT
            args = [
                str(PROJECT_ROOT / a) if not Path(a).is_absolute() else a
                for a in (cfg.get("args") or [])
            ]
            servers.append(MCPServerConfig(
                name=name,
                command=cfg.get("command", "node"),
                args=args,
                env=cfg.get("env") or {},
            ))
        if servers:
            return servers
        logger.warning("config/mcp-servers.yaml has no servers defined — using defaults")

    # In-code fallback (matches the YAML defaults exactly)
    logger.info("config/mcp-servers.yaml not found — using built-in server list")
    mcp_dir = PROJECT_ROOT / "mcp-servers"
    return [
        MCPServerConfig(
            name="service-registry",
            command="node",
            args=[str(mcp_dir / "service-registry" / "dist" / "index.js")],
        ),
        MCPServerConfig(
            name="perf-test",
            command="node",
            args=[str(mcp_dir / "perf-test-server" / "dist" / "index.js")],
        ),
        MCPServerConfig(
            name="spring-metrics",
            command="node",
            args=[str(mcp_dir / "spring-metrics" / "dist" / "index.js")],
        ),
        MCPServerConfig(
            name="results-analyzer",
            command="node",
            args=[str(mcp_dir / "results-analyzer" / "dist" / "index.js")],
        ),
    ]


class MCPClientManager:
    """Manages connections to multiple MCP servers."""

    def __init__(self, servers: Optional[list[MCPServerConfig]] = None):
        self.server_configs = servers or _load_server_configs()
        self.connected_servers: dict[str, ConnectedServer] = {}
        self._tool_to_server: dict[str, str] = {}
        self._claude_tools: list[dict[str, Any]] = []
        self._contexts: list[Any] = []

    async def connect_all(self) -> list[dict[str, Any]]:
        """Connect to all configured MCP servers and discover tools."""
        all_tools: list[dict[str, Any]] = []
        for config in self.server_configs:
            try:
                tools = await self._connect_server(config)
                all_tools.extend(tools)
                logger.info("Connected to %s: %d tools", config.name, len(tools))
            except Exception as exc:
                logger.warning("Failed to connect to %s: %s", config.name, exc)

        self._claude_tools = all_tools
        return all_tools

    async def _connect_server(self, config: MCPServerConfig) -> list[dict[str, Any]]:
        server_params = StdioServerParameters(
            command=config.command,
            args=config.args,
            env=dict(config.env) if config.env else None,
        )

        ctx = stdio_client(server_params)
        read_stream, write_stream = await ctx.__aenter__()
        self._contexts.append(ctx)

        session = ClientSession(read_stream, write_stream)
        await session.__aenter__()
        self._contexts.append(session)
        await session.initialize()

        tools_response = await session.list_tools()
        claude_tools = []
        for tool in tools_response.tools:
            claude_tool = {
                "name": tool.name,
                "description": tool.description or "",
                "input_schema": tool.inputSchema,
            }
            claude_tools.append(claude_tool)
            self._tool_to_server[tool.name] = config.name

        self.connected_servers[config.name] = ConnectedServer(
            config=config,
            session=session,
            tools=claude_tools,
        )
        return claude_tools

    async def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Route a tool call to the correct MCP server and return the result string."""
        server_name = self._tool_to_server.get(tool_name)
        if not server_name:
            return json.dumps({"error": f"Unknown tool: {tool_name}"})

        server = self.connected_servers.get(server_name)
        if not server:
            return json.dumps({"error": f"Server '{server_name}' not connected"})

        try:
            result = await server.session.call_tool(tool_name, arguments)
            parts = [
                content.text if hasattr(content, "text") else str(content)
                for content in result.content
            ]
            return "\n".join(parts)
        except Exception as exc:
            return json.dumps({"error": f"Tool call failed: {exc}"})

    def get_claude_tools(self) -> list[dict[str, Any]]:
        """All discovered tools in Claude API format."""
        return self._claude_tools

    def get_tool_summary(self) -> str:
        """Human-readable summary of connected servers and their tools."""
        lines = ["Connected MCP Servers:"]
        for name, server in self.connected_servers.items():
            tool_names = [t["name"] for t in server.tools]
            lines.append(f"  {name}: {', '.join(tool_names)}")
        lines.append(f"\nTotal: {len(self._claude_tools)} tools available")
        return "\n".join(lines)

    async def disconnect_all(self) -> None:
        """Disconnect from all MCP servers and clean up contexts."""
        for ctx in reversed(self._contexts):
            try:
                await ctx.__aexit__(None, None, None)
            except Exception:
                pass
        self._contexts.clear()
        self.connected_servers.clear()
        self._tool_to_server.clear()
        self._claude_tools.clear()
