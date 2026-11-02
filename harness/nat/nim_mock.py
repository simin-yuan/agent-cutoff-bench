"""agent-cutoff-bench server.py, unchanged in behaviour, plus a log line for EVERY request (any method, any path)
so the record proves that all client traffic reached this mock.
usage: BENCH_LOG=chat.jsonl ALL_LOG=all.jsonl python nim_mock.py PORT   (env CUTOFF_SERVER_DIR = bench checkout)"""
import json, os, sys, time
sys.path.insert(0, os.environ["CUTOFF_SERVER_DIR"])
import server as bench  # noqa: E402


class H(bench.Handler):
    def _all(self, method):
        with open(os.environ["ALL_LOG"], "a") as f:
            f.write(json.dumps({"t": round(time.time(), 3), "method": method, "path": self.path,
                                "host": self.headers.get("Host"), "user_agent": self.headers.get("User-Agent")}) + "\n")

    def do_GET(self):
        self._all("GET")
        return super().do_GET()

    def do_POST(self):
        self._all("POST")
        return super().do_POST()

    def do_PUT(self):
        self._all("PUT"); self.send_error(404)

    def do_DELETE(self):
        self._all("DELETE"); self.send_error(404)


if __name__ == "__main__":
    bench.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
