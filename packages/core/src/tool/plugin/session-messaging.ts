export * as SessionMessagingTools from "./session-messaging.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { SessionMessaging } from "../../session/messaging/messaging.js"
import { ID, Peer, Receipt, Reply, Result, Send } from "@opencode/schema/session-messaging"
import { Permission } from "../../permission.js"

const failure = (error: { readonly _tag: string }) =>
  new ToolFailure({
    message:
      error._tag === "SessionMessaging.Conflict"
        ? "This request conflicts with its retry key or current status."
        : "Peer messaging is unavailable for this request or session.",
    error,
  })

export const Plugin = {
  id: "opencode.tool.session-messaging",
  effect: Effect.fn("SessionMessagingTools.Plugin")(function* (ctx: Context) {
    const messaging = yield* SessionMessaging.Service
    if (!messaging.enabled) return
    const permission = yield* Permission.Service
    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: "session_peers",
          description: "List other open sessions available for peer messaging.",
          input: Schema.Struct({}),
          output: Schema.Array(Peer),
          options: { codemode: false },
          execute: (_, context) =>
            messaging.peers(context.sessionID).pipe(
              Effect.map((output) => ({ output })),
              Effect.mapError(failure),
            ),
        })
        editor.add({
          name: "session_message_send",
          description:
            "Send a task to an open peer session. Returns a request ID immediately. Continue the current task. The result arrives automatically as a new queued input.",
          input: Schema.Struct({ recipientSessionID: Send.fields.recipientSessionID, text: Send.fields.text }),
          output: Receipt,
          options: { codemode: false },
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: "session_message_send",
                resources: [input.recipientSessionID],
                save: [input.recipientSessionID],
                ...Permission.invocation(context),
              })
              const output = yield* messaging.send(context.sessionID, {
                ...input,
                idempotencyKey: `${context.messageID}:${context.id}`,
              })
              return { output }
            }).pipe(Effect.mapError(failure)),
        })
        editor.add({
          name: "session_message_result",
          description:
            "Read the current status and available reply for a request. Returns immediately. Results are also delivered automatically.",
          input: Schema.Struct({ requestID: ID }),
          output: Result,
          options: { codemode: false },
          execute: (input, context) =>
            Effect.gen(function* () {
              const output = yield* messaging.result(context.sessionID, input.requestID)
              if (!output) return yield* new SessionMessaging.Unavailable()
              return { output }
            }).pipe(Effect.mapError(failure)),
        })
        editor.add({
          name: "session_message_reply",
          description:
            "Send an explicit reply for a received request in needs_reply status. Include only the text intended for the other session.",
          input: Schema.Struct({ requestID: ID, ...Reply.fields }),
          output: Result,
          options: { codemode: false },
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: "session_message_reply",
                resources: [input.requestID],
                save: ["*"],
                ...Permission.invocation(context),
              })
              const output = yield* messaging.reply(context.sessionID, input.requestID, { text: input.text })
              return { output }
            }).pipe(Effect.mapError(failure)),
        })
      })
      .pipe(Effect.orDie)
  }),
}
