"""
Agentic mode command — natural language instruction dispatched to Claude.
Requires ANTHROPIC_API_KEY.
"""

import asyncio
import os
import sys

import typer
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel

console = Console()


def run(
    message: str = typer.Argument(..., help="Natural language instruction for the agent"),
    model: str = typer.Option(None, "--model", "-m", help="Claude model (overrides config/defaults.yaml)"),
    ci: bool = typer.Option(False, "--ci", help="CI/CD mode: concise output, exit code reflects pass/fail"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show each tool call and result"),
    max_iterations: int = typer.Option(None, "--max-iterations", help="Maximum agent loop iterations"),
):
    """[AGENTIC] Natural language instruction — requires ANTHROPIC_API_KEY."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        console.print("[red]Error:[/red] ANTHROPIC_API_KEY is not set in your environment or .env file.")
        console.print("[dim]Tip: run a deterministic test without a key:[/dim]")
        console.print("  [bold]python3 -m agent test --service <name> --users 3 --duration 30[/bold]")
        raise typer.Exit(1)

    from agent.agent import PerformanceAgent  # noqa: PLC0415

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
