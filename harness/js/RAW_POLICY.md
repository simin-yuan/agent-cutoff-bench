# Optional raw-argument policy comparison

Admission and zero-write expectations were committed before measurement,
October 22, 2026. After the first failed run, transport-receipt instrumentation
was corrected; that failure remains in the results record. This extends the
existing LangGraph.js runner, not a production adapter or a new model fixture.

Use the unchanged `server.py` modes and actual `ChatOpenAI → createReactAgent
→ write_file → writeFileSync` path. Three clients share the same installed
SDK versions, tool schema, prompt, buffered raw-response observation and disk
checks: native, a small native raw check, and published PSJ core 0.6.3.

- `complete`: one 2,120-byte, 40-line write; original `call_bench_1` in the
  callback and continuation; two model requests; final `Done.`.
- `length` and `drop`: strict paths must write no file. Observe the native
  result without changing it. Check strict original JSON, the real tool
  schema, call identity and terminal evidence before the actual write.
- `reset`: all paths must write no file; preserve the actual received bytes
  (possibly zero) and the first transport error instead of presenting a
  completed response. Record whether failure preceded headers or occurred
  during body reading.

Admission is per call, matched by original ID, name and exact JSON value;
each grant is consumed once. Do not reject an entire response merely because
one call lacks authority. These four fixtures each contain one call, so they
do not certify multi-call behavior. No new sibling case is added.

The small native check has the same raw evidence and schema as PSJ. Equal
results are valid and must remain visible. No maintenance-cost superiority
is assumed. This is not a substitute for LangChain's native strict-final-JSON
fix or a claim that adding a dependency is necessary.

The barrier runs before `calls.push` and the real write. A rejected callback
may become a LangGraph error tool-result and the fake server may still answer
`Done.`. Record that continuation; zero writes does not mean a successful
write, zero callback attempts, or no follow-up request.

Keep complete response hashes and compare argument/lifecycle hashes across
clients. The server's `created` timestamp may vary between requests; exclude
only that field from the comparison fingerprint, never from the actual bytes
fed to either the SDK or policy. Apply paired identity assertions to complete,
length and drop. Real TCP reset delivery can differ between clients, so its
three runs are transport controls, not identical-delivered-input evidence.
The fixture data is authored; no live-model frequency, independent PSJ
adoption or production integration is claimed.

See [executed results and the short trial instructions](RESULTS.md).
