import { runDiffAnalysis } from './backend/src/services/aiAnalysis.js'
import { db } from './backend/src/db/client.js'
import { contracts, contractThreads } from './backend/src/db/schema.js'
import { eq } from 'drizzle-orm'
import { log } from './backend/src/lib/logger.js'

async function test() {
  const contractId = process.argv[2]
  const ownerUserId = process.argv[3]
  const newThreadId = process.argv[4]
  const newAttachmentKey = process.argv[5]

  if (!contractId || !ownerUserId || !newThreadId || !newAttachmentKey) {
    console.log('Usage: node test-ai-diff.mjs <contractId> <ownerUserId> <newThreadId> <newAttachmentKey>')
    process.exit(1)
  }

  console.log('Starting test run for AI diff analysis...')
  try {
    // Check if contract exists
    const contract = await db.query.contracts.findFirst({
      where: eq(contracts.id, contractId)
    })
    if (!contract) {
      console.error(`Contract ${contractId} not found`)
      process.exit(1)
    }

    await runDiffAnalysis({
      contractId,
      ownerUserId,
      newThreadId,
      newAttachmentKey
    })
    console.log('Test run complete.')
  } catch (err) {
    console.error('Test run failed:', err)
  }
}

test()
