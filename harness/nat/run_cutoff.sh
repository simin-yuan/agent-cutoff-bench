#!/bin/sh
# run_cutoff.sh API MODE RUN — one cutoff cell with NAT; mirrors agent-cutoff-bench/run_all.sh (fresh server per run).
# Env: BENCH_B (agent-cutoff-bench checkout), NATPY, OUTBASE.
API=$1; MODE=$2; RUN=$3; HERE=$(cd "$(dirname "$0")" && pwd)
ID="nat-$API-stream-$MODE-run$RUN"; mkdir -p "$OUTBASE/logs"
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
BENCH_LOG="$OUTBASE/logs/$ID.jsonl" python3 "$BENCH_B/server.py" "$PORT" >/dev/null 2>&1 & SP=$!
sleep 0.7
S=$(date +%s.%N)
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost CUTOFF_HARNESS="$BENCH_B/harness" BENCH_RESULT="$OUTBASE/runs.jsonl" \
  BENCH_RUN_ID="$ID" timeout -s KILL 300 "$NATPY" "$HERE/nat_bench.py" cutoff "http://127.0.0.1:$PORT" "$MODE" "$API" \
  > "$OUTBASE/logs/$ID.client.txt" 2>&1; echo "exit=$? wall_s=$(python3 -c "print(round($(date +%s.%N)-$S,2))")" >> "$OUTBASE/logs/$ID.client.txt"
kill $SP 2>/dev/null; wait $SP 2>/dev/null
echo "done $ID $(tail -1 "$OUTBASE/logs/$ID.client.txt")"
