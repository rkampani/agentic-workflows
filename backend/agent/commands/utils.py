"""
Utility commands: discover, list-tools, check.
None of these require an Anthropic API key.
"""

import asyncio
import json

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

console = Console()


def discover(
    service: str = typer.Argument(..., help="Service name (as defined in config/services.yaml)"),
    env: str = typer.Option("local", "--env", "-e", help="Environment: local | dev | staging"),
):
    """Discover endpoints for a service. Does NOT require an Anthropic API key."""
    from agent.mcp_client import MCPClientManager  # noqa: PLC0415

    async def _discover() -> str:
        mcp = MCPClientManager()
        await mcp.connect_all()
        result = await mcp.call_tool("discover_endpoints", {"service_name": service, "environment": env})
        await mcp.disconnect_all()
        return result

    raw = asyncio.run(_discover())

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        console.print(raw)
        return

    if "error" in data:
        console.print(f"[red]Error:[/red] {data['error']}")
        raise typer.Exit(1)

    lines = [
        f"[bold]Service:[/bold] {data.get('service')}",
        f"[bold]Environment:[/bold] {data.get('environment')}",
        f"[bold]Base URL:[/bold] {data.get('base_url')}",
    ]
    if data.get("filtering_applied"):
        lines.append(
            f"[dim]Filtering: {data['total_discovered']} discovered → "
            f"{data['after_filtering']} after filters "
            f"({data['filtered_out']} skipped)[/dim]"
        )
    if data.get("test_data_file"):
        lines.append(f"[dim]Test data: {data['test_data_file']}[/dim]")
    if data.get("auth_config"):
        lines.append(f"[dim]Auth: {data['auth_config']['url']}[/dim]")
    lines.append(
        f"[dim]Safety caps: {data.get('max_concurrent_users')} max users, "
        f"{data.get('max_duration_seconds')}s max duration[/dim]"
    )

    console.print(Panel("\n".join(lines), title="Service Discovery", border_style="cyan"))

    endpoints = data.get("endpoints", [])
    if not endpoints:
        console.print("[yellow]No testable endpoints found after filtering.[/yellow]")
        return

    table = Table(title=f"{len(endpoints)} Testable Endpoint(s)", show_lines=True)
    table.add_column("Method", style="bold green", width=8)
    table.add_column("Path", style="cyan")
    table.add_column("Summary")
    for ep in endpoints:
        table.add_row(ep["method"], ep["path"], ep.get("summary", ""))
    console.print(table)


def list_tools():
    """List all available MCP tools from connected servers."""
    from agent.mcp_client import MCPClientManager  # noqa: PLC0415

    async def _list():
        mcp = MCPClientManager()
        tools = await mcp.connect_all()
        console.print(Panel(mcp.get_tool_summary(), title="Available MCP Tools", border_style="cyan"))
        console.print("\n[bold]Tool Details:[/bold]\n")
        for tool in tools:
            console.print(f"  [bold cyan]{tool['name']}[/bold cyan]")
            console.print(f"    {tool['description'][:120]}")
            console.print()
        await mcp.disconnect_all()

    asyncio.run(_list())


def check():
    """Verify MCP servers are built and can connect."""
    from agent.mcp_client import MCPClientManager  # noqa: PLC0415

    async def _check():
        mcp = MCPClientManager()
        console.print("[bold]Checking MCP server connections...[/bold]\n")
        tools = await mcp.connect_all()
        for name, server in mcp.connected_servers.items():
            console.print(f"  [green]✓[/green] {name}: {len(server.tools)} tools")
        if not mcp.connected_servers:
            console.print("  [red]✗[/red] No servers connected. Run 'npm run build' first.")
        else:
            console.print(
                f"\n[green]All {len(mcp.connected_servers)} servers connected, "
                f"{len(tools)} total tools available.[/green]"
            )
        await mcp.disconnect_all()

    asyncio.run(_check())
