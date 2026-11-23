"""Exercise peer messaging through a compiled CLI, a managed service and two TUI windows."""

import base64
import fcntl
import json
import os
import pty
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def until(description, condition):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        result = condition()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {description}")


def tui(binary, session, directory, env):
    pid, terminal = pty.fork()
    if pid == 0:
        os.chdir(directory)
        os.execve(binary, [binary, "--session", session], env)
    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 110, 0, 0))

    def drain():
        try:
            while os.read(terminal, 4096):
                pass
        except OSError:
            pass

    threading.Thread(target=drain, daemon=True).start()
    return pid, terminal


def smoke(binary, root):
    receiver_started = threading.Event()
    release_receiver = threading.Event()
    sender_done = "Independent sender response"
    peer_done = "Response from the peer"
    peer_task = "Wait for the peer smoke test to release the reply"

    class Model(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            last = next((m["content"] for m in reversed(payload["messages"]) if m["role"] == "user"), "")
            if peer_task in json.dumps(last):
                receiver_started.set()
                if not release_receiver.wait(45):
                    self.send_error(504)
                    return
                reply = peer_done
            else:
                reply = sender_done
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, finish in [({"role": "assistant", "content": reply}, None), ({}, "stop")]:
                event = {
                    "id": "chatcmpl-peer-smoke",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": payload["model"],
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                }
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")

    with ThreadingHTTPServer(("127.0.0.1", 0), Model) as model:
        threading.Thread(target=model.serve_forever, daemon=True).start()
        model_ref = {"providerID": "peer-smoke", "id": "fixture"}
        env = {
            **os.environ,
            **{f"XDG_{kind.upper()}_HOME": str(root / kind) for kind in ("data", "config", "cache", "state")},
            "OPENCODE_TEST_HOME": str(root),
            "OPENCODE_FLAGS": "session_messaging",
            "OPENCODE_DISABLE_MODELS_FETCH": "1",
            "OPENCODE_CONFIG_PROJECT_DISABLE": "1",
            "OPENCODE_FILEWATCHER_DISABLE": "1",
            "TERM": "xterm-256color",
            "OPENCODE_CONFIG_CONTENT": json.dumps({
                "providers": {"peer-smoke": {
                    "package": "@opencode/ai/providers/openai-compatible",
                    "settings": {"baseURL": f"http://127.0.0.1:{model.server_port}/v1", "apiKey": "fixture"},
                    "models": {"fixture": {"name": "Peer smoke model"}},
                }},
            }),
        }

        def cli(*args):
            return subprocess.check_output([binary, *args], cwd=root, env=env, text=True, timeout=40).strip()

        windows = []
        try:
            password = cli("service", "get", "password")
            endpoint = cli("service", "start")
            auth = base64.b64encode(f"opencode:{password}".encode()).decode()

            def api(path, method="GET", body=None):
                request = urllib.request.Request(
                    endpoint + path,
                    method=method,
                    data=None if body is None else json.dumps(body).encode(),
                    headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    return json.load(response)

            def create(title):
                body = {"title": title, "location": {"directory": str(root)}, "model": model_ref}
                return api("/api/session", "POST", body)["data"]["id"]

            def google_methods_ready():
                location = urllib.parse.urlencode({"location[directory]": str(root)})
                try:
                    google = api(f"/api/integration/google?{location}")["data"]
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
                    return False
                methods = google["methods"]
                return any(m.get("id") == "gemini-cli" and m["type"] == "oauth" for m in methods) and any(
                    m["type"] == "key" for m in methods
                )

            until("bundled Gemini OAuth and Google API key options", google_methods_ready)
            print("The compiled CLI exposes both Google sign-in methods.")
            sender, recipient = create("Sender"), create("Recipient")
            for session in [sender, recipient]:
                cli("session", "messaging", "--session", session, "--enable")
                windows.append(tui(binary, session, root, env))

            path = "/api/experimental/session-messaging/sessions"

            def peer_visible():
                try:
                    return any(row["sessionID"] == recipient for row in api(f"{path}/{sender}/peers"))
                except urllib.error.HTTPError as error:
                    if error.code != 403:
                        raise
                    return False

            until("two open TUI sessions", peer_visible)
            receipt = json.loads(cli("session", "send", "--from", sender, "--to", recipient, "--text", peer_task, "--json"))
            assert receipt["status"] == "accepted"
            assert receiver_started.wait(45), "The peer's first model request did not start"
            api(f"/api/session/{sender}/prompt", "POST", {"text": "Continue with the sender's own work"})
            until("sender response while the peer remains blocked",
                  lambda: sender_done in json.dumps(api(f"/api/session/{sender}/message")["data"]))
            result_path = f"{path}/{sender}/requests/{receipt['requestID']}"
            assert api(result_path)["status"] == "running"
            release_receiver.set()
            until("completed peer result", lambda: api(result_path).get("text") == peer_done)
            until("peer result in the sender's transcript", lambda: any(
                item["type"] == "synthetic" and peer_done in item["text"]
                for item in api(f"/api/session/{sender}/message")["data"]
            ))
            print("Two TUI sessions completed a non-blocking peer round trip.")
        finally:
            release_receiver.set()
            for pid, terminal in windows:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
                os.close(terminal)
            try:
                cli("service", "stop")
            finally:
                model.shutdown()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="cross-code-smoke-") as directory:
        smoke(str(Path(sys.argv[1]).resolve()), Path(directory).resolve())
