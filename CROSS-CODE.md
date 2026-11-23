# Cross Code

Cross Code adds peer messaging to the OpenCode core. A session can discover participating peers on the same local managed server, deliver a request to a peer's model, and receive the result in its own inbox. The sender receives a request ID immediately and can continue working or take a new user prompt while the peer runs.

## Install and enable

Download the macOS arm64 or Linux x64 archive, check it against `SHA256SUMS`, and put the extracted `cross-code` executable on your PATH. The executable uses the `cross-code` XDG paths and its own managed service. Install a previous archive to roll back the executable. [Cross Code releases](https://github.com/moelee835/cross-code/releases)

```sh
cross-code service set env OPENCODE_FLAGS session_messaging
cross-code service restart
```

Open two sessions in the same project using the default managed service. Run `/peer-messaging` in each session to opt in. The feature is available on an authenticated loopback service with remote access disabled. Closing a session removes it from discovery. Completed results for a closed sender remain recorded and are delivered when the sender reopens.

```sh
cross-code session peers --from "$SENDER"
cross-code session send --from "$SENDER" --to "$RECIPIENT" --text 'Review the proposed change' --json
cross-code session result --from "$SENDER" "$REQUEST_ID" --json
```

Add `--key` to reuse the same request on a CLI retry. Models can use `session_peers`, `session_message_send`, `session_message_result`, and `session_message_reply`. Model sends and explicit replies follow the session's tool permissions. If a user steers the receiving turn with a different prompt, the original request reports `needs_reply` and shares only an explicit reply.
