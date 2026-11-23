import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261123023153_session_messaging_results",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_messaging_outbox\` (
          \`inbox_id\` text PRIMARY KEY,
          \`request_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`state\` text NOT NULL,
          CONSTRAINT \`fk_session_messaging_outbox_request_id_session_messaging_request_id_fk\` FOREIGN KEY (\`request_id\`) REFERENCES \`session_messaging_request\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_messaging_request\` ADD \`assistant_message_id\` text;`)
      yield* tx.run(`ALTER TABLE \`session_messaging_request\` ADD \`result\` text;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_messaging_outbox_request_kind_idx\` ON \`session_messaging_outbox\` (\`request_id\`,\`kind\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_messaging_outbox_state_idx\` ON \`session_messaging_outbox\` (\`state\`,\`inbox_id\`);`,
      )
    })
  },
}

export default migration
