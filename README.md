# agent-cutoff-bench

**Does your agent run a tool call whose arguments were cut off?**

When a model streams a long tool call (a file to write, a command to run) and the
output hits its token limit or the stream closes early, the arguments arrive
incomplete. The safe thing is to not run that call. This bench checks what agent
frameworks actually do, using a fake model server that cuts the same tool call
the same way for every client.

## Result

The "model" asks to write a 40-line file. Its arguments stop in the middle of
line 17. The tool really writes to disk; the bench then reads the file back.

| Framework | API | Streaming | `complete` | `length` | `drop` | `reset` |
|---|---|---|---|---|---|---|
| LangGraph (Python) | Chat Completions | yes | ran, full file | **RAN: 16 of 40 lines** | **RAN: 16 of 40 lines** | not run |
| LangGraph (Python) | Chat Completions | no | ran, full file | not run | not run | not run |
| LangGraph (Python) | Responses | yes | ran, full file | **RAN: 16 of 40 lines** | **RAN: 16 of 40 lines** | not run |
| LangGraph (Python) | Responses | no | ran, full file | not run | not run | not run |
| LangGraph.js | Chat Completions | yes | ran, full file | **RAN: 16 of 40 lines** | **RAN: 16 of 40 lines** | not run |
| LangGraph.js | Chat Completions | no | ran, full file | not run | not run | not run |
| LangGraph.js | Responses | yes | ran, full file | **RAN: 16 of 40 lines** | **RAN: 16 of 40 lines** | not run |
| LangGraph.js | Responses | no | ran, full file | not run | not run | not run |
| OpenAI Agents SDK | Chat Completions | yes | ran, full file | not run | not run | not run |
| OpenAI Agents SDK | Chat Completions | no | ran, full file | not run | not run | not run |
| OpenAI Agents SDK | Responses | yes | ran, full file | not run | not run | not run |
| OpenAI Agents SDK | Responses | no | ran, full file | not run | not run | not run |
| smolagents | Chat Completions | yes | ran, full file | not run | not run | not run |
| smolagents | Chat Completions | no | ran, full file | not run | not run | not run |
| Codex CLI (`codex exec`) | Responses | yes | ran, full file | not run | not run | not run |
| Hermes Agent (control) | Chat Completions | yes | ran, full file | not run | not run | not run |

Generated from [`results/runs.jsonl`](results/runs.jsonl) by `python summarize.py results/runs.jsonl`.
The `complete` column is the control: every client runs the full call, so the
bench can see execution when it happens. In the `reset` column every client
was run; "not run" means the connection error stopped the call.

In every **RAN** cell the same thing happens:

- `report.txt` holds 16 complete lines plus `line 17: the quick` (866 bytes
  instead of 2,120);
- the tool reports `Wrote 866 characters to report.txt`, and that result is
  sent back to the model (the server log of each run records it);
- the agent finishes normally with `Done.` No error is raised anywhere.

The same LangGraph code with streaming turned off does not run the call. So
whether a cut-off write lands on disk depends only on the streaming flag.

## The four cut-off modes

| Mode | What the server sends |
|---|---|
| `complete` | Full arguments, `finish_reason: tool_calls` (Responses: `response.completed`). Control. |
| `length` | Arguments cut mid-line, then `finish_reason: length` (Responses: `response.incomplete`, reason `max_output_tokens`). This is what an output-token limit looks like. |
| `drop` | Arguments cut mid-line, then the HTTP body ends cleanly: no `finish_reason`, no `[DONE]`, no `response.completed`. This is what a proxy or server closing the stream early looks like. |
| `reset` | Arguments cut mid-line, then the TCP connection is closed without finishing the body. No client runs the call; most raise a connection error. |

Non-streaming `drop` and `reset` send half of the JSON body and close; every
client raises an error and runs nothing.

## Why LangChain runs it

Both LangChain implementations build the final tool calls of a streamed message
with a partial-JSON parser, which is meant for showing arguments while they are
still arriving. After the stream has ended, nothing more can arrive, but the
same parser still turns `{"content": "line 01…line 17: the quick` into a valid
argument object.

