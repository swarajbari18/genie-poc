import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const rows = await db.execute(sql`
  SELECT cv.contract_id, cv.authored_by, cv.version_number, length(cv.text) as text_len
  FROM contract_versions cv
  ORDER BY cv.contract_id, cv.version_number
  LIMIT 20
`)
console.log(JSON.stringify(rows, null, 2))
process.exit(0)
