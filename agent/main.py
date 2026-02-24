"""
CLI entry point for the Agentic Performance Testing Platform.

Usage:
    python -m agent "test order-service on staging"
    python -m agent "find the breaking point of payment-service"
    python -m agent --ci "regression check order-service staging"
"""

import asyncio
import json
import os
import sys
import sys

import typer
from rich.console import Console
from rich.panel import Panel
from rich.markdown import Markdown
from rich.table import Table

from .agent import PerformanceAgent

app = typer.Typer(
    name="perf-agent",
    help="Agentic AI Performance Testing Platform for Spring Boot microservices",
    no_args_is_help=True,
)
console = Console()


@app.command()
def run(
        message: str = typer.Argument(..., help="Natural language instruction for the agent"),
        model: str = typer.Option(
            "claude-sonnet-4-5-20250929",
            "--model", "-m",
            help="Claude model to use",
        ),
        ci: bool = typer.Option(
            False,
            "--ci",
            help="CI/CD mode: concise output, exit code reflects pass/fail",
        ),
        verbose: bool = typer.Option(
            False,
            "--verbose", "-v",
            help="Show detailed agent reasoning and tool calls",
        ),
        max_iterations: int = typer.Option(
            30,
            "--max-iterations",
            help="Maximum agent loop iterations",
        ),
):
    """Run the performance testing agent with a natural language instruction."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        console.print("[red]Error:[/red] ANTHROPIC_API_KEY is not set in your environment or .env file.")
        console.print("[dim]Tip: To discover endpoints without a key, run:[/dim]")
        console.print("  [bold]python -m agent discover <service-name>[/bold]")
        raise typer.Exit(1)

    if not ci:
        console.print(Panel(
            f"[bold blue]Agentic Performance Testing Platform[/bold blue]\n"
            f"[dim]Model: {model} | Max iterations: {max_iterations}[/dim]",
            title="Agent Starting",
            border_style="blue",
        ))
        console.print(f"\n[bold]Task:[/bold] {message}\n")

    agent = PerformanceAgent(
        model=model,
        max_iterations=max_iterations,
        ci_mode=ci,
        verbose=verbose,
    )

    result = asyncio.run(agent.run(message))

    if ci:
        # CI mode: print result and exit with code
        print(result.response)
        sys.exit(1 if result.has_regression else 0)
    else:
        # Interactive mode: rich output
        console.print("\n")
        console.print(Panel(
            Markdown(result.response),
            title="Agent Results",
            border_style="green",
        ))
        console.print(
            f"\n[dim]Completed in {result.duration_seconds}s | "
            f"{result.tool_calls_made} tool calls | "
            f"{result.iterations} iterations[/dim]\n"
        )

@app.command()
def discover(
        service: str = typer.Argument(..., help="Service name (as defined in config/services.yaml)"),
        env: str = typer.Option("local", "--env", "-e", help="Environment: local | dev | staging"),
):
    """Discover endpoints for a service. Does NOT require an Anthropic API key."""
    from .mcp_client import MCPClientManager

    async def _discover():
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

    # Summary panel
    lines = [
        f"[bold]Service:[/bold] {data.get('service')}",
        f"[bold]Environment:[/bold] {data.get('environment')}",
        f"[bold]Base URL:[/bold] {data.get('base_url')}",
    ]

    # Show filtering details
    if data.get("filtering_applied"):
        total = data.get('total_discovered', 0)
        after = data.get('after_filtering', 0)
        filtered_out = data.get('filtered_out', 0)
        lines.append(
            f"[dim]Filtering: {total} discovered → {after} after filters ({filtered_out} skipped)[/dim]"
        )

        # Show include/exclude patterns for debugging
        if data.get("include_patterns"):
            patterns = data.get("include_patterns", [])
            lines.append(f"[bold blue]Include patterns:[/bold blue]")
            for pattern in patterns:
                lines.append(f"  [cyan]  {pattern}[/cyan]")

        if data.get("exclude_patterns"):
            patterns = data.get("exclude_patterns", [])
            lines.append(f"[bold red]Exclude patterns:[/bold red]")
            for pattern in patterns:
                lines.append(f"  [cyan]  {pattern}[/cyan]")

    if data.get("test_data_file"):
        lines.append(f"[dim]Test data: {data['test_data_file']}[/dim]")
    lines.append(
        f"[dim]Safety caps: {data.get('max_concurrent_users')} max users, "
        f"{data.get('max_duration_seconds')}s max duration[/dim]"
    )

    console.print(Panel("\n".join(lines), title="Service Discovery", border_style="cyan"))

    # Endpoints table
    endpoints = data.get("endpoints", [])
    if not endpoints:
        console.print("[yellow]⚠️  No testable endpoints found after filtering.[/yellow]")

        # If filtering was applied and found endpoints but they were all filtered out
        if data.get("filtering_applied") and data.get("total_discovered", 0) > 0:
            console.print("[yellow]Debugging tips:[/yellow]")
            console.print("[yellow]  1. Check if include_endpoints patterns match actual endpoints[/yellow]")
            console.print("[yellow]  2. Temporarily remove include_endpoints to list all endpoints[/yellow]")
            console.print("[yellow]  3. Verify the service is reachable at the configured base URL[/yellow]")
        return

    table = Table(title=f"{len(endpoints)} Testable Endpoint(s)", show_lines=True)
    table.add_column("Method", style="bold green", width=8)
    table.add_column("Path", style="cyan")
    table.add_column("Summary")

    for ep in endpoints:
        table.add_row(ep["method"], ep["path"], ep.get("summary", ""))

    console.print(table)


@app.command()
def list_tools():
    """List all available MCP tools from connected servers."""
    from .mcp_client import MCPClientManager

    async def _list():
        mcp = MCPClientManager()
        tools = await mcp.connect_all()
        console.print(Panel(
            mcp.get_tool_summary(),
            title="Available MCP Tools",
            border_style="cyan",
        ))
        console.print(f"\n[bold]Tool Details:[/bold]\n")
        for tool in tools:
            console.print(f"  [bold cyan]{tool['name']}[/bold cyan]")
            console.print(f"    {tool['description'][:120]}")
            console.print()
        await mcp.disconnect_all()

    asyncio.run(_list())


@app.command()
def check():
    """Verify MCP servers are built and can connect."""
    from .mcp_client import MCPClientManager

    async def _check():
        mcp = MCPClientManager()
        console.print("[bold]Checking MCP server connections...[/bold]\n")

        tools = await mcp.connect_all()
        for name, server in mcp.connected_servers.items():
            tool_count = len(server.tools)
            console.print(f"  [green]✓[/green] {name}: {tool_count} tools")

        if not mcp.connected_servers:
            console.print("  [red]✗[/red] No servers connected. Run 'npm run build' first.")
        else:
            console.print(f"\n[green]All {len(mcp.connected_servers)} servers connected, "
                          f"{len(tools)} total tools available.[/green]")

        await mcp.disconnect_all()

    asyncio.run(_check())


if __name__ == "__main__":
    app()
