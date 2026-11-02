#!/bin/sh
# run_nim.sh LABEL — complete/length/drop/reset x n=3, strictly sequential, fresh mock per run.
# Env: PY (venv python), CUTOFF_SERVER_DIR, ADAPTER_DIR, OUT. All non-local traffic is sent to a dead proxy.
set -u; H=$(cd "$(dirname "$0")" && pwd); L=$1; mkdir -p "$OUT/$L"
for m in complete length drop reset; do for r in 1 2 3; do
  P=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
  BENCH_LOG="$OUT/$L/$m-run$r.mock.jsonl" ALL_LOG="$OUT/$L/$m-run$r.all.jsonl" CUTOFF_SERVER_DIR="$CUTOFF_SERVER_DIR" \
    python3 "$H/nim_mock.py" $P & S=$!; sleep 0.7
  HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 \
  NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost NVIDIA_API_KEY= CUTOFF_HARNESS="$CUTOFF_SERVER_DIR/harness" \
    timeout -s KILL 300 "$PY" "$H/nim_cutoff.py" "http://127.0.0.1:$P" $m > "$OUT/$L/$m-run$r.client.txt" 2>&1
  kill $S; wait $S 2>/dev/null
  echo "$L $m run$r $(grep -o '"tool_executed": [a-z]*' "$OUT/$L/$m-run$r.client.txt") $(grep -o '"newline_terminated_lines": [0-9]*' "$OUT/$L/$m-run$r.client.txt")"
done; done
