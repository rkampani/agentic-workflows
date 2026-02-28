"""
ReAct Agent Loop — the core reasoning engine.

Implements the Reason → Act → Observe loop using Claude API and MCP tools.
Model name, max iterations, and max tokens are loaded from config/defaults.yaml
so they can be tuned without code changes.
"""

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import anthropic
from dotenv import load_dotenv

from .config_loader import load_agent_config
from .mcp_client import MCPClientManager
from .prompts import SYSTEM_PROMPT, CI_MODE_PROMPT

load_dotenv(Path(__file__).parent.parent / ".env")

logger = logging.getLogger(__name__)


@dataclass
class AgentResult:
    response: str
    tool_calls_made: int
    iterations: int
    duration_seconds: float
    has_regression: bool = False


class PerformanceAgent:
    """ReAct agent for performance testing API services."""

    def __init__(
        self,
        model: str | None = None,
        max_iterations: int | None = None,
        ci_mode: bool = False,
        verbose: bool = False,
    ):
        cfg = load_agent_config()

        # CLI/constructor args take precedence over config file
        self.model = model or cfg.model
        self.max_iterations = max_iterations or cfg.max_iterations
        self.max_tokens = cfg.max_tokens
        self.ci_mode = ci_mode
        self.verbose = verbose

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise EnvironmentError(
                "ANTHROPIC_API_KEY is not set.\n"
                "  • To run the full agent:  set ANTHROPIC_API_KEY in .env\n"
                "  • To discover endpoints without a key: python -m agent discover <service>"
            )

        self.client = anthropic.Anthropic(api_key=api_key)
        self.mcp = MCPClientManager()
        self.conversation: list[dict[str, Any]] = []
        self.total_tool_calls = 0

    async def initialize(self) -> list[dict[str, Any]]:
        """Connect to all MCP servers and discover tools."""
        tools = await self.mcp.connect_all()
        if self.verbose:
            print(self.mcp.get_tool_summary())
        return tools

    async def run(self, user_message: str) -> AgentResult:
        """Run the agent with a user message. Implements the ReAct loop."""
        start_time = time.time()

        await self.initialize()

        system = SYSTEM_PROMPT
        if self.ci_mode:
            system += "\n\n" + CI_MODE_PROMPT

        self.conversation.append({"role": "user", "content": user_message})

        tools = self.mcp.get_claude_tools()
        if not tools:
            return AgentResult(
                response="No MCP tools available. Make sure MCP servers are built (npm run build).",
                tool_calls_made=0,
                iterations=0,
                duration_seconds=time.time() - start_time,
            )

        iterations = 0
        final_response = ""

        while iterations < self.max_iterations:
            iterations += 1
            if self.verbose:
                print(f"\n--- Agent Iteration {iterations} ---")

            try:
                response = self.client.messages.create(
                    model=self.model,
                    max_tokens=self.max_tokens,
                    system=system,
                    tools=tools,
                    messages=self.conversation,
                )
            except anthropic.APIError as exc:
                final_response = f"Claude API error: {exc}"
                break

            assistant_content = response.content
            self.conversation.append({"role": "assistant", "content": assistant_content})

            tool_calls = [b for b in assistant_content if b.type == "tool_use"]

            if not tool_calls:
                final_response = "\n".join(
                    b.text for b in assistant_content if b.type == "text"
                )
                break

            tool_results = []
            for call in tool_calls:
                if self.verbose:
                    print(f"  Tool: {call.name}({json.dumps(call.input, indent=2)[:200]})")

                result = await self.mcp.call_tool(call.name, call.input)
                self.total_tool_calls += 1

                if self.verbose:
                    preview = result[:300] + "..." if len(result) > 300 else result
                    print(f"  Result: {preview}")

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": call.id,
                    "content": result,
                })

            self.conversation.append({"role": "user", "content": tool_results})

            if response.stop_reason == "end_turn":
                final_response = "\n".join(
                    b.text for b in assistant_content if b.type == "text"
                )
                break

        has_regression = self.ci_mode and "FAIL" in final_response.upper()

        await self.mcp.disconnect_all()

        return AgentResult(
            response=final_response,
            tool_calls_made=self.total_tool_calls,
            iterations=iterations,
            duration_seconds=round(time.time() - start_time, 2),
            has_regression=has_regression,
        )
