"""Cut-off tool call with `llms: {_type: nim}` (ChatNVIDIA) against the local mock.
Reuses the 11-02 adapter's write_file tool (imported, not edited). Emits one JSON record: tool ran, lines on disk,
final output, and the response_metadata of the accumulated streamed message from the same NAT-built client.
usage: ADAPTER_DIR=... CUTOFF_HARNESS=... python nim_cutoff.py BASE_URL MODE"""
import asyncio, json, os, sys, tempfile
from importlib.metadata import version
from pathlib import Path
sys.path.insert(0, os.environ["ADAPTER_DIR"]); sys.path.insert(0, os.environ["CUTOFF_HARNESS"])
import nat_bench as nb  # noqa: E402
from common import disk_state, short_exc  # noqa: E402

base, mode = sys.argv[1], sys.argv[2]
d = Path(tempfile.mkdtemp(prefix="nim-cutoff-")); nb.STATE["workdir"] = str(d)
llm_cfg = {"_type": "nim", "base_url": f"{base}/{mode}/v1", "api_key": "nvapi-fake-local-only", "model_name": "bench-model"}
cfg = {"functions": {"write_file": {"_type": "bench_write_file"}}, "llms": {"m": llm_cfg},
       "workflow": {"_type": "tool_calling_agent", "llm_name": "m", "tool_names": ["write_file"]}}
rec = {"framework": "nat-tool_calling_agent-nim", "mode": mode,
       "versions": {p: version(p) for p in ("nvidia-nat-core", "nvidia-nat-langchain", "langchain-nvidia-ai-endpoints",
                                            "langchain-core")}}
try:
    rec["final_output"] = str(asyncio.run(nb.run_nat(json.dumps(cfg), "Write the 40-line report to report.txt.")))[:200]
    rec["outcome"] = "returned"
except Exception as e:  # noqa: BLE001
    rec["outcome"], rec["error"] = "raised", short_exc(e)
rec["tool_executed"] = bool(nb.STATE["calls"]); rec["tool_calls"] = nb.STATE["calls"]
(d / "nat_config.yml").unlink(missing_ok=True); rec["disk"] = disk_state(d)


async def metadata():
    from langchain_core.tools import tool
    from nat.builder.framework_enum import LLMFrameworkEnum
    from nat.builder.workflow_builder import WorkflowBuilder
    from nat.llm.nim_llm import NIMModelConfig

    @tool
    def write_file(path: str, content: str) -> str:
        """Write content to a file."""
        return "x"
    async with WorkflowBuilder() as b:
        await b.add_llm("m", NIMModelConfig(**{k: v for k, v in llm_cfg.items() if k != "_type"}))
        llm = await b.get_llm("m", wrapper_type=LLMFrameworkEnum.LANGCHAIN)
        acc = None
        try:
            async for c in llm.bind_tools([write_file]).astream("Write the 40-line report to report.txt."):
                acc = c if acc is None else acc + c
        except Exception as e:  # noqa: BLE001
            return {"stream_error": short_exc(e), "partial": None if acc is None else dict(acc.response_metadata)}
        return {"response_metadata": dict(acc.response_metadata),
                "tool_call_content_chars": [len(t["args"].get("content", "")) for t in acc.tool_calls],
                "invalid_tool_calls": len(acc.invalid_tool_calls)}
rec["probe"] = asyncio.run(metadata())
print("RECORD " + json.dumps(rec, default=str))
