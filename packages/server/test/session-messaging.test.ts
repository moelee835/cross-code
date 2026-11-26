import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { SessionMessaging } from "@opencode/schema/session-messaging"
import { it } from "../../core/test/lib/effect"
import { initGit } from "../../core/test/fixture/git"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { ServerFetch } from "../src/fetch"

const requestWith =
  (handler: (request: Request) => Promise<Response>) =>
  (method: string, path: string, body?: unknown, authenticated = true) =>
    Effect.promise((signal) =>
      handler(
        new Request(`http://127.0.0.1${path}`, {
          method,
          signal,
          headers: {
            "content-type": "application/json",
            ...(authenticated ? { authorization: `Basic ${btoa("opencode:test-password")}` } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      ),
    )

it.live("limits peer discovery and requests to opted-in sessions in the same repository before its first commit", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-peer-api-")
    const child = path.join(tmp.path, "src", "feature")
    const nested = path.join(tmp.path, "src", "independent")
    yield* Effect.promise(async () => {
      await mkdir(child, { recursive: true })
      await initGit(tmp.path)
      await initGit(nested)
    })
    const handler = yield* ServerFetch.make({
      sessionMessaging: true,
      hostname: "127.0.0.1",
      password: "test-password",
      database: { path: ":memory:" },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
      config: { directory: tmp.path, project: false },
    })
    const request = requestWith(handler)
    const create = (title: string, directory = tmp.path) =>
      Effect.gen(function* () {
        const response = yield* request("POST", "/api/session", { title, location: { directory } })
        expect(response.status).toBe(200)
        const { data } = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
          yield* Effect.promise(() => response.json()),
        )
        expect(data.projectID).toBe(Project.ID.global)
        return data.id
      })
    const sender = yield* create("Sender")
    const recipient = yield* create("Recipient", child)
    const stranger = yield* create("Stranger")
    const independent = yield* create("Independent", nested)
    const messaging = "/api/experimental/session-messaging"
    const sending = `${messaging}/sessions/${sender}/requests`
    const input = { recipientSessionID: recipient, text: "peer task", idempotencyKey: "test" }
    expect((yield* request("POST", sending, input, false)).status).toBe(401)
    expect((yield* request("POST", sending, input)).status).toBe(403)
    for (const id of [sender, recipient, independent]) {
      expect((yield* request("PUT", `${messaging}/sessions/${id}/participation`, { enabled: true })).status).toBe(200)
    }
    expect((yield* request("POST", sending, input)).status).toBe(403)
    const lease = yield* request("POST", `${messaging}/leases`, {
      sessions: [sender, recipient, stranger, independent],
    })
    expect(lease.status).toBe(200)
    const response = yield* request("GET", `${messaging}/sessions/${sender}/peers`)
    expect(yield* Effect.promise(() => response.json())).toEqual([
      { sessionID: recipient, title: "Recipient", busy: false },
    ])
    const reverse = yield* request("GET", `${messaging}/sessions/${recipient}/peers`)
    expect(yield* Effect.promise(() => reverse.json())).toEqual([{ sessionID: sender, title: "Sender", busy: false }])
    expect((yield* request("POST", sending, { ...input, recipientSessionID: independent })).status).toBe(403)
    const sent = yield* request("POST", sending, input)
    expect(sent.status).toBe(202)
    const receipt = Schema.decodeUnknownSync(SessionMessaging.Receipt)(yield* Effect.promise(() => sent.json()))
    expect(receipt.status).toBe("accepted")
    expect((yield* request("GET", `${messaging}/sessions/${stranger}/requests/${receipt.requestID}`)).status).toBe(403)
    expect((yield* request("POST", sending, { ...input, text: "different body" })).status).toBe(409)
  }).pipe(Effect.scoped),
)

it.live("admits requests across projects only for sessions on the same managed group lease", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("cross-code-peer-groups-")
    const elsewhere = path.join(tmp.path, "elsewhere")
    yield* Effect.promise(() => mkdir(elsewhere))
    const handler = yield* ServerFetch.make({
      sessionMessaging: true,
      sessionMessagingGroupsOnly: true,
      hostname: "127.0.0.1",
      password: "test-password",
      database: { path: ":memory:" },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
      config: { directory: tmp.path, project: false },
    })
    const request = requestWith(handler)
    const make = (title: string, directory: string) =>
      request("POST", "/api/session", { title, location: { directory } }).pipe(
        Effect.flatMap((response) => Effect.promise(() => response.json())),
        Effect.map(Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))),
        Effect.map(({ data }) => data),
      )
    const sender = yield* make("Sender", tmp.path)
    const recipient = yield* make("Recipient", elsewhere)
    const stranger = yield* make("Stranger", tmp.path)
    expect(recipient.projectID).not.toBe(sender.projectID)
    const pathPrefix = "/api/experimental/session-messaging"
    for (const { id } of [sender, recipient, stranger]) {
      expect((yield* request("PUT", `${pathPrefix}/sessions/${id}/participation`, { enabled: true })).status).toBe(200)
    }
    const leases = `${pathPrefix}/leases`
    const sessions = [sender.id, recipient.id]
    expect((yield* request("POST", leases, { sessions, groupID: "team" }, false)).status).toBe(401)
    expect((yield* request("POST", leases, { sessions })).status).toBe(403)
    const lease = yield* request("POST", leases, { sessions, groupID: "team" })
    expect(lease.status).toBe(200)
    const info = Schema.decodeUnknownSync(SessionMessaging.Lease)(yield* Effect.promise(() => lease.json()))
    expect(info.groupID).toBe("team")
    expect((yield* request("POST", leases, { sessions: [stranger.id], groupID: "other" })).status).toBe(200)
    expect((yield* request("PUT", `${leases}/${info.leaseID}`, { sessions, groupID: "other" })).status).toBe(403)
    const from = `${pathPrefix}/sessions/${sender.id}`
    const peers = yield* request("GET", `${from}/peers`)
    expect(yield* Effect.promise(() => peers.json())).toEqual([
      { sessionID: recipient.id, title: "Recipient", busy: false },
    ])
    const body = { recipientSessionID: recipient.id, text: "Review the design", idempotencyKey: "review" }
    expect((yield* request("POST", `${from}/requests`, { ...body, recipientSessionID: stranger.id })).status).toBe(403)
    expect((yield* request("POST", `${from}/requests`, body)).status).toBe(202)
    expect((yield* request("DELETE", `${leases}/${info.leaseID}`)).status).toBe(204)
    expect((yield* request("POST", `${from}/requests`, { ...body, idempotencyKey: "after-close" })).status).toBe(403)
  }).pipe(Effect.scoped),
)
