export * as SessionMessaging from "./messaging.js"
export { ID, Receipt, Send, Status } from "@opencode/schema/session-messaging"

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm"
import { Context, Effect, Layer, Queue, Schema } from "effect"
import { Project } from "@opencode/schema/project"
import { ID, type Receipt, Send } from "@opencode/schema/session-messaging"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../../database/database.js"
import { SessionExecution } from "../execution.js"
import { SessionInbox } from "../inbox.js"
import { SessionMessage } from "../message.js"
import { SessionProjector } from "../projector.js"
import { SessionSchema } from "../schema.js"
import { SessionInboxTable, SessionMessagingRequestTable, SessionTable } from "../sql.js"
import { SessionStore } from "../store.js"
import { SessionSynthetic } from "../synthetic.js"

export class Unavailable extends Schema.TaggedError<Unavailable>()("SessionMessaging.Unavailable", {}) {}
export class Conflict extends Schema.TaggedError<Conflict>()("SessionMessaging.Conflict", {}) {}

export interface Interface {
  readonly send: (
    senderSessionID: SessionSchema.ID,
    input: Send,
  ) => Effect.Effect<Receipt, Unavailable | Conflict | Schema.SchemaError>
  readonly result: (sessionID: SessionSchema.ID, requestID: ID) => Effect.Effect<Receipt | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionMessaging") {}

type Request = typeof SessionMessagingRequestTable.$inferSelect
const table = SessionMessagingRequestTable
const checkSend = Schema.decodeUnknownEffect(Send)
const receipt = (row: Request): Receipt => ({ requestID: row.id, status: row.status })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const store = yield* SessionStore.Service
    const inbox = yield* SessionInbox.Service
    const execution = yield* SessionExecution.Service
    const synthetic = SessionSynthetic.make(store, inbox, execution.wake)
    const pending = yield* Queue.sliding<void>(1)

    const wake = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (session && !session.revert && !session.time.archived) yield* execution.wake(sessionID)
    })

    const deliver = Effect.fnUntraced(function* (request: Request) {
      const session = yield* store.get(request.recipient_session_id)
      if (!session || session.time.archived) {
        yield* db
          .update(table)
          .set({ status: "cancelled" })
          .where(and(eq(table.id, request.id), eq(table.status, "accepted")))
          .run()
          .pipe(Effect.orDie)
        return
      }
      yield* synthetic({
        sessionID: request.recipient_session_id,
        id: request.inbox_id,
        text: request.body,
        description: `Message from session ${request.sender_session_id}`,
        metadata: {
          source: "session-messaging",
          requestID: request.id,
          senderSessionID: request.sender_session_id,
        },
        delivery: "queue",
        resume: false,
      })
      yield* wake(request.recipient_session_id)
    })

    const recover = Effect.gen(function* () {
      // Recovery only wakes rows still pending in the inbox. Promotion and cancellation
      // update their request in the same transaction as removal from the inbox.
      const rows = yield* db
        .selectDistinct({ sessionID: table.recipient_session_id })
        .from(table)
        .innerJoin(SessionInboxTable, eq(SessionInboxTable.id, table.inbox_id))
        .where(eq(table.status, "queued"))
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(rows, (row) => wake(row.sessionID), { discard: true })
    })

    const flush = Effect.gen(function* () {
      const requests = yield* db.select().from(table).where(eq(table.status, "accepted")).orderBy(asc(table.id)).all()
      yield* Effect.forEach(
        requests,
        (request) =>
          deliver(request).pipe(Effect.ignoreCause({ log: "Error", message: "Session message delivery failed" })),
        { discard: true },
      )
    }).pipe(Effect.orDie)

    yield* Queue.offer(pending, undefined)
    yield* recover.pipe(
      Effect.ignoreCause({ log: "Error", message: "Session message recovery failed" }),
      Effect.andThen(
        Queue.take(pending).pipe(
          Effect.andThen(flush),
          Effect.ignoreCause({ log: "Error", message: "Session messaging worker failed" }),
          Effect.forever,
        ),
      ),
      Effect.forkScoped,
    )

    return Service.of({
      send: Effect.fn("SessionMessaging.send")(function* (senderSessionID, input) {
        yield* checkSend(input)
        const saved = yield* db
          .transaction(() =>
            Effect.gen(function* () {
              const previous = yield* db
                .select()
                .from(table)
                .where(
                  and(eq(table.sender_session_id, senderSessionID), eq(table.idempotency_key, input.idempotencyKey)),
                )
                .get()
                .pipe(Effect.orDie)
              if (previous) {
                if (previous.recipient_session_id !== input.recipientSessionID || previous.body !== input.text) {
                  return yield* new Conflict()
                }
                return receipt(previous)
              }
              if (senderSessionID === input.recipientSessionID) return yield* new Unavailable()
              const peers = yield* db
                .select({ project: SessionTable.project_id, directory: SessionTable.directory })
                .from(SessionTable)
                .where(
                  and(
                    inArray(SessionTable.id, [senderSessionID, input.recipientSessionID]),
                    isNull(SessionTable.time_archived),
                    isNull(SessionTable.parent_id),
                    isNull(SessionTable.workspace_id),
                  ),
                )
                .all()
                .pipe(Effect.orDie)
              const [first, second] = peers
              if (
                !first ||
                !second ||
                first.project !== second.project ||
                (first.project === Project.ID.global && first.directory !== second.directory)
              )
                return yield* new Unavailable()
              const request = {
                id: ID.create(),
                sender_session_id: senderSessionID,
                recipient_session_id: input.recipientSessionID,
                idempotency_key: input.idempotencyKey,
                inbox_id: SessionMessage.ID.create(),
                body: input.text,
                status: "accepted",
              } satisfies typeof table.$inferInsert
              yield* db.insert(table).values(request).run().pipe(Effect.orDie)
              return { requestID: request.id, status: request.status }
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die))
        yield* Queue.offer(pending, undefined)
        return saved
      }, Effect.uninterruptible),
      result: Effect.fn("SessionMessaging.result")(function* (sessionID, requestID) {
        const row = yield* db
          .select()
          .from(table)
          .where(
            and(
              eq(table.id, requestID),
              or(eq(table.sender_session_id, sessionID), eq(table.recipient_session_id, sessionID)),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        return row && receipt(row)
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SessionStore.node, SessionInbox.node, SessionProjector.node, SessionExecution.node],
})