- **Python**, `langchain-core` 1.6.12: `AIMessageChunk.init_tool_calls` calls
  `parse_partial_json` (`langchain_core/messages/ai.py`, line 557). When a stream
  ends, `BaseChatModel` appends a final chunk with `chunk_position="last"`
  (`language_models/chat_models.py`, lines 827 and 963), and the aggregated
  message is validated again with the same partial parser. On the
  non-streaming path, `langchain-openai` parses the same arguments with
  `json.loads` and reports them as `invalid_tool_calls`. In the same file,
  server tool calls are already parsed with `json.loads` once the stream ends
  (`init_server_tool_calls`; if that fails, the block is left as it is). The
  output-parser path draws the same line explicitly: `parse_tool_call` uses
  `parse_partial_json` only when the caller passes `partial=True`, and
  otherwise uses `json.loads` and raises `OutputParserException`
  (`output_parsers/openai_tools.py`, lines 52–69). The streaming tool-call path
  is the one place where the partial parse reaches a finished message.
- **JavaScript**, `@langchain/core` 1.2.18: `collapseToolCallChunks` calls
  `parsePartialJson` (`src/messages/utils.ts`, line 634 at `11bd193`). The
  truncated call in the LangGraph.js runs above comes out of this function.

A self-contained reproduction that needs no server is in
[`fix/langchain-core/repro.py`](fix/langchain-core/repro.py).

## Fix status

