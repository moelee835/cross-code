import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261123023724_session_messaging_participation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_messaging_participation\` (
          \`session_id\` text PRIMARY KEY,
          CONSTRAINT \`fk_session_messaging_participation_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_messaging_request\` ADD \`depth\` integer DEFAULT 0 NOT NULL;`)
    })
  },
}

export default migration
