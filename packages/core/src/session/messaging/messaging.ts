export * as SessionMessaging from "./messaging.js"
export { ID, Receipt, Reply, Result, Send, Status } from "@opencode/schema/session-messaging"

import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm"
import { Context, Effect, Latch, Layer, Queue, Schema, Stream } from "effect"
import {
  ID,
  Reply,
  Send,
  type Lease,
  type LeaseID,
  type LeaseInput,
  type Participation,
  type Peer,
  type Receipt,
  type Result,
} from "@opencode/schema/session-messaging"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { SessionEvent } from "../event.js"
import { SessionExecution } from "../execution.js"
import { SessionInbox } from "../inbox.js"
import { SessionMessage } from "../message.js"
import { SessionProjector } from "../projector.js"
import { SessionSchema } from "../schema.js"
import {
  SessionInboxTable,
  SessionMessageTable,
  SessionMessagingOutboxTable,
  SessionMessagingParticipationTable,
  SessionMessagingRequestTable,
} from "../sql.js"
import { SessionStore } from "../store.js"
import { SessionSynthetic } from "../synthetic.js"
import { SessionMessagingProjection } from "./projection.js"
import { SessionMessagingPolicy } from "./policy.js"

export class Unavailable extends Schema.TaggedError<Unavailable>()("SessionMessaging.Unavailable", {}) {}
export class Conflict extends Schema.TaggedError<Conflict>()("SessionMessaging.Conflict", {}) {}

export interface Interface {
  readonly enabled: boolean
  readonly start: Effect.Effect<void>
  readonly participation: (sessionID: SessionSchema.ID, enabled?: boolean) => Effect.Effect<Participation, Unavailable>
  readonly peers: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Peer>, Unavailable>
  readonly lease: (input: LeaseInput, id?: LeaseID) => Effect.Effect<Lease, Unavailable>
  readonly close: (id: LeaseID) => Effect.Effect<void>
  readonly send: (
    senderSessionID: SessionSchema.ID,
    input: Send,
  ) => Effect.Effect<Receipt, Unavailable | Conflict | Schema.SchemaError>
  readonly result: (sessionID: SessionSchema.ID, requestID: ID) => Effect.Effect<Result | undefined>
  readonly reply: (
    sessionID: SessionSchema.ID,
    requestID: ID,
    input: Reply,
  ) => Effect.Effect<Result, Unavailable | Conflict | Schema.SchemaError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionMessaging") {}

type Request = typeof SessionMessagingRequestTable.$inferSelect
const table = SessionMessagingRequestTable
const outbox = SessionMessagingOutboxTable
const checkSend = Schema.decodeUnknownEffect(Send)
const checkReply = Schema.decodeUnknownEffect(Reply)
const receipt = (row: Request): Receipt => ({ requestID: row.id, status: row.status })
const result = (row: Request): Result => ({
  ...receipt(row),
  ...(row.result === null ? {} : { text: row.result }),
  ...(row.assistant_message_id === null ? {} : { assistantMessageID: row.assistant_message_id }),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const inbox = yield* SessionInbox.Service
    const execution = yield* SessionExecution.Service
    const policy = yield* SessionMessagingPolicy.Service
    const fs = yield* FSUtil.Service
    const synthetic = SessionSynthetic.make(store, inbox, execution.wake)
    const pending = yield* Queue.sliding<void>(1)
    const started = yield* Latch.make()
    const signal = Queue.offer(pending, undefined)

    const wake = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (session && !session.revert && !session.time.archived) yield* execution.wake(sessionID)
    })

