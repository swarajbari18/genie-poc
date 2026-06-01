import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth.js'
import { db } from '../db/client.js'
import { contracts, contractVersions } from '../db/schema.js'
import { contractsBucket } from '../lib/storage.js'
import { htmlToPdf, buildHtmlShell } from '../services/pdfGenerate.js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { log } from '../lib/logger.js'
import type { HonoEnv } from '../app.js'

const generateRouter = new Hono<HonoEnv>()

// POST /api/generate — Gemini outputs HTML → Puppeteer PDF
generateRouter.post('/', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'Invalid request body' }, 400)

  const { title, contractType, partyA, partyB, partiesA, partiesB, description, projectId } = body

  // Accept either array form (partiesA/partiesB) or legacy string form (partyA/partyB)
  const resolvedPartyA = Array.isArray(partiesA) ? partiesA.filter(Boolean).join(', ') : (partyA ?? '')
  const resolvedPartyB = Array.isArray(partiesB) ? partiesB.filter(Boolean).join(', ') : (partyB ?? '')

  if (!title?.trim()) return c.json({ error: 'Title required' }, 400)
  if (!resolvedPartyA.trim() || !resolvedPartyB.trim()) return c.json({ error: 'Both parties required' }, 400)

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return c.json({ error: 'AI generation not configured' }, 503)

  log.info('generate', 'Contract generation requested', { userId: user.id, title, contractType })

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' })

  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  })

  const prompt = `Generate a complete, professional ${contractType ?? 'contract'} as an HTML document body.

Details:
- Party A (first part): ${resolvedPartyA}
- Party B (second part): ${resolvedPartyB}
- Date: ${today}
${description ? `- Additional context: ${description}` : ''}

Output ONLY the inner HTML content (no <html>, <head>, <body>, or <style> tags — just the contract content).
Use these HTML elements:
- <h2> for numbered section headings (e.g. <h2>1. DEFINITIONS</h2>)
- <p> for body paragraphs
- <div class="parties"> to wrap the parties/recitals block
- <div class="signature-section"> containing two <div class="signature-block"> elements for the signature blocks
- Inside each signature block: <div class="signature-line"></div><p class="signature-label">Name / Title / Date</p>

Requirements:
- Complete, professional legal language
- All standard clauses for this contract type
- Numbered sections with ALL CAPS headings
- Proper signature blocks for both parties
- 600–900 words of actual contract content
- No markdown, no code fences, no preamble — output raw HTML only`

  let contractHtml: string
  try {
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Generation timed out')), 45000),
      ),
    ])
    contractHtml = result.response.text().trim()
    // Strip any accidental markdown code fences
    contractHtml = contractHtml.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim()
  } catch (err: any) {
    log.error('generate', 'Gemini generation failed', { error: err?.message })
    return c.json({ error: 'AI generation failed. Please try again.' }, 500)
  }

  // Wrap in full HTML shell and convert to PDF
  const fullHtml = buildHtmlShell(title, contractHtml)
  const pdfBuffer = await htmlToPdf(fullHtml)

  // Store PDF in GCS
  const contractId = crypto.randomUUID()
  const storageKey = `contracts/${user.id}/${contractId}/original.pdf`

  await contractsBucket.file(storageKey).save(pdfBuffer, {
    metadata: { contentType: 'application/pdf' },
    resumable: false,
  })

  // Strip HTML tags for plain-text version (used in diff viewer + review workspace)
  const plainText = contractHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

  await db.insert(contracts).values({
    id: contractId,
    userId: user.id,
    projectId: projectId ?? null,
    title,
    storageKey,
    originalFilename: `${title.replace(/[^a-zA-Z0-9-]/g, '-')}.pdf`,
    fileSizeBytes: pdfBuffer.byteLength,
  })

  await db.insert(contractVersions).values({
    contractId,
    versionNumber: 1,
    text: plainText,
    htmlContent: contractHtml,
    storageKey,
    authoredBy: 'owner',
    message: 'AI-generated document',
  })

  log.info('generate', 'Contract generated', { contractId, userId: user.id })
  return c.json({ contractId }, 201)
})

// POST /api/generate/extract — parse freeform intent into structured fields
generateRouter.post('/extract', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  if (!body?.intent?.trim()) return c.json({ error: 'Intent required' }, 400)

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return c.json({ error: 'AI generation not configured' }, 503)

  const allowedTypes = [
    'Non-Disclosure Agreement (NDA)',
    'Service Agreement',
    'Independent Contractor Agreement',
    'Employment Agreement',
    'Partnership Agreement',
    'License Agreement',
    'Consulting Agreement',
    'Letter of Intent',
  ]

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' })

  const prompt = `Extract contract details from the user's description. The user's name is "${user.name ?? 'User'}".

Description: "${body.intent.trim()}"

Reply with ONLY valid JSON — no markdown, no explanation, no code fences:
{
  "title": "short descriptive title for this contract",
  "contractType": "exactly one of: ${allowedTypes.join(' | ')}",
  "partiesA": ["array of first-party names"],
  "partiesB": ["array of second-party names"]
}

Rules:
- title: 3–8 words, proper-cased, no trailing period
- contractType: pick the closest match from the list; default to "Non-Disclosure Agreement (NDA)" if unclear
- partiesA: first/selling/disclosing side — array of individual or company names; default to ["${user.name ?? 'User'}"] if not specified
- partiesB: second/buying/receiving side — array of individual or company names; use ["Counterparty"] if not specified
- Always return arrays, even for a single party: ["Acme Corp"] not "Acme Corp"`

  try {
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Extraction timed out')), 10000),
      ),
    ])
    let text = result.response.text().trim()
    text = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim()

    const extracted = JSON.parse(text)
    if (!allowedTypes.includes(extracted.contractType)) {
      extracted.contractType = 'Non-Disclosure Agreement (NDA)'
    }
    // Normalise to arrays regardless of what Gemini returned
    if (!Array.isArray(extracted.partiesA)) {
      extracted.partiesA = extracted.partiesA ? [extracted.partiesA] : [user.name ?? 'User']
    }
    if (!Array.isArray(extracted.partiesB)) {
      extracted.partiesB = extracted.partiesB ? [extracted.partiesB] : ['Counterparty']
    }

    log.info('generate', 'Intent extracted', { userId: user.id, title: extracted.title })
    return c.json(extracted)
  } catch (err: any) {
    log.error('generate', 'Extraction failed', { error: err?.message })
    return c.json({ error: 'Extraction failed' }, 500)
  }
})

export default generateRouter
