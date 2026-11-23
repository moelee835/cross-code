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
    const request = (method: string, path: string, body?: unknown, authenticated = true) =>
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
