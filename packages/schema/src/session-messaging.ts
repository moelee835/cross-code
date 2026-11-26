export * as SessionMessaging from "./session-messaging.js"

import { Schema } from "effect"
import { Identifier } from "./identifier.js"
import { optional, statics } from "./schema.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"

export const ID = Schema.String.check(Schema.isStartingWith("smr_")).pipe(
  Schema.brand("SessionMessagingID"),
  Schema.annotate({ identifier: "SessionMessaging.ID" }),
  statics((schema) => ({ create: () => schema.make("smr_" + Identifier.ascending()) })),
)
export type ID = typeof ID.Type

export const Status = Schema.Literals([
  "accepted",
  "queued",
  "running",
  "needs_reply",
  "completed",
  "failed",
  "cancelled",
]).annotate({
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

export interface Result extends Schema.Schema.Type<typeof Result> {}
export const Result = Schema.Struct({
  ...Receipt.fields,
  text: Schema.String.pipe(optional),
  assistantMessageID: SessionMessage.ID.pipe(optional),
}).annotate({ identifier: "SessionMessaging.Result" })

export interface Reply extends Schema.Schema.Type<typeof Reply> {}
export const Reply = Schema.Struct({
  text: Send.fields.text,
}).annotate({ identifier: "SessionMessaging.Reply" })

export interface Peer extends Schema.Schema.Type<typeof Peer> {}
export const Peer = Schema.Struct({
  sessionID: SessionID,
  title: Schema.String,
  busy: Schema.Boolean,
}).annotate({ identifier: "SessionMessaging.Peer" })

export interface Participation extends Schema.Schema.Type<typeof Participation> {}
export const Participation = Schema.Struct({
  enabled: Schema.Boolean,
}).annotate({ identifier: "SessionMessaging.Participation" })

export const LeaseID = Schema.String.check(Schema.isStartingWith("sml_")).pipe(
  Schema.brand("SessionMessagingLeaseID"),
  Schema.annotate({ identifier: "SessionMessaging.LeaseID" }),
  statics((schema) => ({ create: () => schema.make("sml_" + Identifier.ascending()) })),
)
export type LeaseID = typeof LeaseID.Type

export interface LeaseInput extends Schema.Schema.Type<typeof LeaseInput> {}
export const LeaseInput = Schema.Struct({
  sessions: Schema.Array(SessionID).check(Schema.isMaxLength(128)),
  groupID: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)).pipe(optional),
}).annotate({ identifier: "SessionMessaging.LeaseInput" })

export interface Lease extends Schema.Schema.Type<typeof Lease> {}
export const Lease = Schema.Struct({
  leaseID: LeaseID,
  expiresAt: Schema.Int,
  groupID: LeaseInput.fields.groupID,
}).annotate({ identifier: "SessionMessaging.Lease" })
