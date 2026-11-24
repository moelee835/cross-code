"""Exercise peer messaging and durable session logs through the compiled CLI."""

import base64
from contextlib import closing
import fcntl
import json
import os
import pty
import re
import signal
import sqlite3
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


def connect(endpoint, password):
    auth = base64.b64encode(f"opencode:{password}".encode()).decode()

    def request(path, method="GET", body=None):
        req = urllib.request.Request(
            endpoint + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
        )
        return urllib.request.urlopen(req, timeout=15)

    return request


def json_request(request, *args):
    with request(*args) as response:
        return None if response.status == 204 else json.load(response)


def log_frames(response):
    assert response.headers.get_content_type() == "text/event-stream"
    data = []
    for line in response:
        if line.startswith(b"data:"):
            data.append(line[5:].strip())
        elif not line.strip() and data:
            yield json.loads(b"\n".join(data))
            data.clear()


def verify_serve_logs(binary, root, env, model_ref, enabled):
    name = "persistent" if enabled else "default"
    database = root / f"events-{name}.db"
    output = root / f"serve-{name}.log"
    password = "session-log-fixture"
    server_env = {**env, "OPENCODE_PASSWORD": password, "OPENCODE_DB": str(database)}
    server_env.pop("OPENCODE_EVENTS_PERSIST", None)
    if enabled:
        server_env["OPENCODE_EVENTS_PERSIST"] = "1"

    with output.open("w") as log:
        server = subprocess.Popen(
            [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
            cwd=root, env=server_env, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            def listening():
                text = output.read_text()
                assert server.poll() is None, text
                match = re.search(r"server listening on (http://127\.0\.0\.1:\d+)", text)
                return match.group(1) if match else None

            request = connect(until(f"serve ({name}) listening", listening), password)
            session = json_request(request, "/api/session", "POST", {
                "title": "Session log fixture", "location": {"directory": str(root)}, "model": model_ref,
            })["data"]["id"]
            session_path = f"/api/session/{session}"
            log_path = f"/api/experimental/session/{session}/log"

            def prompt():
                json_request(request, f"{session_path}/prompt", "POST", {"text": "Reply for the session log test"})

            def stored_events():
                with closing(sqlite3.connect(database)) as db:
                    return db.execute("SELECT count(*) FROM event WHERE aggregate_id = ?", (session,)).fetchone()[0]

            if not enabled:
                prompt()
                until("successful execution with default event persistence",
                      lambda: json_request(request, session_path)["data"].get("outcome") == "succeeded")
                with request(log_path) as response:
                    assert [item["type"] for item in log_frames(response)] == ["log.synced"]
                assert stored_events() == 0
                return

            # Start following before the prompt, then disconnect mid-turn and replay the rest.
            with request(f"{log_path}?follow=true") as response:
                live = log_frames(response)
                assert next(live)["type"] == "session.created"
                assert any(item["type"] == "log.synced" for item in live)
                prompt()
                live_events = []
                for item in live:
                    live_events.append(item)
                    if item["type"] == "session.step.started":
                        break
                live_types = [item["type"] for item in live_events]
                assert live_types[-1] == "session.step.started" and "session.execution.started" in live_types
                seqs = [item["durable"]["seq"] for item in live_events]
                assert seqs == sorted(set(seqs))

            until("successful execution with event persistence",
                  lambda: json_request(request, session_path)["data"].get("outcome") == "succeeded")
            with request(f"{log_path}?after={seqs[-1]}&follow=true") as response:
                replay = []
                for item in log_frames(response):
                    replay.append(item)
                    if item["type"] == "log.synced":
                        break
            assert replay[-1]["type"] == "log.synced"
            resumed_seqs = [item["durable"]["seq"] for item in replay[:-1]]
            assert resumed_seqs and seqs[-1] < resumed_seqs[0] and resumed_seqs == sorted(set(resumed_seqs))
            types = [item["type"] for item in replay[:-1]]
            assert types.index("session.step.ended") < types.index("session.execution.succeeded"), types
            usage = next(item["data"] for item in replay if item["type"] == "session.step.ended")
            assert usage["finish"] == "stop" and usage["tokens"]["output"] == 3 and "cost" in usage, usage
            assert stored_events() >= len(seqs) + len(resumed_seqs)
            json_request(request, session_path, "DELETE")
            assert stored_events() == 0
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


def tui(binary, session, directory, env, logo_ready=None, tour_ready=None):
    pid, terminal = pty.fork()
    if pid == 0:
        os.chdir(directory)
        args = [binary, "--session", session] if session else [binary]
        os.execve(binary, args, env)
    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 110, 0, 0))

    def drain():
        csi = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
        cross_logo = "▄█▀▀▀ ██▀█▄ ▄█▀█▄ ▄█▀▀▀ ▄█▀▀▀".encode()
        tour_hint = "Start here · /tour".encode()
        tail = b""
        try:
            while chunk := os.read(terminal, 4096):
                if all(ready is None or ready.is_set() for ready in (logo_ready, tour_ready)):
                    continue
                output = tail + chunk
                visible = csi.sub(b"", output)
                if logo_ready is not None and cross_logo in visible:
                    logo_ready.set()
                if tour_ready is not None and tour_hint in visible:
                    tour_ready.set()
                tail = output[-4096:]
        except OSError:
            pass

    threading.Thread(target=drain, daemon=True).start()
    return pid, terminal


