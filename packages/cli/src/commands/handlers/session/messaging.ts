import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Effect, Option } from "effect"
import { randomUUID } from "node:crypto"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"
import { errorMessage } from "../../../util/error"

const commands = Commands.commands.session.commands
const api = Effect.gen(function* () {
  const server = yield* ServerConnection.resolve()
  return OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) }).experimental[
    "session-messaging"
  ]
})
const call = <T>(use: (signal: AbortSignal) => Promise<T>) =>
  Effect.tryPromise({ try: use, catch: (error) => new Error(errorMessage(error)) })
const print = <Value>(json: boolean, value: Value, text: string) =>
  Effect.sync(() => {
    process.stdout.write((json ? JSON.stringify(value) : text) + EOL)
  })

export const peers = Runtime.handler(
  commands.peers,
  Effect.fn("cli.session.peers")(function* (input) {
    const client = yield* api
    const rows = yield* call((signal) => client.peers({ sessionID: input.from }, { signal }))
    yield* print(
      input.json,
      rows,
      rows.map((row) => `${row.sessionID}\t${row.busy ? "busy" : "idle"}\t${row.title}`).join(EOL),
    )
  }),
)

export const send = Runtime.handler(
  commands.send,
  Effect.fn("cli.session.send")(function* (input) {
    const client = yield* api
    const result = yield* call((signal) =>
      client.send(
        {
          sessionID: input.from,
          recipientSessionID: input.to,
          idempotencyKey: Option.getOrElse(input.key, randomUUID),
          text: input.text,
        },
        { signal },
      ),
    )
    yield* print(input.json, result, `${result.requestID}  ${result.status}`)
  }),
)

export const result = Runtime.handler(
  commands.result,
  Effect.fn("cli.session.result")(function* (input) {
    const client = yield* api
    const result = yield* call((signal) =>
      client.result({ sessionID: input.from, requestID: input.requestID }, { signal }),
    )
    yield* print(input.json, result, [`${result.requestID}  ${result.status}`, result.text].filter(Boolean).join(EOL))
  }),
)

export const participation = Runtime.handler(
  commands.messaging,
  Effect.fn("cli.session.messaging")(function* (input) {
    if (input.enable && input.disable) return yield* Effect.fail(new Error("Choose either --enable or --disable."))
    const client = yield* api
    const result = yield* call((signal) =>
      input.enable || input.disable
        ? client.setParticipation({ sessionID: input.sessionID, enabled: input.enable }, { signal })
        : client.participation({ sessionID: input.sessionID }, { signal }),
    )
    yield* print(input.json, result, result.enabled ? "Peer messaging enabled" : "Peer messaging disabled")
  }),
)
