"""Print the results table (Markdown) from a runs.jsonl file.

usage: python summarize.py results/runs.jsonl
"""
from __future__ import annotations

import json
import sys

MODES = ["complete", "length", "drop", "reset"]
NAMES = {
    "langgraph": "LangGraph (Python)",
    "langgraph-js": "LangGraph.js",
    "openai-agents": "OpenAI Agents SDK",
    "smolagents": "smolagents",
    "codex-cli": "Codex CLI (`codex exec`)",
    "hermes-agent": "Hermes Agent (control)",
    "nat": "NeMo Agent Toolkit (`tool_calling_agent`)",
    "nat-nim": "NeMo Agent Toolkit (`tool_calling_agent`, `_type: nim`)",
}


def cell(r: dict) -> str:
    d = r["disk"]
    if r["tool_executed"] or d.get("file_written"):
        if d.get("complete"):
            return "ran, full file"
        return f"**RAN: {d['newline_terminated_lines']} of 40 lines**"
    return "not run"


def main(path: str) -> None:
    rows: dict[tuple, dict] = {}
    for line in open(path, encoding="utf-8"):
        r = json.loads(line)
        key = (r["framework"], r["api"], r["streaming"])
        rows.setdefault(key, {})[r["mode"]] = r
    order = list(NAMES)
    keys = sorted(rows, key=lambda k: (order.index(k[0]) if k[0] in order else 99, k[1], not k[2]))
    print("| Framework | API | Streaming | " + " | ".join(f"`{m}`" for m in MODES) + " |")
    print("|---|---|---|" + "---|" * len(MODES))
    for k in keys:
        fw, api, streaming = k
        cells = [cell(rows[k][m]) if m in rows[k] else "–" for m in MODES]
        api_name = "Chat Completions" if api == "chat" else "Responses"
        print(f"| {NAMES.get(fw, fw)} | {api_name} | {'yes' if streaming else 'no'} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "results/runs.jsonl")
