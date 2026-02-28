"""
Helpers for safe MCP tool calls with consistent error handling.

Provides:
  - call_tool_safe()  — calls a tool, logs if verbose, parses JSON, raises on error
  - take_snapshot()   — pre/post metrics snapshot that degrades gracefully when unavailable
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Optional

from rich.console import Console

if TYPE_CHECKING:
    from .mcp_client import MCPClientManager

logger = logging.getLogger(__name__)
console = Console()


class ToolCallError(Exception):
    """Raised when an MCP tool returns an error response."""

    def __init__(self, tool_name: str, message: str):
        self.tool_name = tool_name
        super().__init__(f"[{tool_name}] {message}")


async def call_tool_safe(
    mcp: "MCPClientManager",
    name: str,
    args: dict,
    verbose: bool = False,
) -> dict:
    """
    Call an MCP tool, optionally log the exchange, and parse the JSON response.

    Raises:
      ToolCallError      — if the response contains an "error" key
      json.JSONDecodeError — if the response is not valid JSON
    """
    raw = await mcp.call_tool(name, args)

    if verbose:
        _log_tool(name, args, raw)

    result = json.loads(raw)
    if "error" in result:
        raise ToolCallError(name, str(result["error"]))
    return result


async def take_snapshot(
    mcp: "MCPClientManager",
    base_url: str,
    service: str,
    label: str,
    verbose: bool = False,
) -> Optional[str]:
    """
    Take a before/after metrics snapshot.

    Returns the saved file path, or None if the endpoint is unavailable.
    Never raises — snapshot failure must not abort the pipeline.
    """
    try:
        result = await call_tool_safe(
            mcp,
            "snapshot_metrics",
            {"base_url": base_url, "label": label, "service_name": service},
            verbose=verbose,
        )
        return result.get("saved_to")
    except (ToolCallError, json.JSONDecodeError) as exc:
        logger.debug("Snapshot skipped (%s): %s", label, exc)
        return None


def _log_tool(tool_name: str, args: dict, raw_result: str) -> None:
    console.print(f"    [dim]→ tool:[/dim] [bold]{tool_name}[/bold]")
    console.print(f"    [dim]→ args:[/dim] {json.dumps(args, indent=6)[:400]}")
    preview = raw_result[:600] + "..." if len(raw_result) > 600 else raw_result
    console.print(f"    [dim]→ result:[/dim] {preview}")
