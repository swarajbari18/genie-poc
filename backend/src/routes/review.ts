import { Hono } from 'hono'
import { db } from '../db/client.js'
import {
  reviewSessions,
  reviewMessages,
  contractVersions,
  contracts,
  contractThreads,
} from '../db/schema.js'
import { eq, and, desc, asc, sql } from 'drizzle-orm'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { log } from '../lib/logger.js'
import { notifyUser } from '../lib/events.js'
import { getServiceEmailByUserId } from '../services/serviceEmail.js'
import { sendReviewSubmittedEmail } from '../services/postmarkClient.js'

const reviewRouter = new Hono()

// GET /api/review/:token — load session for the review workspace (public)
reviewRouter.get('/:token', async (c) => {
  const token = c.req.param('token')

  const session = await db.query.reviewSessions.findFirst({
    where: eq(reviewSessions.token, token),
  })
  if (!session) return c.json({ error: 'Not found' }, 404)

  const contract = await db.query.contracts.findFirst({
    where: eq(contracts.id, session.contractId),
  })
  if (!contract) return c.json({ error: 'Contract not found' }, 404)

  // Resolve base version text
  const baseVersion = session.baseVersionId
    ? await db.query.contractVersions.findFirst({
        where: eq(contractVersions.id, session.baseVersionId),
      })
    : await db.query.contractVersions.findFirst({
        where: eq(contractVersions.contractId, session.contractId),
        orderBy: [asc(contractVersions.versionNumber)],
      })

  const messages = await db.query.reviewMessages.findMany({
    where: eq(reviewMessages.reviewSessionId, session.id),
    orderBy: [asc(reviewMessages.createdAt)],
  })

  return c.json({
    session: {
      id: session.id,
      status: session.status,
      workingText: session.workingText ?? baseVersion?.text ?? '',
      contractTitle: contract.title,
      counterpartyEmail: session.counterpartyEmail,
    },
    originalText: baseVersion?.text ?? '',
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      suggestedText: m.suggestedText,
    })),
  })
})

// PATCH /api/review/:token/text — auto-save working text
reviewRouter.patch('/:token/text', async (c) => {
  const token = c.req.param('token')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.text !== 'string') return c.json({ error: 'Invalid body' }, 400)

  const session = await db.query.reviewSessions.findFirst({
    where: and(eq(reviewSessions.token, token), eq(reviewSessions.status, 'active')),
  })
  if (!session) return c.json({ error: 'Not found or already submitted' }, 404)

  await db
    .update(reviewSessions)
    .set({ workingText: body.text, updatedAt: new Date() })
    .where(eq(reviewSessions.id, session.id))

  return c.json({ ok: true })
})

// POST /api/review/:token/chat — AI-assisted editing
reviewRouter.post('/:token/chat', async (c) => {
  const token = c.req.param('token')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return c.json({ error: 'Message required' }, 400)
  }

  const session = await db.query.reviewSessions.findFirst({
    where: and(eq(reviewSessions.token, token), eq(reviewSessions.status, 'active')),
  })
  if (!session) return c.json({ error: 'Not found or already submitted' }, 404)

  await db.insert(reviewMessages).values({
    reviewSessionId: session.id,
    role: 'user',
    content: body.message,
  })

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    const fallback = 'AI assistant is not configured. Make your changes directly in the editor.'
    await db.insert(reviewMessages).values({
      reviewSessionId: session.id,
      role: 'assistant',
      content: fallback,
    })
    return c.json({ role: 'assistant', content: fallback, suggestedText: null })
  }

  const contractText =
    typeof body.currentText === 'string' ? body.currentText : session.workingText ?? ''

  try {
    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' })

    const prompt = `You are a contract negotiation assistant. The user is reviewing a contract and wants to propose a specific change. Apply their request to the full contract text and return it.

CONTRACT TEXT:
${contractText}

USER REQUEST: ${body.message}

Respond in EXACTLY this format — no other text:
EXPLANATION: [1-2 sentences describing what you changed]
UPDATED_TEXT:
[complete updated contract text with the change applied]`

    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI timeout')), 30000),
      ),
    ])

    const raw = result.response.text()
    const explanationMatch = raw.match(/^EXPLANATION:\s*(.+?)(?=\nUPDATED_TEXT:)/s)
    const updatedTextMatch = raw.match(/UPDATED_TEXT:\s*\n([\s\S]+)$/)

    const explanation =
      explanationMatch?.[1]?.trim() ?? 'Here is the updated contract with your changes applied.'
    const suggestedText = updatedTextMatch?.[1]?.trim() ?? null

    await db.insert(reviewMessages).values({
      reviewSessionId: session.id,
      role: 'assistant',
      content: explanation,
      suggestedText,
    })

    log.info('review', 'AI suggestion generated', {
      sessionId: session.id,
      hasSuggestion: !!suggestedText,
    })
    return c.json({ role: 'assistant', content: explanation, suggestedText })
  } catch (err: any) {
    log.error('review', 'AI chat failed', { sessionId: session.id, error: err?.message })
    const msg = 'Sorry, I could not process that. Please try again or edit directly.'
    await db.insert(reviewMessages).values({
      reviewSessionId: session.id,
      role: 'assistant',
      content: msg,
    })
    return c.json({ role: 'assistant', content: msg, suggestedText: null })
  }
})

