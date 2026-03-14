"""
System prompts for the performance testing agent.

Prompt text lives in agent/prompts/*.txt — edit there, not here.
This file is a thin loader; it owns no prompt content.
"""

from pathlib import Path

_PROMPTS_DIR = Path(__file__).parent / "prompts"


def _load(filename: str) -> str:
    return (_PROMPTS_DIR / filename).read_text(encoding="utf-8").strip()


SYSTEM_PROMPT = _load("system_prompt.txt")
CI_MODE_PROMPT = _load("ci_mode_prompt.txt")
