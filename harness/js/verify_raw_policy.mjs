// Reuses the existing Python server and actual LangGraph.js runner.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "Node 22+ required for this optional comparison");
const output = process.env.BENCH_RESULT_DIR ? resolve(process.env.BENCH_RESULT_DIR) : mkdtempSync(join(tmpdir(), "langgraph-policy-"));
if (process.env.BENCH_RESULT_DIR) {
  assert.ok(!existsSync(output), "Use a new result directory; old evidence is never overwritten");
  mkdirSync(output, { recursive: true });
}
const python = process.env.PY ?? (process.platform === "win32" ? "python" : "python3");
const serverFile = fileURLToPath(new URL("../../server.py", import.meta.url));
const runner = fileURLToPath(new URL("./run_langgraphjs.mjs", import.meta.url));
const records = [];
writeFileSync(join(output, "records.jsonl"), "");

for (const mode of ["complete", "length", "drop", "reset"]) {
  for (const client of ["native", "native-check", "psj"]) {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((ok, fail) => reservation.close((error) => error ? fail(error) : ok()));
    const id = `${mode}-${client}`, directory = join(output, id);
    mkdirSync(directory);
    const log = join(directory, "server.jsonl");
    const server = spawn(python, [serverFile, String(port)], {
      env: { ...process.env, BENCH_LOG: log }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = new Promise((ok) => server.once("close", ok));
    let serverError, stderr = "";
    server.on("error", (error) => { serverError = error; });
    server.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4_000); });
    const base = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        if (serverError) throw serverError;
        if (server.exitCode !== null) throw new Error(`Benchmark server exited: ${stderr}`);
        try { ready = (await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(500) })).ok; }
        catch { /* The existing server may still be starting. */ }
        if (ready) break;
        await delay(100);
      }
      assert.ok(ready, `Existing Python server did not start: ${stderr}`);
      const result = spawnSync(process.execPath, [runner, base, mode, "chat", "stream", client], {
        encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, BENCH_RESULT: "", BENCH_CAPTURE_DIR: directory,
          LANGSMITH_TRACING: "false", LANGCHAIN_TRACING_V2: "false" },
      });
      writeFileSync(join(directory, "client.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`);
      assert.equal(result.status, 0, `${id}: runner failed: ${result.error ?? result.stderr}`);
      const lines = result.stdout.trim().split(/\r?\n/);
      const record = JSON.parse(lines[lines.length - 1]);
      record.server_requests = readFileSync(log, "utf8").trim().split(/\r?\n/).map(JSON.parse);
      records.push(record);
      writeFileSync(join(output, "records.jsonl"), records.map(JSON.stringify).join("\n") + "\n");
      const policy = record.raw_policy;
      assert.equal(policy.client, client);
      assert.equal(record.server_requests.length, policy.observations.length, `${id}: actual request count`);
      assert.ok(record.server_requests.every((r) => r.mode === mode && r.endpoint === "chat" && r.stream), `${id}: original server modes`);
      if (mode === "complete") {
        assert.equal(policy.successful_writes, 1, `${id}: actual successful write`);
        assert.equal(record.disk.file_written, true);
        assert.equal(record.disk.bytes, 2_120);
        assert.equal(record.disk.complete, true);
        assert.equal(record.final_answer, "Done.");
        assert.equal(policy.observations.length, 2);
        assert.deepEqual(policy.observations[1].request.tool_result_ids, ["call_bench_1"]);
        assert.deepEqual(policy.callbacks.map((c) => [c.id, c.name, c.allowed]), [["call_bench_1", "write_file", true]]);
        assert.equal(policy.tool_messages[0].status, "success");
        assert.match(record.server_requests[1].tool_result_seen, /^Wrote 2120 characters/);
      } else if (client !== "native" || mode === "reset") {
        assert.equal(policy.successful_writes, 0, `${id}: no guarded side effect`);
        assert.equal(policy.write_attempts, 0, `${id}: refusal before writeFileSync`);
        assert.equal(record.disk.file_written, false, `${id}: actual disk state`);
      } else {
        assert.equal(policy.successful_writes, 1, `${id}: observed native truncated write`);
        assert.equal(record.disk.bytes, 866, `${id}: existing repaired argument projection`);
        assert.equal(record.disk.complete, false);
      }
      if (["length", "drop"].includes(mode)) {
        assert.equal(record.outcome, "returned");
        assert.equal(record.final_answer, "Done.");
        assert.equal(policy.observations.length, 2, `${id}: actual tool-result continuation`);
        assert.deepEqual(policy.observations[1].request.tool_result_ids, ["call_bench_1"]);
        assert.equal(policy.tool_messages[0].status, client === "native" ? "success" : "error");
      }
      if (mode === "reset") {
        assert.equal(record.outcome, "raised");
        assert.ok(policy.observations[0].transport_error, `${id}: preserve first read error`);
        assert.equal(policy.observations[0].eof, false);
        assert.ok(["fetch", "read"].includes(policy.observations[0].transport_phase));
        if (!policy.observations[0].response_received) assert.equal(policy.observations[0].bytes, 0);
      }
      console.log(JSON.stringify({ mode, client, writes: policy.successful_writes,
        bytes: record.disk.bytes ?? 0, requests: record.server_requests.length, outcome: record.outcome,
        callback_attempts: policy.callbacks.length, final_answer: record.final_answer }));
    } finally {
      if (server.exitCode === null) server.kill();
      await exited;
    }
  }
  const group = records.filter((record) => record.mode === mode);
  assert.equal(new Set(group.map((r) => JSON.stringify(r.versions))).size, 1, `${mode}: identical installed SDK versions`);
  // An abrupt TCP reset can be observed before headers or during the body.
  // Preserve that real delivery difference; it is a transport control, not
  // evidence of identical delivered inputs across the three clients.
  if (mode !== "reset") {
    assert.equal(new Set(group.map((r) => r.raw_policy.observations[0].lifecycle_sha256)).size, 1,
      `${mode}: identical original lifecycle except provider created timestamp`);
    assert.equal(new Set(group.map((r) => JSON.stringify(r.raw_policy.observations[0].arguments))).size, 1,
      `${mode}: identical original argument hashes, IDs, names and finish reasons`);
  }
  const projection = (record) => ({ disk: record.disk, successful_writes: record.raw_policy.successful_writes,
    write_attempts: record.raw_policy.write_attempts, callbacks: record.raw_policy.callbacks,
    outcome: record.outcome, final_answer: record.final_answer, tool_messages: record.tool_messages,
    sdk_tool_calls: record.raw_policy.sdk_tool_calls, tool_result_details: record.raw_policy.tool_messages,
    requests: record.raw_policy.observations.map((r) => r.request) });
  assert.deepEqual(projection(group.find((r) => r.raw_policy.client === "native-check")),
    projection(group.find((r) => r.raw_policy.client === "psj")), `${mode}: compare real native-check / PSJ outcomes`);
}
const summary = { cases: records.length, versions: records[0].versions, node: process.version,
  modes: records.map((r) => ({ mode: r.mode, client: r.raw_policy.client,
    writes: r.raw_policy.successful_writes, bytes: r.disk.bytes ?? 0,
    requests: r.server_requests.length, final_answer: r.final_answer, outcome: r.outcome })),
  conclusion: "Measured native-check/PSJ equivalence; maintenance preference and independent use unverified",
  pairedModes: ["complete", "length", "drop"],
  resetControl: "Real TCP reset; observed delivery can differ; all clients must refuse before writes",
  output, timestampsExcludedFromFingerprintOnly: true, fixtures: "existing four single-call server modes" };
writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(`Verified ${records.length}/12 LangGraph.js cases; raw records and captures retained at ${output}`);
