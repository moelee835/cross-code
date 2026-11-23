import { SessionMessaging } from "@opencode/core/session/messaging/messaging"
import { ConflictError, ForbiddenError, InvalidRequestError } from "@opencode/protocol/errors"
import { Effect, Schema } from "effect"

export const forbidden = () =>
  new ForbiddenError({
    message: "Peer messaging is unavailable for this session or lease.",
  })

export const peerAccess = <A>(effect: Effect.Effect<A, SessionMessaging.Unavailable>) =>
  effect.pipe(Effect.mapError(forbidden))

export const peerMutation = <A>(
  effect: Effect.Effect<A, SessionMessaging.Unavailable | SessionMessaging.Conflict | Schema.SchemaError>,
) =>
  effect.pipe(
    Effect.catchTags({
      "SessionMessaging.Unavailable": forbidden,
      "SessionMessaging.Conflict": () =>
        new ConflictError({ message: "The request conflicts with its current state or retry key." }),
      SchemaError: () => new InvalidRequestError({ message: "Invalid session message.", kind: "session_message" }),
    }),
  )
