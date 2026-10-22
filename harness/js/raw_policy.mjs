// Finite benchmark helper, not a general LangChain/provider adapter.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function envelopes(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const data = text.split(/\r?\n\r?\n/).map((frame) => frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"))
    .filter(Boolean);
  const events = [];
  let error;
  for (const value of data.filter((item) => item !== "[DONE]")) {
    try { events.push(JSON.parse(value)); } catch (failure) { error = failure; break; }
  }
  return { done: data.includes("[DONE]"), events, error };
}

function rawCalls(events) {
  const calls = new Map(), finishes = new Map();
  for (const event of events) for (const choice of event.choices ?? []) {
    if (choice.finish_reason != null) finishes.set(choice.index, choice.finish_reason);
    for (const delta of choice.delta?.tool_calls ?? []) {
      const key = `${choice.index}:${delta.index}`;
      let call = calls.get(key);
      if (!call) {
        call = { index: delta.index, choice: choice.index, id: "", name: "", arguments: "" };
        calls.set(key, call);
      }
      if (delta.id !== undefined) {
        if (call.id && call.id !== delta.id) call.conflict = true;
        call.id = delta.id;
      }
      call.name += delta.function?.name ?? "";
      call.arguments += delta.function?.arguments ?? "";
    }
  }
  return [...calls.values()].map((call) => ({ ...call, finish: finishes.get(call.choice) ?? null }));
}

function nativeDecisions(calls, schema) {
  return calls.map((call) => {
    const row = { id: call.id, name: call.name, allowed: false };
    if (!Number.isSafeInteger(call.index) || call.index < 0 || !Number.isSafeInteger(call.choice) ||
        call.choice < 0 || call.conflict || !call.id || call.name !== "write_file" ||
        calls.filter((other) => other.id === call.id).length !== 1) return { ...row, reason: "identity" };
    if (!["tool_calls", "stop"].includes(call.finish)) return { ...row, reason: "stream-incomplete" };
    let value;
    try { value = JSON.parse(call.arguments); } catch { return { ...row, reason: "invalid-json" }; }
    const validation = schema.safeParse(value);
    if (!validation.success || !isDeepStrictEqual(validation.data, value)) return { ...row, reason: "schema" };
    return { ...row, allowed: true, reason: "complete", value };
  });
}

export async function createRawPolicy(client, schema) {
  if (!["native", "native-check", "psj"].includes(client)) throw new Error("Unknown raw policy client");
  // The native alternatives neither load nor invoke PSJ.
  const psj = client === "psj" ? {
    ...await import("prefix-safe-json"), ...await import("prefix-safe-json/standard-schema"),
  } : undefined;
  const observations = [], callbacks = [];
  let current;

  return {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      const request = { tool_result_ids: (body.messages ?? []).filter((m) => m.role === "tool").map((m) => m.tool_call_id),
        tool_results: (body.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content) };
      const chunks = [];
      let response, size = 0, transportError, transportPhase = "fetch";
      try {
        response = await fetch(url, init);
        if (!response.ok) throw new Error(`Unexpected benchmark HTTP status ${response.status}`);
        transportPhase = "read";
        const reader = response.body.getReader();
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1024 * 1024) throw new Error("Finite fixture exceeds 1 MiB");
          chunks.push(part.value);
        }
      } catch (error) { transportError = error; }
      const bytes = Buffer.concat(chunks);
      const wireFile = process.env.BENCH_CAPTURE_DIR ? `${observations.length + 1}.sse` : undefined;
      if (wireFile) writeFileSync(join(process.env.BENCH_CAPTURE_DIR, wireFile), bytes);
      const decoded = envelopes(bytes), calls = rawCalls(decoded.events);
      const record = { request, bytes: bytes.length, body_sha256: hash(bytes), wire_file: wireFile,
        eof: !transportError, done: decoded.done,
        response_received: Boolean(response), transport_phase: transportError ? transportPhase : null,
        transport_error: transportError ? `${transportError.name}: ${transportError.message}` : null,
        framing_error: decoded.error?.message ?? null,
        // Only volatile provider timestamps are omitted from this fingerprint.
        // Original bytes and envelopes supplied to both SDK/PSJ stay untouched.
        lifecycle_sha256: hash(JSON.stringify(decoded.events.map(({ created: _created, ...event }) => event))),
        arguments: calls.map((call) => ({ id: call.id, name: call.name, finish: call.finish,
          chars: call.arguments.length, sha256: hash(call.arguments) })), decisions: [] };
      observations.push(record);
      const consumed = new Set();
      if (psj) {
        const adapter = new psj.OpenAICompatibleStreamAdapter();
        const gate = psj.createToolCallExecutionGate(undefined, undefined, undefined,
          { write_file: psj.fromStandardSchema(schema) });
        for (const event of decoded.events) for (const normalized of adapter.push(event)) gate.push(normalized);
        for (const normalized of adapter.finish(transportError ? { reason: "network_error" } : undefined)) gate.push(normalized);
        const result = gate.finish();
        record.decisions = result.decisions.map((d) => ({ id: d.toolCallId, name: d.name,
          allowed: d.executable, reason: d.reason }));
        current = { take: (id, name) => {
          const decisions = result.decisions.filter((d) => d.toolCallId === id && d.name === name);
          if (decisions.length !== 1) return undefined;
          const grant = gate.takeDecision(decisions[0].internalId);
          if (grant && gate.takeDecision(decisions[0].internalId)) throw new Error("Authority reused");
          return grant;
        } };
      } else if (client === "native-check") {
        const decisions = nativeDecisions(calls, schema);
        record.decisions = decisions.map(({ value: _value, ...decision }) => decision);
        current = { take: (id, name) => {
          const rows = decisions.filter((d) => d.id === id && d.name === name);
          if (rows.length !== 1 || !rows[0].allowed || consumed.has(id)) return undefined;
          consumed.add(id);
          return rows[0];
        } };
      } else {
        current = undefined;
      }
      // Every client drains the same body before SDK parsing. A read error is
      // retained and rethrown, never turned into a completed replacement body.
      if (transportError) throw transportError;
      if (decoded.error) throw decoded.error;
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
    take: (input, config) => {
      const id = config?.toolCall?.id, name = config?.toolCall?.name;
      const attempt = { id, name, projection: input, allowed: client === "native" };
      callbacks.push(attempt);
      if (client === "native") return input;
      const grant = current?.take(id, name);
      if (!grant || !isDeepStrictEqual(grant.value, input)) {
        attempt.reason = grant ? "projection-conflict" : "no-authority";
        throw new Error(`Raw argument admission refused: ${attempt.reason}`);
      }
      attempt.allowed = true;
      return grant.value;
    },
    report: () => ({ client, observations, callbacks }),
  };
}
