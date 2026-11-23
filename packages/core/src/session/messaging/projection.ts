export * as SessionMessagingProjection from "./projection.js"

import { and, asc, eq, gte, inArray, ne } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../../database/database.js"
import { SessionMessage } from "../message.js"
import type { SessionSchema } from "../schema.js"
import { SessionMessagingPolicy } from "./policy.js"
import {
  SessionInboxTable,
  SessionMessagingOutboxTable,
  SessionMessagingRequestTable,
  SessionPartTable,
} from "../sql.js"

type DB = Database.Interface["db"]
type Request = typeof SessionMessagingRequestTable.$inferSelect
type InboxRef = { readonly sessionID: SessionSchema.ID; readonly inboxID: SessionMessage.ID }
type Kind = typeof SessionMessagingOutboxTable.$inferSelect.kind
const requests = SessionMessagingRequestTable
const outbox = SessionMessagingOutboxTable

export function notify(db: DB, requestID: Request["id"], kind: Kind) {
  return db
    .insert(outbox)
    .values({
      inbox_id: SessionMessage.ID.create(),
      request_id: requestID,
      kind,
      state: "pending",
    })
    .onConflictDoNothing({ target: [outbox.request_id, outbox.kind] })
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}

export const enqueued = Effect.fnUntraced(function* (db: DB, ref: InboxRef) {
  yield* db
    .update(requests)
    .set({ status: "queued" })
    .where(
      and(
        eq(requests.inbox_id, ref.inboxID),
        eq(requests.recipient_session_id, ref.sessionID),
        eq(requests.status, "accepted"),
      ),
    )
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(outbox)
    .set({ state: "queued" })
    .where(
      and(
        eq(outbox.inbox_id, ref.inboxID),
        eq(outbox.state, "pending"),
        inArray(
          outbox.request_id,
          db.select({ id: requests.id }).from(requests).where(eq(requests.sender_session_id, ref.sessionID)),
        ),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

export const delivered = Effect.fnUntraced(function* (db: DB, ref: InboxRef, seq: number) {
  const mixed = yield* db
    .update(requests)
    .set({ status: "needs_reply" })
    .where(
      and(
        eq(requests.recipient_session_id, ref.sessionID),
        eq(requests.status, "running"),
        ne(requests.inbox_id, ref.inboxID),
      ),
    )
    .returning({ id: requests.id })
    .all()
    .pipe(Effect.orDie)
  yield* Effect.forEach(mixed, (row) => notify(db, row.id, "needs_reply"), { discard: true })
  yield* db
    .update(requests)
    .set({ status: "running", delivered_seq: seq })
    .where(
      and(
        eq(requests.inbox_id, ref.inboxID),
        eq(requests.recipient_session_id, ref.sessionID),
        eq(requests.status, "queued"),
      ),
    )
    .run()
    .pipe(Effect.orDie)
  yield* settleOutbox(db, ref)
})

export const cancelled = Effect.fnUntraced(function* (db: DB, ref: InboxRef) {
  const row = yield* db
    .update(requests)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(requests.inbox_id, ref.inboxID),
        eq(requests.recipient_session_id, ref.sessionID),
        eq(requests.status, "queued"),
      ),
    )
    .returning({ id: requests.id })
    .get()
    .pipe(Effect.orDie)
  if (row) yield* notify(db, row.id, "cancelled")
  yield* settleOutbox(db, ref)
})

function settleOutbox(db: DB, ref: InboxRef) {
  return db
    .update(outbox)
    .set({ state: "settled" })
    .where(
      and(
        eq(outbox.inbox_id, ref.inboxID),
        eq(outbox.state, "queued"),
        inArray(
          outbox.request_id,
          db.select({ id: requests.id }).from(requests).where(eq(requests.sender_session_id, ref.sessionID)),
        ),
      ),
    )
    .run()
    .pipe(Effect.orDie)
}

export const complete = Effect.fnUntraced(function* (
  db: DB,
  sessionID: SessionSchema.ID,
  assistantMessageID: SessionMessage.ID,
) {
  const request = yield* db
    .select({ id: requests.id, sender: requests.sender_session_id })
    .from(requests)
    .where(and(eq(requests.recipient_session_id, sessionID), eq(requests.status, "running")))
    .get()
    .pipe(Effect.orDie)
  if (!request) return
  if (!(yield* SessionMessagingPolicy.allowed(db, request.sender, sessionID)))
    return yield* failRunning(db, sessionID, "cancelled")
  const parts = yield* db
    .select({ data: SessionPartTable.data })
    .from(SessionPartTable)
    .where(and(eq(SessionPartTable.message_id, assistantMessageID), eq(SessionPartTable.type, "text")))
    .orderBy(asc(SessionPartTable.ordinal))
    .all()
    .pipe(Effect.orDie)
  const text = parts
    .flatMap(({ data }) => (data.type === "text" ? [data.text] : []))
    .join("\n\n")
    .slice(0, 32_000)
  yield* db
    .update(requests)
    .set({ status: "completed", assistant_message_id: assistantMessageID, result: text })
    .where(eq(requests.id, request.id))
    .run()
    .pipe(Effect.orDie)
  yield* notify(db, request.id, "completed")
})

export const failRunning = Effect.fnUntraced(function* (
  db: DB,
  sessionID: SessionSchema.ID,
  kind: "failed" | "cancelled",
) {
  const rows = yield* db
    .update(requests)
    .set({ status: kind })
    .where(and(eq(requests.recipient_session_id, sessionID), eq(requests.status, "running")))
    .returning({ id: requests.id })
    .all()
    .pipe(Effect.orDie)
  yield* Effect.forEach(rows, (row) => notify(db, row.id, kind), { discard: true })
})

export const revert = Effect.fnUntraced(function* (db: DB, sessionID: SessionSchema.ID, seq: number) {
  const pending = yield* db
    .select({ inboxID: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.session_id, sessionID),
        gte(SessionInboxTable.enqueued_seq, seq),
        eq(SessionInboxTable.type, "synthetic"),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  yield* Effect.forEach(pending, ({ inboxID }) => cancelled(db, { sessionID, inboxID }), { discard: true })
})
