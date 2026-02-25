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
import json
import os
import sys

import typer
from rich.console import Console
from rich.panel import Panel
from rich.markdown import Markdown
from rich.table import Table

from .agent import PerformanceAgent

app = typer.Typer(
    name="perf-agent",
    help="Agentic AI Performance Testing Platform",
    no_args_is_help=True,
)
console = Console()


# ── Agentic mode ──────────────────────────────────────────────────────────────

@app.command()
def run(
    message: str = typer.Argument(..., help="Natural language instruction for the agent"),
    model: str = typer.Option(
        "claude-sonnet-4-5-20250929",
        "--model", "-m",
        help="Claude model to use",
    ),
    ci: bool = typer.Option(False, "--ci", help="CI/CD mode: concise output, exit code reflects pass/fail"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show detailed agent reasoning and tool calls"),
    max_iterations: int = typer.Option(30, "--max-iterations", help="Maximum agent loop iterations"),
):
    """[AGENTIC] Natural language instruction — requires ANTHROPIC_API_KEY."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        console.print("[red]Error:[/red] ANTHROPIC_API_KEY is not set in your environment or .env file.")
        console.print("[dim]Tip: run a deterministic test without a key:[/dim]")
        console.print("  [bold]python -m agent test --service <name> --users 3 --duration 30[/bold]")
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
        print(result.response)
        sys.exit(1 if result.has_regression else 0)
    else:
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


# ── Deterministic mode ────────────────────────────────────────────────────────

@app.command()
def test(
    service: str = typer.Option(None, "--service", "-s", help="Service name from services.yaml  [env: PERF_SERVICE]"),
    env: str = typer.Option(None, "--env", "-e", help="Environment: local | dev | staging  [env: PERF_ENV]"),
    users: int = typer.Option(None, "--users", "-u", help="Number of virtual users  [env: PERF_USERS]"),
    duration: int = typer.Option(None, "--duration", "-d", help="Test duration in seconds  [env: PERF_DURATION]"),
    baseline: str = typer.Option(None, "--baseline", "-b", help="Baseline name to compare against  [env: PERF_BASELINE]"),
    save_as: str = typer.Option(None, "--save-as", help="Save results as this baseline name after the test"),
    ci: bool = typer.Option(False, "--ci", help="CI mode: structured output, exit 0=pass 1=regression"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show raw tool call args and responses at each step"),
):
    """[DETERMINISTIC] Fixed pipeline — no Anthropic API key required.

    Parameters can be provided as flags or environment variables:
      PERF_SERVICE, PERF_ENV, PERF_USERS, PERF_DURATION, PERF_BASELINE
    """
    from .mcp_client import MCPClientManager

    # Resolve from env vars when not passed as flags
    service  = service  or os.environ.get("PERF_SERVICE")
    env      = env      or os.environ.get("PERF_ENV", "local")
    users    = users    or (int(os.environ.get("PERF_USERS",    "0")) or None)
    duration = duration or (int(os.environ.get("PERF_DURATION", "0")) or None)
    baseline = baseline or os.environ.get("PERF_BASELINE")

    if not service:
        console.print("[red]Error:[/red] --service is required (or set PERF_SERVICE env var)")
        raise typer.Exit(1)

    def log_tool(tool_name: str, args: dict, raw_result: str) -> None:
        """Print tool call details when verbose mode is on."""
        if not verbose:
            return
        console.print(f"    [dim]→ tool:[/dim] [bold]{tool_name}[/bold]")
        console.print(f"    [dim]→ args:[/dim] {json.dumps(args, indent=6)[:400]}")
        preview = raw_result[:600] + "..." if len(raw_result) > 600 else raw_result
        console.print(f"    [dim]→ result:[/dim] {preview}")

    if not ci:
        console.print(Panel(
            f"[bold blue]Deterministic Performance Test[/bold blue]\n"
            f"[dim]Service: {service} | Env: {env} | "
            f"Users: {users or 'from config'} | Duration: {duration or 'from config'}s | "
            f"Verbose: {verbose}[/dim]",
            title="Test Starting",
            border_style="blue",
        ))

    async def _run_pipeline():
        mcp = MCPClientManager()
        await mcp.connect_all()

        if verbose:
            console.print(f"\n[dim]{mcp.get_tool_summary()}[/dim]")

        try:
            # ── Step 1: Discover endpoints ──────────────────────────────────
            if not ci:
                console.print(f"\n[bold cyan][1/6][/bold cyan] Discovering endpoints...")

            tool_args = {"service_name": service, "environment": env}
            raw = await mcp.call_tool("discover_endpoints", tool_args)
            log_tool("discover_endpoints", tool_args, raw)
            discovery = json.loads(raw)

            if "error" in discovery:
                console.print(f"[red]Discovery failed:[/red] {discovery['error']}")
                return None

            endpoints = discovery.get("endpoints", [])
            if not endpoints:
                console.print("[red]No testable endpoints found after filtering.[/red]")
                return None

            base_url       = discovery["base_url"]
            test_data_file = discovery.get("test_data_file")
            max_users      = discovery.get("max_concurrent_users", 500)
            max_duration   = discovery.get("max_duration_seconds", 600)

            # Use service caps as defaults when not explicitly provided
            eff_users    = min(users or max_users, max_users)
            eff_duration = min(duration or max_duration, max_duration)

            if not ci:
                console.print(
                    f"  [green]✓[/green] {len(endpoints)} endpoint(s) | "
                    f"{eff_users} users | {eff_duration}s"
                )

            # ── Step 2: Generate k6 script ──────────────────────────────────
            if not ci:
                console.print(f"\n[bold cyan][2/6][/bold cyan] Generating k6 script...")

            test_name   = f"{service}-deterministic"
            script_args: dict = {
                "test_name": test_name,
                "base_url": base_url,
                "endpoints": endpoints,
                "virtual_users": eff_users,
                "duration_seconds": eff_duration,
                "max_concurrent_users": max_users,
                "max_duration_seconds": max_duration,
            }
            if test_data_file:
                script_args["test_data_file"] = test_data_file

            raw = await mcp.call_tool("generate_k6_script", script_args)
            log_tool("generate_k6_script", script_args, raw)
            script_result = json.loads(raw)

            if "error" in script_result:
                console.print(f"[red]Script generation failed:[/red] {script_result['error']}")
                return None

            if not ci:
                console.print(f"  [green]✓[/green] {script_result.get('script_name')}")

            # ── Step 3: Snapshot metrics before ─────────────────────────────
            if not ci:
                console.print(f"\n[bold cyan][3/6][/bold cyan] Capturing pre-test metrics...")

            snap_before_path = None
            snap_args = {"base_url": base_url, "label": "before", "service_name": service}
            raw = await mcp.call_tool("snapshot_metrics", snap_args)
            log_tool("snapshot_metrics", snap_args, raw)
            snap_before = json.loads(raw)
            if "error" not in snap_before:
                snap_before_path = snap_before.get("saved_to")
                if not ci:
                    console.print(f"  [green]✓[/green] Metrics captured")
            else:
                if not ci:
                    console.print(f"  [yellow]⚠[/yellow]  No metrics endpoint — skipping")

            # ── Step 4: Run k6 test ─────────────────────────────────────────
            if not ci:
                console.print(f"\n[bold cyan][4/6][/bold cyan] Running load test...")

            k6_args = {"script_name": f"{test_name}.js"}
            raw = await mcp.call_tool("run_k6_test", k6_args)
            log_tool("run_k6_test", k6_args, raw)
            run_result = json.loads(raw)

            if not ci:
                console.print(f"  [green]✓[/green] Status: {run_result.get('status')}")

            results_file = run_result.get("results_file", "")

            # ── Step 5: Snapshot metrics after ──────────────────────────────
            if not ci:
                console.print(f"\n[bold cyan][5/6][/bold cyan] Capturing post-test metrics...")

            snap_after_path = None
            snap_args = {"base_url": base_url, "label": "after", "service_name": service}
            raw = await mcp.call_tool("snapshot_metrics", snap_args)
            log_tool("snapshot_metrics", snap_args, raw)
            snap_after = json.loads(raw)
            if "error" not in snap_after:
                snap_after_path = snap_after.get("saved_to")
                if not ci:
                    console.print(f"  [green]✓[/green] Metrics captured")
            else:
                if not ci:
                    console.print(f"  [yellow]⚠[/yellow]  No metrics endpoint — skipping")

            # ── Step 6: Analyze + compare + report ──────────────────────────
            if not ci:
                console.print(f"\n[bold cyan][6/6][/bold cyan] Analyzing results...")

            analyze_args = {"results_file": results_file}
            raw = await mcp.call_tool("analyze_results", analyze_args)
            log_tool("analyze_results", analyze_args, raw)
            analysis = json.loads(raw)
            verdict = "PASS"

            if not ci:
                console.print(f"  [green]✓[/green] Grade: {analysis.get('performance_grade', '?')}")

            # Optional: compare against baseline
            comparison = None
            if baseline:
                compare_args = {
                    "current_results_file": results_file,
                    "baseline_name": baseline,
                }
                raw = await mcp.call_tool("compare_baseline", compare_args)
                log_tool("compare_baseline", compare_args, raw)
                comparison = json.loads(raw)
                verdict = comparison.get("verdict", "PASS")
                regressions = comparison.get("regressions", [])
                if not ci:
                    if regressions:
                        console.print(f"  [red]✗[/red]  Regressions: {', '.join(regressions)}")
                    else:
                        console.print(f"  [green]✓[/green] No regressions vs '{baseline}'")

            # Optional: save as new baseline
            if save_as:
                await mcp.call_tool("save_baseline", {
                    "results_file": results_file,
                    "baseline_name": save_as,
                    "metadata": {"service": service, "environment": env},
                })
                if not ci:
                    console.print(f"  [green]✓[/green] Saved as baseline '{save_as}'")

            # Generate Markdown report
            report_args: dict = {
                "results_file": results_file,
                "service_name": service,
                "environment": env,
            }
            if baseline:
                report_args["baseline_name"] = baseline
            snapshot_paths = [p for p in [snap_before_path, snap_after_path] if p]
            if snapshot_paths:
                report_args["metrics_snapshots"] = snapshot_paths

            raw = await mcp.call_tool("generate_report", report_args)
            log_tool("generate_report", report_args, raw)
            report_result = json.loads(raw)

            return {
                "analysis": analysis,
                "comparison": comparison,
                "report": report_result,
                "verdict": verdict,
            }

        finally:
            await mcp.disconnect_all()

    result = asyncio.run(_run_pipeline())

    if result is None:
        raise typer.Exit(1)

    analysis  = result["analysis"]
    verdict   = result["verdict"]
    stats     = analysis.get("aggregate_stats", {})
    dur_stats = stats.get("http_req_duration", {})
    notes     = analysis.get("notes", [])

    if ci:
        has_regression = verdict != "PASS"
        print(f"VERDICT: {'FAIL' if has_regression else 'PASS'}")
        if result["comparison"] and result["comparison"].get("regressions"):
            print(f"REGRESSIONS: {', '.join(result['comparison']['regressions'])}")
        print(f"GRADE: {analysis.get('performance_grade', '?')}")
        print(
            f"p95: {dur_stats.get('p95_ms')}ms | "
            f"p99: {dur_stats.get('p99_ms')}ms | "
            f"errors: {stats.get('error_rate_percent')}%"
        )
        sys.exit(1 if has_regression else 0)
    else:
        table = Table(title=f"Results — {service} ({env})", show_lines=True)
        table.add_column("Metric", style="bold")
        table.add_column("Value", style="cyan")
        table.add_row("Grade",          analysis.get("performance_grade", "?"))
        table.add_row("p50 latency",    f"{dur_stats.get('p50_ms')}ms")
        table.add_row("p95 latency",    f"{dur_stats.get('p95_ms')}ms")
        table.add_row("p99 latency",    f"{dur_stats.get('p99_ms')}ms")
        table.add_row("Error rate",     f"{stats.get('error_rate_percent')}%")
        table.add_row("Throughput",     f"{stats.get('requests_per_second')} req/s")
        table.add_row("Total requests", str(stats.get("total_requests")))
        table.add_row(
            "Verdict",
            "[green]PASS[/green]" if verdict == "PASS" else "[red]FAIL — regression detected[/red]",
        )

        console.print("\n")
        console.print(table)

        if notes:
            console.print("\n[bold]Notes:[/bold]")
            for note in notes:
                console.print(f"  [yellow]•[/yellow] {note}")

        if result["report"].get("saved_to"):
            console.print(f"\n[dim]Report saved: {result['report']['saved_to']}[/dim]")


# ── Utility commands ──────────────────────────────────────────────────────────

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
