import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261126015347_managed_peer_groups",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_messaging_request\` ADD \`group_id\` text;`)
    })
  },
}

export default migration
