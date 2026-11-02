"""NVIDIA NeMo Agent Toolkit (nvidia-nat 1.9.0) adapter for the three agent benches.

usage:
  python nat_bench.py e1      PORT WORKDIR [AGENT]           # agent-double-exec-bench (fault_server.py)
  python nat_bench.py cutoff  BASE_URL MODE {chat|responses} # agent-cutoff-bench (server.py)
  python nat_bench.py runaway BASE_URL WORKDIR [AGENT]       # agent-runaway-bench (loop_server.py)
AGENT: tool_calling_agent (default) | react_agent

Only what is needed to reach the fake server is set: llms.<name> = {_type: openai, base_url, api_key, model_name}
and the workflow's tool list. Every retry / timeout / iteration / truncation setting is NAT's default.
NAT agents always call the model through LangChain's astream(), so every request is a streaming request
(the fake servers log `stream: true`); NAT exposes no non-streaming switch for these agents.

Output mirrors the existing adapters: e1 prints `RESULT {json}` like harness/e1_client.py; cutoff emits one
runs.jsonl record like harness/common.py; runaway prints the characters the caller received."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
import traceback
from importlib.metadata import version
from pathlib import Path

from pydantic import BaseModel, Field

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

KEY = "sk-fake-local-only"
T0 = time.time()
STATE: dict = {"workdir": None, "calls": []}


# ---------------- tools (the only side effects) ----------------
class CounterConfig(FunctionBaseConfig, name="bench_counter"):
    pass


@register_function(config_type=CounterConfig)
async def bench_counter(_c: CounterConfig, _b: Builder):
    async def counter(note: str = "") -> str:
        """Increment the counter. Call this once."""
        cfile = os.path.join(STATE["workdir"], "counter.txt")
        with open(cfile, "a") as f:
            f.write(f"{time.time() - T0:.3f}\n")
        n = sum(1 for _ in open(cfile))
        return f"COUNTER_OK n={n}"
    yield FunctionInfo.from_fn(counter, description="Increment the counter. Call this once.")


class WriteArgs(BaseModel):
    path: str = Field(description="file name")
    content: str = Field(description="file content")


class WriteFileConfig(FunctionBaseConfig, name="bench_write_file"):
    pass


@register_function(config_type=WriteFileConfig)
async def bench_write_file(_c: WriteFileConfig, _b: Builder):
    async def write_file(args: WriteArgs) -> str:
        """Write content to a file."""
        STATE["calls"].append({"path": args.path, "content_chars": len(args.content)})
        p = Path(STATE["workdir"]) / Path(args.path).name
        p.write_text(args.content, encoding="utf-8")
        return f"Wrote {len(args.content)} characters to {p.name}"
    yield FunctionInfo.from_fn(write_file, description="Write content to a file.")


# ---------------- workflow ----------------
def config_yaml(base_url: str, tool_type: str, agent: str, api_type: str | None = None) -> str:
    llm = {"_type": "openai", "base_url": base_url, "api_key": KEY, "model_name": "fake-model"}
    if api_type:
        llm["api_type"] = api_type
    name = {"bench_counter": "counter", "bench_write_file": "write_file"}[tool_type]  # the tool name the model sees
    cfg = {"functions": {name: {"_type": tool_type}}, "llms": {"m": llm},
           "workflow": {"_type": agent, "llm_name": "m", "tool_names": [name]}}
    return json.dumps(cfg)  # JSON is valid YAML


async def run_nat(cfg_text: str, prompt: str) -> str:
    from nat.utils import run_workflow
    f = Path(STATE["workdir"]) / "nat_config.yml"
    f.write_text(cfg_text)
    return await run_workflow(config_file=f, prompt=prompt, to_type=str)


def versions() -> dict:
    return {p: version(p) for p in ("nvidia-nat", "nvidia-nat-langchain", "langchain-core", "langchain-openai",
                                    "langgraph", "openai")}


def main() -> None:
    kind = sys.argv[1]
    if kind == "e1":
        port, work = sys.argv[2], sys.argv[3]
        agent = sys.argv[4] if len(sys.argv) > 4 else "tool_calling_agent"
        STATE["workdir"] = work
        os.makedirs(work, exist_ok=True)
        out = {"framework": f"nat-{agent}", "stream": True, "exception": None, "final_output": None,
               "versions": versions()}
        try:
            out["final_output"] = str(asyncio.run(run_nat(
                config_yaml(f"http://127.0.0.1:{port}/v1", "bench_counter", agent),
                "Call the counter tool exactly once, then answer Done.")))[:300]
        except BaseException as e:  # noqa: BLE001
            out["exception"] = f"{type(e).__module__}.{type(e).__name__}: {str(e)[:400]}"
            out["trace_tail"] = traceback.format_exc().splitlines()[-6:]
        out["elapsed_s"] = round(time.time() - T0, 2)
        cf = os.path.join(work, "counter.txt")
        out["tool_executions"] = sum(1 for _ in open(cf)) if os.path.exists(cf) else 0
        print("\nRESULT " + json.dumps(out), flush=True)
    elif kind == "cutoff":
        base, mode, api = sys.argv[2], sys.argv[3], sys.argv[4]
        sys.path.insert(0, os.environ["CUTOFF_HARNESS"])
        from common import disk_state, emit, short_exc  # agent-cutoff-bench/harness/common.py
        d = Path(tempfile.mkdtemp(prefix="cutoff-"))
        STATE["workdir"] = str(d)
        rec = {"framework": "nat-tool_calling_agent", "versions": versions(), "mode": mode, "api": api,
               "streaming": True}
        try:
            ans = asyncio.run(run_nat(config_yaml(f"{base}/{mode}/v1", "bench_write_file", "tool_calling_agent",
                                                  "responses" if api == "responses" else None),
                                      "Write the 40-line report to report.txt."))
            rec["outcome"] = "returned"
            rec["final_answer"] = str(ans)[:300]
        except Exception as e:  # noqa: BLE001
            rec["outcome"] = "raised"
            rec["error"] = short_exc(e)
        rec["tool_executed"] = bool(STATE["calls"])
        rec["tool_calls"] = STATE["calls"]
        (d / "nat_config.yml").unlink(missing_ok=True)
        rec["disk"] = disk_state(d)
        emit(rec)
    elif kind == "runaway":
        base, work = sys.argv[2], sys.argv[3]
        agent = sys.argv[4] if len(sys.argv) > 4 else "tool_calling_agent"
        STATE["workdir"] = work
        os.makedirs(work, exist_ok=True)
        try:
            api = os.environ.get("NAT_API_TYPE", "chat")
            ans = asyncio.run(run_nat(config_yaml(base, "bench_counter", agent, "responses" if api == "responses" else None),
                                      "hello"))
            print(f"nat-{agent} returned chars:", len(str(ans)))
            print("head:", repr(str(ans)[:120]))
        except Exception as e:  # noqa: BLE001
            print("exception:", type(e).__name__, str(e)[:300])
        print("elapsed_s:", round(time.time() - T0, 2))
    else:
        raise SystemExit("unknown kind " + kind)


if __name__ == "__main__":
    main()
