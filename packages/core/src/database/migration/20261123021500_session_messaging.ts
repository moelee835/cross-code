import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261123021500_session_messaging",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_messaging_request\` (
          \`id\` text PRIMARY KEY,
          \`sender_session_id\` text NOT NULL,
          \`recipient_session_id\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`inbox_id\` text NOT NULL,
          \`body\` text NOT NULL,
          \`status\` text NOT NULL,
          \`delivered_seq\` integer,
          CONSTRAINT \`fk_session_messaging_request_sender_session_id_session_v2_id_fk\` FOREIGN KEY (\`sender_session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_messaging_request_recipient_session_id_session_v2_id_fk\` FOREIGN KEY (\`recipient_session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_messaging_request_sender_key_idx\` ON \`session_messaging_request\` (\`sender_session_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_messaging_request_inbox_idx\` ON \`session_messaging_request\` (\`inbox_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_messaging_request_status_idx\` ON \`session_messaging_request\` (\`status\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_messaging_request_recipient_status_idx\` ON \`session_messaging_request\` (\`recipient_session_id\`,\`status\`);`,
      )
    })
  },
}

export default migration
