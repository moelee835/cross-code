# Cross Code

Cross Code adds peer messaging to the OpenCode core. A session can discover participating peers on the same local managed server, deliver a request to a peer's model, and receive the result in its own inbox. The sender receives a request ID immediately and can continue working or take a new user prompt while the peer runs.

## Install and enable

Download the macOS arm64 or Linux x64 archive, check it against `SHA256SUMS`, and put the extracted `cross-code` executable on your PATH. The executable uses the `cross-code` XDG paths and its own managed service. Install a previous archive to roll back the executable. [Cross Code releases](https://github.com/moelee835/cross-code/releases)

```sh
cross-code service set env OPENCODE_FLAGS session_messaging
cross-code service restart
```

Open two sessions in the same project using the default managed service. A Git repository's root and its subdirectories can share peers as soon as you run `git init`. A separately initialized nested repository has its own peers. Run `/peer-messaging` in each session to opt in. The feature is available on an authenticated loopback service with remote access disabled. Closing a session removes it from discovery. Completed results for a closed sender remain recorded and are delivered when the sender reopens.

## Connect a Gemini model

Open `/connect` and choose **Google**. For a personal Google account, choose the API key method and use a [Gemini API key](https://ai.google.dev/gemini-api/docs/api-key).

Cross Code includes `opencode-gemini-auth@2.0.1`. **OAuth with Google (Gemini CLI)** is intended for eligible existing Gemini Code Assist Standard or Enterprise accounts. Set the project's ID with `cross-code service set env OPENCODE_GEMINI_PROJECT_ID YOUR_PROJECT_ID` and run `cross-code service start` before signing in. For a browser on another machine, the plugin can offer a manual callback. Google ended Gemini CLI OAuth for personal accounts, including Google AI Pro and Ultra, and identifies third-party use of Gemini CLI OAuth as a policy violation. [Plugin documentation](https://github.com/jenslys/opencode-gemini-auth/tree/v2.0.1) · [Google policy update](https://github.com/google-gemini/gemini-cli/discussions/22970)

## Send messages from the CLI

```sh
cross-code session peers --from "$SENDER"
cross-code session send --from "$SENDER" --to "$RECIPIENT" --text 'Review the proposed change' --json
cross-code session result --from "$SENDER" "$REQUEST_ID" --json
```

Add `--key` to reuse the same request on a CLI retry. Models can use `session_peers`, `session_message_send`, `session_message_result`, and `session_message_reply`. Model sends and explicit replies follow the session's tool permissions. If a user steers the receiving turn with a different prompt, the original request reports `needs_reply` and shares only an explicit reply.

## Persist the session event log

Pass `OPENCODE_EVENTS_PERSIST=1` in the server process environment to retain durable events. The default leaves event persistence off.

```sh
OPENCODE_EVENTS_PERSIST=1 cross-code serve --hostname 127.0.0.1 --port 0
```

The same environment variable works with `serve --service`. For a managed service started by Cross Code, save it with `cross-code service set env OPENCODE_EVENTS_PERSIST 1` and run `cross-code service restart`.

`GET /api/experimental/session/{sessionID}/log?follow=true` replays recorded events in sequence order, emits `log.synced`, and follows new durable events from that server. Resume with `after=<seq>`, using `durable.seq` from the last event your integration processed. The cursor is exclusive, and sequence numbers can have gaps. For completion, watch `session.execution.succeeded`, `session.execution.failed`, and `session.execution.interrupted`. For usage, `session.step.ended` includes per-step cost and tokens, while `GET /api/session/{sessionID}` reports session totals.

The log API is experimental. Pin your Cross Code version if you depend on its wire format. `GET /api/event` provides live notifications without replay. Enabling persistence adds event serialization and SQLite writes from that point onward. Events missed while persistence was off cannot be backfilled. Deleting a session removes its event rows.
