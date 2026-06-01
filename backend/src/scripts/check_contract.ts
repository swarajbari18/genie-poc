import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const contractId = 'e9392041-0e89-4b46-ab35-d6bce4698df9'

// Check contract status
const cRows = await db.execute(sql`
  SELECT id, title, status, user_id FROM contracts WHERE id = ${contractId}
`)
console.log('Contract:', JSON.stringify(cRows[0], null, 2))

// Simulate the LATERAL query we fixed — check text is now returned
const rows = await db.execute(sql`
  SELECT
    v_agg.versions
  FROM contracts c
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      json_agg(
        jsonb_build_object(
          'id',            v.id,
          'versionNumber', v.version_number,
          'authoredBy',    v.authored_by,
          'text',          v.text,
          'message',       v.message
        ) ORDER BY v.version_number ASC
      ),
      '[]'::json
    ) AS versions
    FROM contract_versions v
    WHERE v.contract_id = c.id
  ) v_agg ON true
  WHERE c.id = ${contractId}
`)

const versions = (rows[0] as any).versions as any[]
console.log('\nVersions count:', versions.length)
for (const v of versions) {
  console.log(`  v${v.versionNumber} authored_by=${v.authoredBy} text_len=${v.text?.length ?? 'MISSING'}`)
}
process.exit(0)