def smoke(binary, root):
    child = root / "src" / "feature"
    child.mkdir(parents=True)
    subprocess.run(["git", "init", "--quiet", str(root)], check=True, timeout=15)
    system_prompt_branded = threading.Event()
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
            if any("AI agent running in Cross Code" in json.dumps(message["content"])
                   for message in payload["messages"] if message["role"] in ("system", "developer")):
                system_prompt_branded.set()
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
                if finish:
                    event["usage"] = {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}
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
            help_text = cli("--help")
            assert "Cross Code command line interface" in help_text and "OpenCode" not in help_text, help_text
            verify_serve_logs(binary, root, env, model_ref, enabled=False)
            verify_serve_logs(binary, root, env, model_ref, enabled=True)
            assert system_prompt_branded.is_set(), "The system prompt did not identify the agent as Cross Code"
            print("The compiled CLI help and system prompt identify Cross Code.")
            print("The foreground server preserves the default and supports durable live events, resume and deletion.")

            env["OPENCODE_EVENTS_PERSIST"] = "true"
            password = cli("service", "get", "password")
            endpoint = cli("service", "start")
            request = connect(endpoint, password)

            def api(path, method="GET", body=None):
                return json_request(request, path, method, body)

            def create(title, directory):
                body = {"title": title, "location": {"directory": str(directory)}, "model": model_ref}
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
            logo_ready = threading.Event()
            tour_ready = threading.Event()
            windows.append(tui(binary, None, root, env, logo_ready, tour_ready))
            assert logo_ready.wait(45), "The Cross Code wordmark did not appear on the TUI home screen"
            assert tour_ready.wait(45), "The first-run product tour hint did not appear on the TUI home screen"
            print("The compiled CLI renders the Cross Code wordmark and first-run tour hint.")
            sender, recipient = create("Sender", root), create("Recipient", child)
            with request(f"/api/experimental/session/{sender}/log") as response:
                assert next(log_frames(response))["type"] == "session.created"
            print("The managed service honors the same event persistence environment variable.")
            for session, directory in [(sender, root), (recipient, child)]:
                cli("session", "messaging", "--session", session, "--enable")
                windows.append(tui(binary, session, directory, env))

            path = "/api/experimental/session-messaging/sessions"

            def peer_visible():
                try:
                    return any(row["sessionID"] == recipient for row in api(f"{path}/{sender}/peers"))
                except urllib.error.HTTPError as error:
                    if error.code != 403:
                        raise
                    return False

            until("two open TUI sessions in the root and a subdirectory", peer_visible)
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