- **Python:** reported in [langchain#41285](https://github.com/langchain-ai/langchain/issues/41285)
  (October 17, 2026). A patch in [#41286](https://github.com/langchain-ai/langchain/pull/41286)
  (not merged) re-parses the arguments with `json.loads` inside
  `message_chunk_to_message`.

  The patch in [`fix/langchain-core/`](fix/langchain-core/) does the check in
  `AIMessageChunk.init_tool_calls` instead, once `chunk_position == "last"`,
  using `json.loads(..., strict=False)` like the non-streaming parser; a call
  that fails goes to `invalid_tool_calls` with the parse error, and mid-stream
  parsing is unchanged. That placement matters in three cases, which
  [`fix/langchain-core/edge_cases.py`](fix/langchain-core/edge_cases.py) checks
  on any build:

  | Case | 1.6.12 | #41286 (`5e75fa5`) | this patch |
  |---|---|---|---|
  | Complete call whose string holds a raw newline (accepted without streaming) | runs | **marked invalid** | runs |
  | Cut-off call read from summed chunks (`full = full + chunk`) | looks valid | **looks valid** | invalid |
  | Cut-off call returned by `invoke()` | looks valid | invalid | invalid |
  | Two calls in one stream, one complete and one cut off, read from summed chunks | both run | both run | only the complete one |

  The patch applies to `langchain-ai/langchain` at `d670a3a` (October 19, 2026);
  `git apply --check` against the files from that commit is clean.
  `libs/core/langchain_core/messages/ai.py` there has the same SHA-256 as the
  file shipped in 1.6.12
  (`3a41fb1c38115bae737a1131e187177b46e665a48cc810117bf707058521bf0e`), and
  no commit has touched it since October 1, so no rebase is needed. It adds 7
  tests; without the patch 4 of them fail. In `tests/unit_tests/messages/test_ai.py`
  that is 19 passed / 4 failed without the patch and 23 passed with it.

  Full `langchain-core` unit suite, with and without the patch, on two machines:

  - Linux, CPython 3.14: 2,383 passed with the patch and 2,376 without; the
    same 9 tests fail both ways, all because the machine could not resolve
    DNS. `make lint` (ruff, ruff format, mypy) passes.
  - Windows 11, CPython 3.11: 2,376–2,377 passed with the patch and 2,369
    without. The failures are the same set both ways: three symlink tests
    that need `SeCreateSymbolicLinkPrivilege`, two indexing tests, and a
    timing-sensitive rate-limit test that also fails intermittently on its
    own. None is in message parsing.

  With the patch, the LangGraph rows above become "not run"
  for `length` and `drop`: [`results/with-core-fix/`](results/with-core-fix/).
- **JavaScript:** reported in [langchainjs#11469](https://github.com/langchain-ai/langchainjs/issues/11469).
  [#11494](https://github.com/langchain-ai/langchainjs/pull/11494) (not merged)
  changes `ChatModelStream` when `finishReason === "length"`; it does not touch
  `collapseToolCallChunks`, and a `drop` has no finish reason.

## Run it yourself

No API key and no network access to a model are needed.

```bash
git clone https://github.com/simin-yuan/agent-cutoff-bench
cd agent-cutoff-bench
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
(cd harness/js && npm install)          # optional: LangGraph.js rows
PY=python OUT_DIR=results-local ./run_all.sh
```

`run_all.sh` starts a fresh server for each run, writes one line per run to
`results-local/runs.jsonl` and every request the server saw to
`results-local/logs/<run>.jsonl`, then prints the table. Codex and Hermes rows
run when `CODEX=/path/to/codex` and `HERMES=/path/to/hermes` are set.

To run one client by hand:

```bash
python server.py 8765 &
cd harness && python run_langgraph.py http://127.0.0.1:8765 length chat stream
```

An optional [raw-admission comparison](harness/js/RAW_POLICY.md) uses this
benchmark's actual LangGraph.js agent and file-writing tool with native,
small raw-native and published PSJ core 0.6.3 checks. Run
`npm ci --ignore-scripts --strict-peer-deps --no-audit --no-fund` and
`npm run test:raw-policy` in `harness/js` (Node 22+ and Python 3).
It keeps the existing LangChain pins, server modes and default matrix.
The earlier AI SDK-only proposal remains in commit `e28b5c4`; it already
prevented these writes and did not address this benchmark's LangGraph path.
See [measured results and limitations](harness/js/RESULTS.md).

## Versions

| Client | Version |
|---|---|
| LangGraph (Python) | langgraph 1.2.16, langchain-core 1.6.12, langchain-openai 1.7.2 |
| LangGraph.js | @langchain/langgraph 1.5.1, @langchain/core 1.2.18, @langchain/openai 1.6.2 |
| OpenAI Agents SDK | openai-agents 0.24.0, openai 3.35.1 |
| smolagents | 1.26.0 |
| Codex CLI | 0.163.0 (`wire_api = "responses"`, `stream_max_retries = 1`) |
| Hermes Agent | `6e9b3e3` (custom OpenAI-compatible endpoint, `hermes -z`) |

Each run records its versions in `results/runs.jsonl`.

## What the other clients do instead

- **OpenAI Agents SDK:** on Chat Completions it sends the model a generic tool
  result, `An error occurred while running the tool. Please try again.`, and
  continues; on Responses it raises `ModelBehaviorError` for `length` and `drop`.
- **smolagents:** does not run the call and asks the model again on the next
  step; with this harness's `max_steps=2` the run ends without an answer.
- **Codex CLI:** `length` stops with `Incomplete response returned, reason: max_output_tokens`;
  `drop` and `reset` retry once, then stop with `stream disconnected before completion`.
- **Hermes Agent:** retries the call, then stops without running it. For
  `length` it tells the user the reply was cut off and nothing was changed.
  For `reset` it was still retrying when the 180-second harness timeout ended
  the run; nothing was written.

## Limits

- The server is fake. It models the wire formats, not any real provider's
  behaviour; it shows what each client does when it receives these streams.
- One tool and one cut point. The bench does not measure how often real
  streams are cut off.
- Only OpenAI-compatible wire formats (Chat Completions and Responses).
- For Responses `length`, the server sends `response.incomplete` right after
  the last argument delta, without `function_call_arguments.done` or
  `output_item.done`.
- The LangGraph.js harness replaces two token-count estimates in
  `@langchain/openai` with 0, because the streaming path downloads a tokenizer
  at runtime and the bench runs offline. This does not touch message parsing
  or tool calls.
- After the fix, a streamed LangGraph run with a cut-off call ends with an
  empty answer, exactly as the non-streaming run already does. How an agent
  should surface `invalid_tool_calls` to the user is outside this bench.
- The fix is in the parser, and LangGraph has no second line of defence:
  `libs/prebuilt/langgraph/prebuilt/tool_node.py` at
  `langchain-ai/langgraph` `main` (October 19, 2026) contains no reference to
  `finish_reason`, `invalid_tool_calls`, or truncation — it runs whatever is in
  `message.tool_calls`. So any path that produces a well-formed-looking
  truncated call still runs. Checking `finish_reason` in the agent layer is a
  separate change, not covered here.

## Write-up

[writeup.md](writeup.md) tells the story in plain language.

## Related

[agent-runaway-bench](https://github.com/simin-yuan/agent-runaway-bench) uses
the same fake-server method for a different failure: a reply that turns into a
repetition loop and is never cut.

## Record

- Discovered: 2026-10-19
- First reported upstream: langchain#41285 by @taguacil (2026-10-17)
- First public: 2026-10-19
- Patch commit: `c998c402b045` (on `simin-yuan/langchain`, branch `core/truncated-streamed-tool-calls`; not merged upstream)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