// POST /api/review/:token/submit — counterparty finalises and sends changes back
reviewRouter.post('/:token/submit', async (c) => {
  const token = c.req.param('token')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.text !== 'string') return c.json({ error: 'Text required' }, 400)

  const session = await db.query.reviewSessions.findFirst({
    where: and(eq(reviewSessions.token, token), eq(reviewSessions.status, 'active')),
  })
  if (!session) return c.json({ error: 'Not found or already submitted' }, 404)

  const contract = await db.query.contracts.findFirst({
    where: eq(contracts.id, session.contractId),
  })
  if (!contract) return c.json({ error: 'Contract not found' }, 404)

  // Next version number
  const latestVersion = await db.query.contractVersions.findFirst({
    where: eq(contractVersions.contractId, session.contractId),
    orderBy: [desc(contractVersions.versionNumber)],
  })
  const nextVersionNumber = (latestVersion?.versionNumber ?? 0) + 1

  const [newVersion] = await db
    .insert(contractVersions)
    .values({
      contractId: session.contractId,
      versionNumber: nextVersionNumber,
      text: body.text,
      authoredBy: 'counterparty',
      message: body.message || `Proposed changes (v${nextVersionNumber})`,
    })
    .returning({ id: contractVersions.id })

  await db
    .update(reviewSessions)
    .set({
      status: 'submitted',
      workingText: body.text,
      submittedVersionId: newVersion.id,
      updatedAt: new Date(),
    })
    .where(eq(reviewSessions.id, session.id))

  await db
    .update(contracts)
    .set({ status: 'replied', updatedAt: new Date() })
    .where(eq(contracts.id, session.contractId))

  const senderAddress = session.counterpartyEmail ?? 'counterparty@review'
  await db.insert(contractThreads).values({
    contractId: session.contractId,
    direction: 'inbound',
    fromAddress: senderAddress,
    toAddress: contract.recipientEmail ?? 'owner',
    subject: `Re: ${contract.title} — Proposed Changes`,
    bodyText:
      body.message ||
      'Counterparty submitted proposed changes via the review workspace. View the diff on the contract page.',
    emailDate: new Date(),
  })

  notifyUser(contract.userId, { contractId: session.contractId, status: 'replied' }).catch(() => {})

  // Non-blocking email to owner
  const ownerServiceEmail = await getServiceEmailByUserId(contract.userId)
  if (ownerServiceEmail) {
    const ownerRows = await db.execute(
      sql`SELECT email, name FROM "user" WHERE id = ${contract.userId} LIMIT 1`,
    )
    if (ownerRows.length > 0) {
      const owner = ownerRows[0] as { email: string; name: string | null }
      sendReviewSubmittedEmail({
        fromAddress: ownerServiceEmail,
        toAddress: owner.email,
        toName: owner.name ?? owner.email,
        contractTitle: contract.title,
        contractId: session.contractId,
        counterpartyEmail: senderAddress,
        versionNumber: nextVersionNumber,
      }).catch((err) => {
        log.error('review', 'Owner notification email failed', { error: err?.message })
      })
    }
  }

  log.info('review', 'Review submitted', {
    contractId: session.contractId,
    versionNumber: nextVersionNumber,
  })
  return c.json({ ok: true, versionNumber: nextVersionNumber })
})

export default reviewRouter
