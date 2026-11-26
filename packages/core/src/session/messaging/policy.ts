export * as SessionMessagingPolicy from "./policy.js"

import { and, eq, inArray, isNull } from "drizzle-orm"
import { Clock, Context, Data, Effect, Layer } from "effect"
import { isAbsolute } from "node:path"
import { SessionMessaging } from "@opencode/schema/session-messaging"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { FSUtil } from "@opencode/util/fs-util"
import { sameDirectory } from "@opencode/util/path"
import { Database } from "../../database/database.js"
import { Project } from "../../project.js"
import { AbsolutePath } from "../../schema.js"
import type { SessionSchema } from "../schema.js"
import type { SessionMessage } from "../message.js"
import {
  SessionMessagingOutboxTable,
  SessionMessagingParticipationTable,
  SessionMessagingRequestTable,
  SessionTable,
} from "../sql.js"

type DB = Database.Interface["db"]
type ID = SessionSchema.ID
const participants = SessionMessagingParticipationTable

export interface Interface {
  readonly enabled: boolean
  readonly groupsOnly: boolean
  readonly open: Effect.Effect<ReadonlySet<ID>>
  readonly group: (sessionID: ID) => Effect.Effect<string | undefined>
  readonly permits: (groupID: string, sessions: ReadonlyArray<ID>) => Effect.Effect<boolean>
  readonly lease: (
    sessions: ReadonlyArray<ID>,
    leaseID?: SessionMessaging.LeaseID,
    groupID?: string,
  ) => Effect.Effect<SessionMessaging.Lease | undefined>
  readonly close: (id: SessionMessaging.LeaseID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionMessagingPolicy") {}

export interface Admission {
  readonly fs: FSUtil.Interface
  readonly policy: Interface
}

const layer = (enabled: boolean, groupsOnly: boolean) =>
  Layer.effect(
    Service,
    Effect.sync(() => {
      const leases = new Map<
        SessionMessaging.LeaseID,
        { readonly sessions: ReadonlyArray<ID>; readonly expiresAt: number; readonly groupID?: string }
      >()
      const active = (now: number) => {
        for (const [id, lease] of leases) if (lease.expiresAt <= now) leases.delete(id)
        return leases.values()
      }
      return Service.of({
        enabled,
        groupsOnly,
        open: Clock.currentTimeMillis.pipe(
          Effect.map((now) => new Set(Array.from(active(now)).flatMap((lease) => lease.sessions))),
        ),
        group: (sessionID) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => Array.from(active(now)).find((lease) => lease.sessions.includes(sessionID))?.groupID),
          ),
        permits: (groupID, sessions) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) =>
              Array.from(active(now)).some(
                (lease) => lease.groupID === groupID && sessions.every((id) => lease.sessions.includes(id)),
              ),
            ),
          ),
        lease: (sessions, id, groupID) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              active(now)
              if (!enabled || sessions.length > 128 || (id ? !leases.has(id) : leases.size >= 128)) return undefined
              if (groupsOnly !== (groupID !== undefined)) return undefined
              if (groupID !== undefined) {
                if (id && leases.get(id)?.groupID !== groupID) return undefined
                for (const [otherID, lease] of leases) {
                  if (otherID === id) continue
                  if (lease.groupID === groupID || sessions.some((session) => lease.sessions.includes(session)))
                    return undefined
                }
              }
              const leaseID = id ?? SessionMessaging.LeaseID.create()
              const expiresAt = now + 30_000
              leases.set(leaseID, { expiresAt, sessions: [...new Set(sessions)], groupID })
              return { leaseID, expiresAt, groupID }
            }),
          ),
        close: (id) =>
          Effect.sync(() => {
            leases.delete(id)
          }),
      })
    }),
  )

export const configured = (enabled: boolean, groupsOnly = false) =>
  makeGlobalNode({ service: Service, layer: layer(enabled, groupsOnly), deps: [] })
export const node = configured(false)

