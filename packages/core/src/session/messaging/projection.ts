export * as SessionMessagingProjection from "./projection.js"

import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../../database/database.js"
import type { SessionMessage } from "../message.js"
import type { SessionSchema } from "../schema.js"
import { SessionMessagingRequestTable } from "../sql.js"

type Request = typeof SessionMessagingRequestTable.$inferSelect
type InboxRef = { readonly sessionID: SessionSchema.ID; readonly inboxID: SessionMessage.ID }

export function transition(
  db: Database.Interface["db"],
  ref: InboxRef,
  from: Request["status"],
  values: Pick<Request, "status"> & Partial<Pick<Request, "delivered_seq">>,
) {
  const table = SessionMessagingRequestTable
  return db
    .update(table)
    .set(values)
    .where(and(eq(table.inbox_id, ref.inboxID), eq(table.recipient_session_id, ref.sessionID), eq(table.status, from)))
    .run()
    .pipe(Effect.orDie)
}
