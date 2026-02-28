"""
Configuration loader — merges config/defaults.yaml with environment variable overrides.

Priority order (highest wins):
  1. CLI flags  (passed as override dict)
  2. Environment variables  (PERF_* namespace)
  3. config/defaults.yaml
  4. In-code fallbacks
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import yaml

PROJECT_ROOT = Path(__file__).parent.parent
DEFAULTS_PATH = PROJECT_ROOT / "config" / "defaults.yaml"

_defaults_cache: dict | None = None


def _load_raw_defaults() -> dict:
    """Load and cache config/defaults.yaml. Returns empty dict if file not found."""
    global _defaults_cache
    if _defaults_cache is None:
        if DEFAULTS_PATH.exists():
            with open(DEFAULTS_PATH) as f:
                _defaults_cache = yaml.safe_load(f) or {}
        else:
            _defaults_cache = {}
    return _defaults_cache


@dataclass
class AgentConfig:
    model: str
    max_iterations: int
    max_tokens: int


@dataclass
class TestRunConfig:
    service: str
    env: str
    users: Optional[int]
    duration: Optional[int]
    baseline: Optional[str]
    save_as: Optional[str]
    ci: bool
    verbose: bool


def load_agent_config() -> AgentConfig:
    """Load agent settings from defaults.yaml with in-code fallbacks."""
    a = _load_raw_defaults().get("agent", {})
    return AgentConfig(
        model=a.get("model", "claude-sonnet-4-6"),
        max_iterations=a.get("max_iterations", 30),
        max_tokens=a.get("max_tokens", 8192),
    )


def load_test_run_config(overrides: dict) -> TestRunConfig:
    """
    Build a TestRunConfig by merging CLI flags → env vars → defaults.
    CLI flags (values in `overrides`) always win over environment variables.
    """
    return TestRunConfig(
        service=overrides.get("service") or os.environ.get("PERF_SERVICE", ""),
        env=overrides.get("env") or os.environ.get("PERF_ENV", "local"),
        users=overrides.get("users") or _int_or_none(os.environ.get("PERF_USERS")),
        duration=overrides.get("duration") or _int_or_none(os.environ.get("PERF_DURATION")),
        baseline=overrides.get("baseline") or os.environ.get("PERF_BASELINE"),
        save_as=overrides.get("save_as"),
        ci=overrides.get("ci", False),
        verbose=overrides.get("verbose", False),
    )


def _int_or_none(value: Optional[str]) -> Optional[int]:
    try:
        return int(value) if value else None
    except (ValueError, TypeError):
        return None