export const eligible = (db: DB, ids: ReadonlyArray<ID>) =>
  db
    .select({
      id: SessionTable.id,
      title: SessionTable.title,
      project: SessionTable.project_id,
      directory: SessionTable.directory,
    })
    .from(SessionTable)
    .where(
      and(
        inArray(SessionTable.id, [...ids]),
        isNull(SessionTable.time_archived),
        isNull(SessionTable.parent_id),
        isNull(SessionTable.workspace_id),
      ),
    )
    .all()
    .pipe(Effect.orDie)

export const participating = (db: DB, ids: ReadonlyArray<ID>) =>
  db
    .select({
      id: SessionTable.id,
      title: SessionTable.title,
      project: SessionTable.project_id,
      directory: SessionTable.directory,
    })
    .from(SessionTable)
    .innerJoin(participants, eq(participants.session_id, SessionTable.id))
    .where(
      and(
        inArray(SessionTable.id, [...ids]),
        isNull(SessionTable.time_archived),
        isNull(SessionTable.parent_id),
        isNull(SessionTable.workspace_id),
      ),
    )
    .all()
    .pipe(Effect.orDie)

type Address = { readonly directory: string; readonly project: Project.ID }

const repositoryRoot = Effect.fnUntraced(function* (fs: FSUtil.Interface, directory: string) {
  if (!isAbsolute(directory)) return undefined
  const canonical = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))
  if (canonical === undefined) return undefined
  return yield* Project.root(fs, AbsolutePath.make(canonical))
})

export const matchingProject = Effect.fnUntraced(function* <A extends Address>(
  fs: FSUtil.Interface,
  sender: Address,
  candidates: ReadonlyArray<A>,
) {
  const peers = candidates.filter((peer) => peer.project === sender.project)
  if (sender.project !== Project.ID.global || peers.every((peer) => peer.directory === sender.directory)) return peers

  // Repositories without a stable project ID share "global". Use the nearest
  // repository marker so independently initialized nested repositories stay separate.
  const root = yield* repositoryRoot(fs, sender.directory)
  return yield* Effect.filter(
    peers,
    (peer) =>
      Effect.gen(function* () {
        if (peer.directory === sender.directory) return true
        if (root === undefined) return false
        const candidate = yield* repositoryRoot(fs, peer.directory)
        return candidate !== undefined && sameDirectory(root, candidate)
      }),
    { concurrency: 8 },
  )
})

export const allowed = Effect.fnUntraced(function* (
  { fs, policy }: Admission,
  db: DB,
  sender: ID,
  recipient: ID,
  groupID: string | null,
) {
  if (sender === recipient) return false
  const [first, second] = yield* participating(db, [sender, recipient])
  if (first === undefined || second === undefined) return false
  if (policy.groupsOnly) return groupID !== null && (yield* policy.permits(groupID, [sender, recipient]))
  if (groupID !== null) return false
  return (yield* matchingProject(fs, first, [second])).length > 0
})

export class Revoked extends Data.TaggedError("SessionMessaging.Revoked") {}

export const guardPromotion = Effect.fnUntraced(function* (db: DB, inboxID: SessionMessage.ID, admission?: Admission) {
  const requests = SessionMessagingRequestTable
  const outbox = SessionMessagingOutboxTable
  const request = yield* db
    .select({ sender: requests.sender_session_id, recipient: requests.recipient_session_id, group: requests.group_id })
    .from(requests)
    .where(eq(requests.inbox_id, inboxID))
    .get()
    .pipe(Effect.orDie)
  if (request) {
    if (!admission || !(yield* allowed(admission, db, request.sender, request.recipient, request.group)))
      return yield* Effect.die(new Revoked())
    return
  }
  const notification = yield* db
    .select({ sender: requests.sender_session_id, recipient: requests.recipient_session_id, group: requests.group_id })
    .from(outbox)
    .innerJoin(requests, eq(outbox.request_id, requests.id))
    .where(eq(outbox.inbox_id, inboxID))
    .get()
    .pipe(Effect.orDie)
  if (!notification) return
  if (!admission) return yield* Effect.die(new Revoked())
  const permitted =
    notification.group === null && !admission.policy.groupsOnly
      ? (yield* participating(db, [notification.sender])).length > 0
      : yield* allowed(admission, db, notification.sender, notification.recipient, notification.group)
  if (!permitted) return yield* Effect.die(new Revoked())
})
