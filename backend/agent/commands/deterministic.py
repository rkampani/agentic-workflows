"""
Deterministic mode command — fixed 6-step pipeline, no API key required.
"""

import asyncio
import sys

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

console = Console()


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
    from agent.config_loader import load_test_run_config  # noqa: PLC0415
    from agent.mcp_client import MCPClientManager  # noqa: PLC0415
    from agent.pipeline import DeterministicPipeline  # noqa: PLC0415
    from agent.tool_caller import ToolCallError  # noqa: PLC0415

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

    async def _run():
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
    from agent.pipeline import PipelineResult  # noqa: PLC0415
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
