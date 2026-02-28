"""
CLI entry point for the Agentic Performance Testing Platform.

Agentic mode  (requires ANTHROPIC_API_KEY):
    python -m agent run "test payment-service with 3 users on local"
    python -m agent run "find the breaking point of payment-service"

Deterministic mode (no API key needed):
    python -m agent test --service payment-service --users 3 --duration 30
    python -m agent test --service payment-service --env dev --ci

Utility:
    python -m agent discover payment-service
    python -m agent check
    python -m agent list-tools
"""

import asyncio
import sys

import typer
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table

app = typer.Typer(
    name="perf-agent",
    help="Agentic AI Performance Testing Platform",
    no_args_is_help=True,
)
console = Console()


# ── Agentic mode ───────────────────────────────────────────────────────────────

@app.command()
def run(
    message: str = typer.Argument(..., help="Natural language instruction for the agent"),
    model: str = typer.Option(None, "--model", "-m", help="Claude model (overrides config/defaults.yaml)"),
    ci: bool = typer.Option(False, "--ci", help="CI/CD mode: concise output, exit code reflects pass/fail"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show each tool call and result"),
    max_iterations: int = typer.Option(None, "--max-iterations", help="Maximum agent loop iterations"),
):
    """[AGENTIC] Natural language instruction — requires ANTHROPIC_API_KEY."""
    import os
    if not os.environ.get("ANTHROPIC_API_KEY"):
        console.print("[red]Error:[/red] ANTHROPIC_API_KEY is not set in your environment or .env file.")
        console.print("[dim]Tip: run a deterministic test without a key:[/dim]")
        console.print("  [bold]python -m agent test --service <name> --users 3 --duration 30[/bold]")
        raise typer.Exit(1)

    from .agent import PerformanceAgent

    if not ci:
        console.print(Panel(
            f"[bold blue]Agentic Performance Testing Platform[/bold blue]\n"
            f"[dim]Model: {model or 'from config'} | Max iterations: {max_iterations or 'from config'}[/dim]",
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
        print(result.response)
        sys.exit(1 if result.has_regression else 0)
    else:
        console.print("\n")
        console.print(Panel(Markdown(result.response), title="Agent Results", border_style="green"))
        console.print(
            f"\n[dim]Completed in {result.duration_seconds}s | "
            f"{result.tool_calls_made} tool calls | "
            f"{result.iterations} iterations[/dim]\n"
        )


# ── Deterministic mode ─────────────────────────────────────────────────────────

@app.command()
def test(
    service: str = typer.Option(None, "--service", "-s", help="Service name  [env: PERF_SERVICE]"),
    env: str = typer.Option(None, "--env", "-e", help="Environment: local | dev | staging  [env: PERF_ENV]"),
    users: int = typer.Option(None, "--users", "-u", help="Virtual users  [env: PERF_USERS]"),
    duration: int = typer.Option(None, "--duration", "-d", help="Duration in seconds  [env: PERF_DURATION]"),
    baseline: str = typer.Option(None, "--baseline", "-b", help="Baseline to compare against  [env: PERF_BASELINE]"),
    save_as: str = typer.Option(None, "--save-as", help="Save results as this baseline name"),
    ci: bool = typer.Option(False, "--ci", help="CI mode: structured output, exit 0=pass 1=regression"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Print each tool call and response"),
):
    """[DETERMINISTIC] Fixed 6-step pipeline — no Anthropic API key required.

    Parameters can be provided as flags or environment variables:
      PERF_SERVICE, PERF_ENV, PERF_USERS, PERF_DURATION, PERF_BASELINE
    """
    from .config_loader import load_test_run_config
    from .mcp_client import MCPClientManager
    from .pipeline import DeterministicPipeline
    from .tool_caller import ToolCallError

    run_config = load_test_run_config({
        "service": service, "env": env, "users": users, "duration": duration,
        "baseline": baseline, "save_as": save_as, "ci": ci, "verbose": verbose,
    })

    if not run_config.service:
        console.print("[red]Error:[/red] --service is required (or set PERF_SERVICE env var)")
        raise typer.Exit(1)

    if not ci:
        console.print(Panel(
            f"[bold blue]Deterministic Performance Test[/bold blue]\n"
            f"[dim]Service: {run_config.service} | Env: {run_config.env} | "
            f"Users: {run_config.users or 'from config'} | "
            f"Duration: {run_config.duration or 'from config'}s | "
            f"Verbose: {verbose}[/dim]",
            title="Test Starting",
            border_style="blue",
        ))

    async def _run() -> object:
        mcp = MCPClientManager()
        await mcp.connect_all()
        if verbose:
            console.print(f"\n[dim]{mcp.get_tool_summary()}[/dim]")
        try:
            return await DeterministicPipeline(mcp, run_config).run()
        finally:
            await mcp.disconnect_all()

    try:
        result = asyncio.run(_run())
    except (ToolCallError, ValueError) as exc:
        console.print(f"[red]Pipeline failed:[/red] {exc}")
        raise typer.Exit(1)

    _render_results(result, run_config, ci)


def _render_results(result, run_config, ci: bool) -> None:
    """Render pipeline results as CI one-liner or rich table."""
    from .pipeline import PipelineResult
    assert isinstance(result, PipelineResult)

    analysis = result.analysis
    verdict = result.verdict
    stats = analysis.get("aggregate_stats", {})
    dur = stats.get("http_req_duration", {})

    if ci:
        print(f"VERDICT: {'FAIL' if verdict != 'PASS' else 'PASS'}")
        if result.comparison and result.comparison.get("regressions"):
            print(f"REGRESSIONS: {', '.join(result.comparison['regressions'])}")
        print(f"GRADE: {analysis.get('performance_grade', '?')}")
        print(
            f"p95: {dur.get('p95_ms')}ms | "
            f"p99: {dur.get('p99_ms')}ms | "
            f"errors: {stats.get('error_rate_percent')}%"
        )
        sys.exit(1 if verdict != "PASS" else 0)

    table = Table(title=f"Results — {run_config.service} ({run_config.env})", show_lines=True)
    table.add_column("Metric", style="bold")
    table.add_column("Value", style="cyan")
    table.add_row("Grade",          analysis.get("performance_grade", "?"))
    table.add_row("p50 latency",    f"{dur.get('p50_ms')}ms")
    table.add_row("p95 latency",    f"{dur.get('p95_ms')}ms")
    table.add_row("p99 latency",    f"{dur.get('p99_ms')}ms")
    table.add_row("Error rate",     f"{stats.get('error_rate_percent')}%")
    table.add_row("Throughput",     f"{stats.get('requests_per_second')} req/s")
    table.add_row("Total requests", str(stats.get("total_requests")))
    table.add_row(
        "Verdict",
        "[green]PASS[/green]" if verdict == "PASS" else "[red]FAIL — regression detected[/red]",
    )

    console.print("\n")
    console.print(table)

    notes = analysis.get("notes", [])
    if notes:
        console.print("\n[bold]Notes:[/bold]")
        for note in notes:
            console.print(f"  [yellow]•[/yellow] {note}")

    if result.report.get("saved_to"):
        console.print(f"\n[dim]Report saved: {result.report['saved_to']}[/dim]")


# ── Utility commands ───────────────────────────────────────────────────────────

@app.command()
def discover(
    service: str = typer.Argument(..., help="Service name (as defined in config/services.yaml)"),
    env: str = typer.Option("local", "--env", "-e", help="Environment: local | dev | staging"),
):
    """Discover endpoints for a service. Does NOT require an Anthropic API key."""
    import json
    from .mcp_client import MCPClientManager

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
    if data.get("token_file"):
        lines.append(f"[dim]Token file: {data['token_file']}[/dim]")
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


@app.command()
def list_tools():
    """List all available MCP tools from connected servers."""
    from .mcp_client import MCPClientManager

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


@app.command()
def check():
    """Verify MCP servers are built and can connect."""
    from .mcp_client import MCPClientManager

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


if __name__ == "__main__":
    app()
