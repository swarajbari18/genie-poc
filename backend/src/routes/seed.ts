import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth.js'
import { db } from '../db/client.js'
import { projects, contracts, contractVersions, reviewSessions } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import { contractsBucket } from '../lib/storage.js'
import { htmlToPdf, contractTextToHtml } from '../services/pdfGenerate.js'
import { DEMO_PROJECTS } from '../services/demoContracts.js'
import { log } from '../lib/logger.js'
import type { HonoEnv } from '../app.js'

const seedRouter = new Hono<HonoEnv>()

// POST /api/seed/demo — creates demo projects + contracts for the current user.
// Idempotent: skips if demo data already exists.
seedRouter.post('/demo', requireAuth, async (c) => {
  const user = c.get('user')

  // Idempotency check: if any projects exist, skip
  const existingProjects = await db.query.projects.findFirst({
    where: eq(projects.userId, user.id),
  })
  if (existingProjects) {
    return c.json({ ok: true, skipped: true, message: 'Demo data already exists' })
  }

  const results: { project: string; contracts: string[] }[] = []

  for (const demo of DEMO_PROJECTS) {
    // Create project
    const [project] = await db
      .insert(projects)
      .values({ userId: user.id, name: demo.name, description: demo.description })
      .returning({ id: projects.id, name: projects.name })

    const contractNames: string[] = []

    for (const dc of demo.contracts) {
      const contractId = crypto.randomUUID()
      const storageKey = `contracts/${user.id}/${contractId}/original.pdf`

      // Generate HTML → PDF via Puppeteer
      const html = contractTextToHtml(dc.title, dc.text)
      const pdfBuffer = await htmlToPdf(html)
      await contractsBucket.file(storageKey).save(pdfBuffer, {
        metadata: { contentType: 'application/pdf' },
        resumable: false,
      })

      await db.insert(contracts).values({
        id: contractId,
        userId: user.id,
        projectId: project.id,
        title: dc.title,
        storageKey,
        originalFilename: `${dc.title.replace(/\s+/g, '-')}.pdf`,
        fileSizeBytes: pdfBuffer.byteLength,
        recipientName: dc.recipientName,
        recipientEmail: dc.recipientEmail,
        status: dc.status,
        subject: `${dc.title} — Review Requested`,
        sentAt: dc.status !== 'draft' ? new Date() : null,
      })

      // Version 1 — store the plain text for diff/review
      await db.insert(contractVersions).values({
        contractId,
        versionNumber: 1,
        text: dc.text,
        storageKey,
        authoredBy: 'owner',
        message: 'Original document',
      })

      // If the contract has counterparty changes, create v2 + a submitted review session
      if (dc.counterpartyText && dc.status === 'replied') {
        const [v1] = await db.query.contractVersions.findMany({
          where: eq(contractVersions.contractId, contractId),
        })

        const [v2] = await db
          .insert(contractVersions)
          .values({
            contractId,
            versionNumber: 2,
            text: dc.counterpartyText,
            authoredBy: 'counterparty',
            message: dc.counterpartyMessage ?? 'Counterparty proposed changes',
          })
          .returning({ id: contractVersions.id })

        // Create a submitted review session so the workspace flow is visible
        await db.insert(reviewSessions).values({
          contractId,
          token: crypto.randomUUID(),
          counterpartyEmail: dc.recipientEmail,
          status: 'submitted',
          baseVersionId: v1?.id ?? null,
          workingText: dc.counterpartyText,
          submittedVersionId: v2.id,
        })
      }

      contractNames.push(dc.title)
      log.info('seed', 'Demo contract created', { contractId, title: dc.title })
    }

    results.push({ project: project.name, contracts: contractNames })
  }

  log.info('seed', 'Demo data created', { userId: user.id, projects: results.length })
  return c.json({ ok: true, seeded: results })
})

export default seedRouter