    const deliver = Effect.fnUntraced(function* (request: Request) {
      if (!(yield* SessionMessagingPolicy.allowed(fs, db, request.sender_session_id, request.recipient_session_id))) {
        yield* db
          .transaction(() =>
            Effect.gen(function* () {
              const cancelled = yield* db
                .update(table)
                .set({ status: "cancelled" })
                .where(and(eq(table.id, request.id), eq(table.status, "accepted")))
                .returning({ id: table.id })
                .get()
                .pipe(Effect.orDie)
              if (cancelled) yield* SessionMessagingProjection.notify(db, cancelled.id, "cancelled")
            }),
          )
          .pipe(Effect.orDie)
        return
      }
      yield* synthetic({
        sessionID: request.recipient_session_id,
        id: request.inbox_id,
        text: `Peer request ${request.id} from session ${request.sender_session_id}:\n\n${request.body}`,
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

    const resumeNotifications = Effect.fnUntraced(function* (sessions: ReadonlyArray<SessionSchema.ID>) {
      if (!sessions.length) return
      const notifications = yield* db
        .selectDistinct({ sessionID: table.sender_session_id })
        .from(outbox)
        .innerJoin(table, eq(table.id, outbox.request_id))
        .innerJoin(SessionInboxTable, eq(SessionInboxTable.id, outbox.inbox_id))
        .where(and(eq(outbox.state, "queued"), inArray(table.sender_session_id, [...sessions])))
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(notifications, (row) => wake(row.sessionID), { discard: true })
    })

    const flush = Effect.gen(function* () {
      const requests = yield* db.select().from(table).where(eq(table.status, "accepted")).orderBy(asc(table.id)).all()
      yield* Effect.forEach(
        requests,
        (request) =>
          deliver(request).pipe(Effect.ignoreCause({ log: "Error", message: "Session message delivery failed" })),
        { discard: true },
      )
      const notifications = yield* db
        .select({ message: outbox, request: table })
        .from(outbox)
        .innerJoin(table, eq(table.id, outbox.request_id))
        .where(eq(outbox.state, "pending"))
        .orderBy(asc(outbox.inbox_id))
        .all()
      const open = yield* policy.open
      yield* Effect.forEach(
        notifications,
        ({ message, request }) =>
          Effect.gen(function* () {
            if (!open.has(request.sender_session_id)) return
            if (!(yield* SessionMessagingPolicy.participating(db, [request.sender_session_id])).length) return
            const sender = yield* store.get(request.sender_session_id)
            if (!sender || sender.time.archived || sender.revert) return
            const text = `Peer request ${request.id} to session ${request.recipient_session_id}: ${message.kind}.`
            yield* synthetic({
              sessionID: sender.id,
              id: message.inbox_id,
              text: message.kind === "completed" && request.result ? `${text}\n\n${request.result}` : text,
              description: `Peer request ${message.kind}`,
              metadata: { source: "session-messaging-result", requestID: request.id, status: message.kind },
              delivery: "queue",
              resume: false,
            })
            yield* wake(sender.id)
          }).pipe(Effect.ignoreCause({ log: "Error", message: "Session message result delivery failed" })),
        { discard: true },
      )
    }).pipe(Effect.orDie)

    if (policy.enabled) {
      yield* bus
        .subscribe([
          SessionEvent.Step.Ended,
          SessionEvent.InboxDelivered,
          SessionEvent.InboxCancelled,
          SessionEvent.Execution.Succeeded,
          SessionEvent.Execution.Failed,
          SessionEvent.Execution.Interrupted,
          SessionEvent.RevertEvent.Cleared,
          SessionEvent.RevertEvent.Committed,
          SessionEvent.Unarchived,
        ])
        .pipe(
          Stream.runForEach(() => signal),
          Effect.forkScoped({ startImmediately: true }),
        )
      yield* started.await.pipe(
        Effect.andThen(
          Queue.take(pending).pipe(
            Effect.andThen(flush),
            Effect.ignoreCause({ log: "Error", message: "Session messaging worker failed" }),
            Effect.forever,
          ),
        ),
        Effect.forkScoped,
      )
    }

    return Service.of({
      enabled: policy.enabled,
      start: policy.enabled
        ? recover.pipe(
            Effect.ignoreCause({ log: "Error", message: "Session message recovery failed" }),
            Effect.andThen(started.open),
            Effect.andThen(signal),
            Effect.asVoid,
          )
        : Effect.void,
      participation: Effect.fn("SessionMessaging.participation")(function* (sessionID, enabled) {
        if (!policy.enabled || !(yield* SessionMessagingPolicy.eligible(db, [sessionID])).length)
          return yield* new Unavailable()
        const participants = SessionMessagingParticipationTable
        if (enabled === true)
          yield* db
            .insert(participants)
            .values({ session_id: sessionID })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
        if (enabled === false)
          yield* db.delete(participants).where(eq(participants.session_id, sessionID)).run().pipe(Effect.orDie)
        if (enabled !== undefined) yield* signal
        return { enabled: enabled ?? (yield* SessionMessagingPolicy.participating(db, [sessionID])).length !== 0 }
      }),
      peers: Effect.fn("SessionMessaging.peers")(function* (sessionID) {
        const open = yield* policy.open
        if (!policy.enabled || !open.has(sessionID)) return yield* new Unavailable()
        const addresses = yield* SessionMessagingPolicy.participating(db, [...open])
        const sender = addresses.find((peer) => peer.id === sessionID)
        if (!sender) return yield* new Unavailable()
        const active = yield* execution.active
        const peers = yield* SessionMessagingPolicy.matchingProject(
          fs,
          sender,
          addresses.filter((peer) => peer.id !== sessionID),
        )
        return peers.map((peer) => ({ sessionID: peer.id, title: peer.title ?? peer.id, busy: active.has(peer.id) }))
      }),
      lease: Effect.fn("SessionMessaging.lease")(function* (input, id) {
        if (!policy.enabled) return yield* new Unavailable()
        const open = yield* policy.open
        const sessions = yield* SessionMessagingPolicy.eligible(db, input.sessions)
        const lease = yield* policy.lease(
          sessions.map((session) => session.id),
          id,
        )
        if (!lease) return yield* new Unavailable()
        yield* resumeNotifications(sessions.map((session) => session.id).filter((id) => !open.has(id)))
        yield* signal
        return lease
      }),
      close: policy.close,
      send: Effect.fn("SessionMessaging.send")(function* (senderSessionID, input) {
        if (!policy.enabled) return yield* new Unavailable()
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
              const open = yield* policy.open
              if (
                !open.has(senderSessionID) ||
                !open.has(input.recipientSessionID) ||
                !(yield* SessionMessagingPolicy.allowed(fs, db, senderSessionID, input.recipientSessionID))
              )
                return yield* new Unavailable()
              const pending = yield* db
                .select({ count: sql<number>`count(*)` })
                .from(table)
                .where(
                  and(
                    or(
                      eq(table.sender_session_id, senderSessionID),
                      eq(table.recipient_session_id, input.recipientSessionID),
                    ),
                    inArray(table.status, ["accepted", "queued", "running"]),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              const depth = yield* nextDepth(db, senderSessionID)
              if (depth > 4 || (pending?.count ?? 0) >= 32) return yield* new Unavailable()
              const request = {
                id: ID.create(),
                sender_session_id: senderSessionID,
                recipient_session_id: input.recipientSessionID,
                idempotency_key: input.idempotencyKey,
                inbox_id: SessionMessage.ID.create(),
                body: input.text,
                status: "accepted",
                depth,
              } satisfies typeof table.$inferInsert
              yield* db.insert(table).values(request).run().pipe(Effect.orDie)
              return { requestID: request.id, status: request.status }
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die))
        yield* signal
        return saved
      }, Effect.uninterruptible),
      result: Effect.fn("SessionMessaging.result")(function* (sessionID, requestID) {
        if (!policy.enabled) return
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
        return row && result(row)
      }),
      reply: Effect.fn("SessionMessaging.reply")(function* (sessionID, requestID, input) {
        if (!policy.enabled) return yield* new Unavailable()
        yield* checkReply(input)
        const saved = yield* db
          .transaction(() =>
            Effect.gen(function* () {
              const row = yield* db
                .select()
                .from(table)
                .where(and(eq(table.id, requestID), eq(table.recipient_session_id, sessionID)))
                .get()
                .pipe(Effect.orDie)
              if (!row || !(yield* SessionMessagingPolicy.allowed(fs, db, row.sender_session_id, sessionID)))
                return yield* new Unavailable()
              if (row.status === "completed" && !row.assistant_message_id && row.result === input.text)
                return result(row)
              if (row.status !== "needs_reply") return yield* new Conflict()
              yield* db
                .update(table)
                .set({ status: "completed", result: input.text })
                .where(eq(table.id, requestID))
                .run()
                .pipe(Effect.orDie)
              yield* SessionMessagingProjection.notify(db, requestID, "completed")
              return { requestID, status: "completed", text: input.text } satisfies Result
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die))
        yield* signal
        return saved
      }, Effect.uninterruptible),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    Database.node,
    SessionStore.node,
    SessionInbox.node,
    SessionProjector.node,
    SessionExecution.node,
    SessionMessagingPolicy.node,
    FSUtil.node,
  ],
})

const nextDepth = Effect.fnUntraced(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  const message = SessionMessageTable
  const last = yield* db
    .select({ depth: sql<number>`coalesce(${table.depth}, 0)` })
    .from(message)
    .leftJoin(outbox, eq(outbox.inbox_id, message.id))
    .leftJoin(table, or(eq(table.inbox_id, message.id), eq(table.id, outbox.request_id)))
    .where(and(eq(message.session_id, sessionID), or(eq(message.type, "user"), sql`${table.id} is not null`)))
    .orderBy(desc(message.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return (last?.depth ?? 0) + 1
})
