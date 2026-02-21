"""
CLI entry point for the Agentic Performance Testing Platform.

Usage:
    python -m agent "test order-service on staging"
    python -m agent "find the breaking point of payment-service"
    python -m agent --ci "regression check order-service staging"
"""

import asyncio
import sys

import typer
from rich.console import Console
from rich.panel import Panel
from rich.markdown import Markdown

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
