import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { SessionMessaging } from "@opencode/schema/session-messaging"
import { it } from "../../core/test/lib/effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { ServerFetch } from "../src/fetch"

it.live("accepts requests from authenticated, opted-in open peers and returns HTTP 202", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-peer-api-")
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
    const create = (title: string) =>
      Effect.gen(function* () {
        const response = yield* request("POST", "/api/session", { title, location: { directory: tmp.path } })
        expect(response.status).toBe(200)
        return Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
          yield* Effect.promise(() => response.json()),
        ).data.id
      })
    const sender = yield* create("Sender")
    const recipient = yield* create("Recipient")
    const stranger = yield* create("Stranger")
    const path = "/api/experimental/session-messaging"
    const sending = `${path}/sessions/${sender}/requests`
    const input = { recipientSessionID: recipient, text: "peer task", idempotencyKey: "test" }
    expect((yield* request("POST", sending, input, false)).status).toBe(401)
    expect((yield* request("POST", sending, input)).status).toBe(403)
    for (const id of [sender, recipient]) {
      expect((yield* request("PUT", `${path}/sessions/${id}/participation`, { enabled: true })).status).toBe(200)
    }
    expect((yield* request("POST", sending, input)).status).toBe(403)
    const lease = yield* request("POST", `${path}/leases`, { sessions: [sender, recipient, stranger] })
    expect(lease.status).toBe(200)
    const response = yield* request("GET", `${path}/sessions/${sender}/peers`)
    expect(yield* Effect.promise(() => response.json())).toEqual([
      { sessionID: recipient, title: "Recipient", busy: false },
    ])
    const sent = yield* request("POST", sending, input)
    expect(sent.status).toBe(202)
    const receipt = Schema.decodeUnknownSync(SessionMessaging.Receipt)(yield* Effect.promise(() => sent.json()))
    expect(receipt.status).toBe("accepted")
    expect((yield* request("GET", `${path}/sessions/${stranger}/requests/${receipt.requestID}`)).status).toBe(403)
    expect((yield* request("POST", sending, { ...input, text: "different body" })).status).toBe(409)
  }).pipe(Effect.scoped),
)
