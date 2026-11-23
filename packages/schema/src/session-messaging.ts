export * as SessionMessaging from "./session-messaging.js"

import { Schema } from "effect"
import { Identifier } from "./identifier.js"
import { statics } from "./schema.js"
import { SessionID } from "./session-id.js"

export const ID = Schema.String.check(Schema.isStartingWith("smr_")).pipe(
  Schema.brand("SessionMessagingID"),
  Schema.annotate({ identifier: "SessionMessaging.ID" }),
  statics((schema) => ({ create: () => schema.make("smr_" + Identifier.ascending()) })),
)
export type ID = typeof ID.Type

export const Status = Schema.Literals(["accepted", "queued", "running", "cancelled"]).annotate({
  identifier: "SessionMessaging.Status",
})
export type Status = typeof Status.Type

export interface Send extends Schema.Schema.Type<typeof Send> {}
export const Send = Schema.Struct({
  recipientSessionID: SessionID,
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)),
}).annotate({ identifier: "SessionMessaging.Send" })

export interface Receipt extends Schema.Schema.Type<typeof Receipt> {}
export const Receipt = Schema.Struct({
  requestID: ID,
  status: Status,
}).annotate({ identifier: "SessionMessaging.Receipt" })
