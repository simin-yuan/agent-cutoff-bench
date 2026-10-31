// LangGraph.js prebuilt ReAct agent + @langchain/openai against the fake server.
// usage: node run_langgraphjs.mjs BASE_URL MODE {chat|responses} {stream|nostream}
import { mkdtempSync, writeFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createRequire } from "node:module";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI, BaseChatOpenAI, ChatOpenAICompletions } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

const require = createRequire(import.meta.url);

// Offline bench: the streaming Chat Completions path estimates token usage with a
// tokenizer it downloads at runtime. Stub only that estimate so the run needs no
// network; it does not touch message parsing or tool-call handling.
for (const k of ["_getEstimatedTokenCountFromPrompt", "_getNumTokensFromGenerations"]) {
  for (const C of [BaseChatOpenAI, ChatOpenAICompletions]) if (typeof C.prototype[k] === "function") C.prototype[k] = async () => 0;
}
const [base, mode, api, streaming, rawPolicy] = process.argv.slice(2);
const d = mkdtempSync(join(tmpdir(), "cutoff-"));
const calls = [];
let successfulWrites = 0;
let observedMessages;
const inputSchema = z.object({ path: z.string(), content: z.string() });
const policy = rawPolicy ? await import("./raw_policy.mjs")
  .then(({ createRawPolicy }) => createRawPolicy(rawPolicy, inputSchema)) : undefined;

const writeFile = tool(
  async (input, config) => {
    const { path, content } = policy ? policy.take(input, config) : input;
    calls.push({ path, content_chars: content.length });
    writeFileSync(join(d, basename(path)), content, "utf8");
    successfulWrites++;
    return `Wrote ${content.length} characters to ${basename(path)}`;
  },
  { name: "write_file", description: "Write content to a file.",
    schema: inputSchema },
);

const llm = new ChatOpenAI({
  model: "bench-model", apiKey: "sk-bench", streaming: streaming === "stream",
  useResponsesApi: api === "responses", maxRetries: 0,
  configuration: { baseURL: `${base}/${mode}/v1`, ...(policy ? { fetch: policy.fetch } : {}) },
});
const agent = createReactAgent({ llm, tools: [writeFile] });

const ver = (p) => require(`${p}/package.json`).version;
const rec = { run_id: process.env.BENCH_RUN_ID ?? null, framework: "langgraph-js",
  versions: Object.fromEntries(["@langchain/core", "@langchain/openai", "@langchain/langgraph"].map((p) => [p, ver(p)])),
  mode, api, streaming: streaming === "stream" };
try {
  const out = await agent.invoke({ messages: [{ role: "user", content: "Write the 40-line report to report.txt." }] },
                                 { recursionLimit: 6 });
  const ai = out.messages.filter((m) => m._getType() === "ai");
  if (policy) observedMessages = {
    sdk_tool_calls: ai.flatMap((m) => (m.tool_calls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args }))),
    tool_messages: out.messages.filter((m) => m._getType() === "tool")
      .map((m) => ({ id: m.tool_call_id, name: m.name, status: m.status ?? null, content: m.content })),
  };
  rec.outcome = "returned";
  const c = ai.length ? ai[ai.length - 1].content : "";
  rec.final_answer = (typeof c === "string" ? c : JSON.stringify(c)).slice(0, 200);
  rec.invalid_tool_calls = ai.reduce((n, m) => n + (m.invalid_tool_calls?.length ?? 0), 0);
  rec.tool_messages = out.messages.filter((m) => m._getType() === "tool").map((m) => String(m.content).slice(0, 200));
} catch (e) {
  rec.outcome = "raised";
  rec.error = `${e?.constructor?.name}: ${String(e?.message ?? e).slice(0, 240)}`;
}
rec.tool_executed = calls.length > 0;
const p = join(d, "report.txt");
if (existsSync(p)) {
  const data = readFileSync(p, "utf8");
  const lines = data.replace(/\n$/, "").split("\n");
  const last = lines[lines.length - 1];
  const nl = (data.match(/\n/g) || []).length;
  rec.disk = { file_written: true, bytes: Buffer.byteLength(data), newline_terminated_lines: nl, last_line: last,
               complete: nl === 40 && last.startsWith("line 40") };
} else rec.disk = { file_written: false };
if (policy) rec.raw_policy = { ...policy.report(), ...observedMessages,
  successful_writes: successfulWrites, write_attempts: calls.length };
const line = JSON.stringify(rec);
console.log(line);
if (process.env.BENCH_RESULT) appendFileSync(process.env.BENCH_RESULT, line + "\n");
