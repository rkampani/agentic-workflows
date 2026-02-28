"""
Deterministic 6-step performance test pipeline.

Steps (always run in this order):
  1. discover_endpoints       — fetch live Swagger spec, apply filters
  2. generate_k6_script       — write test-scripts/<service>-deterministic.js
  3. snapshot_metrics (before) — capture server state before load
  4. run_k6_test              — fire k6, collect results
  5. snapshot_metrics (after)  — capture server state after load
  6. analyze + compare + report

No AI involved — same inputs always produce the same tool call sequence.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional, TYPE_CHECKING

from rich.console import Console

from .config_loader import TestRunConfig
from .tool_caller import call_tool_safe, take_snapshot, ToolCallError

if TYPE_CHECKING:
    from .mcp_client import MCPClientManager

logger = logging.getLogger(__name__)
console = Console()


@dataclass
class PipelineResult:
    analysis: dict
    comparison: Optional[dict]
    report: dict
    verdict: str


class DeterministicPipeline:
    """
    Runs the fixed 6-step performance test pipeline.

    Errors from steps 1-2 (discovery/script gen) raise immediately.
    Errors from steps 3 and 5 (metrics snapshots) are silently skipped —
    the test still runs without server-side metrics.
    """

    def __init__(self, mcp: "MCPClientManager", config: TestRunConfig):
        self.mcp = mcp
        self.config = config

    # ── Console helpers ───────────────────────────────────────────────────────

    def _log(self, msg: str) -> None:
        if not self.config.ci:
            console.print(msg)

    def _step(self, n: int, total: int, label: str) -> None:
        self._log(f"\n[bold cyan][{n}/{total}][/bold cyan] {label}")

    def _ok(self, msg: str) -> None:
        self._log(f"  [green]✓[/green] {msg}")

    def _warn(self, msg: str) -> None:
        self._log(f"  [yellow]⚠[/yellow]  {msg}")

    # ── Step implementations ──────────────────────────────────────────────────

    async def _discover(self) -> dict:
        cfg = self.config
        discovery = await call_tool_safe(
            self.mcp,
            "discover_endpoints",
            {"service_name": cfg.service, "environment": cfg.env},
            verbose=cfg.verbose,
        )
        endpoints = discovery.get("endpoints", [])
        if not endpoints:
            raise ValueError("No testable endpoints found after filtering.")

        max_users = discovery.get("max_concurrent_users", 500)
        max_duration = discovery.get("max_duration_seconds", 600)
        return {
            "endpoints": endpoints,
            "base_url": discovery["base_url"],
            "test_data_file": discovery.get("test_data_file"),
            "token_file": discovery.get("token_file"),
            "max_users": max_users,
            "max_duration": max_duration,
            "eff_users": min(cfg.users or max_users, max_users),
            "eff_duration": min(cfg.duration or max_duration, max_duration),
        }

    async def _generate_script(self, discovery: dict) -> dict:
        cfg = self.config
        test_name = f"{cfg.service}-deterministic"
        script_args: dict = {
            "test_name": test_name,
            "base_url": discovery["base_url"],
            "endpoints": discovery["endpoints"],
            "virtual_users": discovery["eff_users"],
            "duration_seconds": discovery["eff_duration"],
            "max_concurrent_users": discovery["max_users"],
            "max_duration_seconds": discovery["max_duration"],
        }
        if discovery["test_data_file"]:
            script_args["test_data_file"] = discovery["test_data_file"]
        if discovery["token_file"]:
            script_args["token_file"] = discovery["token_file"]
            script_args["service_name"] = cfg.service
            script_args["environment"] = cfg.env

        result = await call_tool_safe(
            self.mcp, "generate_k6_script", script_args, verbose=cfg.verbose
        )
        return {"test_name": test_name, "script_name": result.get("script_name")}

    async def _analyze(
        self,
        results_file: str,
        snap_before: Optional[str],
        snap_after: Optional[str],
    ) -> tuple[dict, Optional[dict], dict, str]:
        cfg = self.config

        analysis = await call_tool_safe(
            self.mcp, "analyze_results",
            {"results_file": results_file},
            verbose=cfg.verbose,
        )
        self._ok(f"Grade: {analysis.get('performance_grade', '?')}")
        verdict = "PASS"

        # Optional: compare against baseline
        comparison = None
        if cfg.baseline:
            comparison = await call_tool_safe(
                self.mcp, "compare_baseline",
                {"current_results_file": results_file, "baseline_name": cfg.baseline},
                verbose=cfg.verbose,
            )
            verdict = comparison.get("verdict", "PASS")
            regressions = comparison.get("regressions", [])
            if regressions:
                self._log(f"  [red]✗[/red]  Regressions: {', '.join(regressions)}")
            else:
                self._ok(f"No regressions vs '{cfg.baseline}'")

        # Optional: save as new baseline
        if cfg.save_as:
            await call_tool_safe(
                self.mcp, "save_baseline",
                {
                    "results_file": results_file,
                    "baseline_name": cfg.save_as,
                    "metadata": {"service": cfg.service, "environment": cfg.env},
                },
                verbose=cfg.verbose,
            )
            self._ok(f"Saved as baseline '{cfg.save_as}'")

        # Generate Markdown report
        report_args: dict = {
            "results_file": results_file,
            "service_name": cfg.service,
            "environment": cfg.env,
        }
        if cfg.baseline:
            report_args["baseline_name"] = cfg.baseline
        snapshot_paths = [p for p in [snap_before, snap_after] if p]
        if snapshot_paths:
            report_args["metrics_snapshots"] = snapshot_paths

        report = await call_tool_safe(
            self.mcp, "generate_report", report_args, verbose=cfg.verbose
        )
        return analysis, comparison, report, verdict

    # ── Main entry point ──────────────────────────────────────────────────────

    async def run(self) -> PipelineResult:
        cfg = self.config

        self._step(1, 6, "Discovering endpoints...")
        discovery = await self._discover()
        self._ok(
            f"{len(discovery['endpoints'])} endpoint(s) | "
            f"{discovery['eff_users']} users | {discovery['eff_duration']}s"
        )

        self._step(2, 6, "Generating k6 script...")
        script = await self._generate_script(discovery)
        self._ok(script["script_name"])

        self._step(3, 6, "Capturing pre-test metrics...")
        snap_before = await take_snapshot(
            self.mcp, discovery["base_url"], cfg.service, "before", cfg.verbose
        )
        self._ok("Metrics captured") if snap_before else self._warn("No metrics endpoint — skipping")

        self._step(4, 6, "Running load test...")
        run_result = await call_tool_safe(
            self.mcp, "run_k6_test",
            {"script_name": f"{script['test_name']}.js"},
            verbose=cfg.verbose,
        )
        self._ok(f"Status: {run_result.get('status')}")
        results_file = run_result.get("results_file", "")

        self._step(5, 6, "Capturing post-test metrics...")
        snap_after = await take_snapshot(
            self.mcp, discovery["base_url"], cfg.service, "after", cfg.verbose
        )
        self._ok("Metrics captured") if snap_after else self._warn("No metrics endpoint — skipping")

        self._step(6, 6, "Analyzing results...")
        analysis, comparison, report, verdict = await self._analyze(
            results_file, snap_before, snap_after
        )

        return PipelineResult(
            analysis=analysis,
            comparison=comparison,
            report=report,
            verdict=verdict,
        )
