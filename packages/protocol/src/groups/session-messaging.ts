import { Session } from "@opencode/schema/session"
import { SessionMessaging } from "@opencode/schema/session-messaging"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api"
import { ConflictError, ForbiddenError, InvalidRequestError } from "../errors.js"

const path = "/api/experimental/session-messaging"
const session = `${path}/sessions/:sessionID`
const request = `${session}/requests/:requestID`
const params = { sessionID: Session.ID }
const requestParams = { ...params, requestID: SessionMessaging.ID }
const leaseParams = { leaseID: SessionMessaging.LeaseID }
const errors = [ForbiddenError, ConflictError, InvalidRequestError] as const

const description = (method: string, summary: string) =>
  OpenApi.annotations({
    identifier: `experimental.session-messaging.${method}`,
    summary,
    description: "Experimental: may change without compatibility guarantees.",
  })

export const SessionMessagingEndpoints = [
  HttpApiEndpoint.get("sessionMessaging.participation", `${session}/participation`, {
    params,
    success: SessionMessaging.Participation,
    error: ForbiddenError,
  }).annotateMerge(description("participation", "Read session participation")),
  HttpApiEndpoint.put("sessionMessaging.setParticipation", `${session}/participation`, {
    params,
    payload: SessionMessaging.Participation,
    success: SessionMessaging.Participation,
    error: ForbiddenError,
  }).annotateMerge(description("setParticipation", "Set session participation")),
  HttpApiEndpoint.post("sessionMessaging.openLease", `${path}/leases`, {
    payload: SessionMessaging.LeaseInput,
    success: SessionMessaging.Lease,
    error: ForbiddenError,
  }).annotateMerge(description("openLease", "Register the client's open sessions")),
  HttpApiEndpoint.put("sessionMessaging.refreshLease", `${path}/leases/:leaseID`, {
    params: leaseParams,
    payload: SessionMessaging.LeaseInput,
    success: SessionMessaging.Lease,
    error: ForbiddenError,
  }).annotateMerge(description("refreshLease", "Refresh the client's open sessions")),
  HttpApiEndpoint.delete("sessionMessaging.closeLease", `${path}/leases/:leaseID`, {
    params: leaseParams,
    success: HttpApiSchema.NoContent,
  }).annotateMerge(description("closeLease", "Release the client's session lease")),
  HttpApiEndpoint.get("sessionMessaging.peers", `${session}/peers`, {
    params,
    success: Schema.Array(SessionMessaging.Peer),
    error: ForbiddenError,
  }).annotateMerge(description("peers", "List participating open peer sessions")),
  HttpApiEndpoint.post("sessionMessaging.send", `${session}/requests`, {
    params,
    payload: SessionMessaging.Send,
    success: SessionMessaging.Receipt.pipe(HttpApiSchema.status(202)),
    error: errors,
  }).annotateMerge(description("send", "Accept a peer message without waiting for its result")),
  HttpApiEndpoint.get("sessionMessaging.result", request, {
    params: requestParams,
    success: SessionMessaging.Result,
    error: ForbiddenError,
  }).annotateMerge(description("result", "Read the current result without waiting")),
  HttpApiEndpoint.post("sessionMessaging.reply", `${request}/reply`, {
    params: requestParams,
    payload: SessionMessaging.Reply,
    success: SessionMessaging.Result,
    error: errors,
  }).annotateMerge(description("reply", "Reply explicitly to a peer request that requires it")),
] as const
