"""
CLI entry point for the Agentic Performance Testing Platform.

Agentic mode  (requires ANTHROPIC_API_KEY):
    python3 -m agent run "test payment-service with 3 users on local"

Deterministic mode (no API key needed):
    python3 -m agent test --service payment-service --users 3 --duration 30

Utilities:
    python3 -m agent discover payment-service
    python3 -m agent check
    python3 -m agent list-tools
"""

import typer

from agent.commands.agentic import run
from agent.commands.deterministic import test
from agent.commands.utils import check, discover, list_tools

app = typer.Typer(
    name="perf-agent",
    help="Agentic AI Performance Testing Platform",
    no_args_is_help=True,
)

app.command()(run)
app.command()(test)
app.command()(discover)
app.command("list-tools")(list_tools)
app.command()(check)

if __name__ == "__main__":
    app()
