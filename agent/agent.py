"""
ReAct Agent Loop — the core reasoning engine.

Implements the Reason → Act → Observe loop using Claude API and MCP tools.
Claude decides which tools to call and when to stop.
"""

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
import anthropic

# Load .env from project root
load_dotenv(Path(__file__).parent.parent / ".env")

from .mcp_client import MCPClientManager
from .prompts import SYSTEM_PROMPT, CI_MODE_PROMPT

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-sonnet-4-5-20250929"
MAX_ITERATIONS = 30


@dataclass
class AgentResult:
    """Result from an agent run."""
    response: str
    tool_calls_made: int
    iterations: int
    duration_seconds: float
    has_regression: bool = False


@dataclass
class ConversationMessage:
    """A single message in the conversation."""
    role: str
    content: Any


class PerformanceAgent:
    """ReAct agent for performance testing Spring Boot services."""

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        max_iterations: int = MAX_ITERATIONS,
        ci_mode: bool = False,
        verbose: bool = False,
    ):
        self.model = model
        self.max_iterations = max_iterations
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

    async def initialize(self):
        """Connect to all MCP servers and discover tools."""
        tools = await self.mcp.connect_all()
        if self.verbose:
            print(self.mcp.get_tool_summary())
        return tools

    async def run(self, user_message: str) -> AgentResult:
        """Run the agent with a user message. Implements the ReAct loop."""
        start_time = time.time()

        # Initialize MCP connections
        await self.initialize()

        # Build system prompt
        system = SYSTEM_PROMPT
        if self.ci_mode:
            system += "\n\n" + CI_MODE_PROMPT

        # Add user message to conversation
        self.conversation.append({
            "role": "user",
            "content": user_message,
        })

        # Get available tools in Claude format
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

        # ReAct Loop: Claude reasons, calls tools, observes, repeats until done
        while iterations < self.max_iterations:
            iterations += 1

            if self.verbose:
                print(f"\n--- Agent Iteration {iterations} ---")

            # Call Claude
            try:
                response = self.client.messages.create(
                    model=self.model,
                    max_tokens=8192,
                    system=system,
                    tools=tools,
                    messages=self.conversation,
                )
            except anthropic.APIError as e:
                final_response = f"Claude API error: {e}"
                break

            # Process response
            assistant_content = response.content
            self.conversation.append({
                "role": "assistant",
                "content": assistant_content,
            })

            # Check if Claude wants to use tools
            tool_calls = [block for block in assistant_content if block.type == "tool_use"]

            if not tool_calls:
                # Claude is done — extract text response
                text_blocks = [block.text for block in assistant_content if block.type == "text"]
                final_response = "\n".join(text_blocks)
                break

            # Execute tool calls
            tool_results = []
            for tool_call in tool_calls:
                tool_name = tool_call.name
                tool_args = tool_call.input
                tool_id = tool_call.id

                if self.verbose:
                    print(f"  Tool: {tool_name}({json.dumps(tool_args, indent=2)[:200]})")

                # Route to correct MCP server
                result = await self.mcp.call_tool(tool_name, tool_args)
                self.total_tool_calls += 1

                if self.verbose:
                    preview = result[:300] + "..." if len(result) > 300 else result
                    print(f"  Result: {preview}")

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": result,
                })

            # Add tool results to conversation
            self.conversation.append({
                "role": "user",
                "content": tool_results,
            })

            # Check stop condition
            if response.stop_reason == "end_turn":
                text_blocks = [block.text for block in assistant_content if block.type == "text"]
                final_response = "\n".join(text_blocks)
                break

        # Check for regressions in CI mode
        has_regression = False
        if self.ci_mode and "FAIL" in final_response.upper():
            has_regression = True

        duration = time.time() - start_time

        # Cleanup
        await self.mcp.disconnect_all()

        return AgentResult(
            response=final_response,
            tool_calls_made=self.total_tool_calls,
            iterations=iterations,
            duration_seconds=round(duration, 2),
            has_regression=has_regression,
        )
