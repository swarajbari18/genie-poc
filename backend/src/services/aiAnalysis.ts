import { db } from '../db/client.js'
import { contracts, contractThreads } from '../db/schema.js'
import { eq, and, lt, desc, sql } from 'drizzle-orm'
import { contractsBucket } from '../lib/storage.js'
import { notifyUser } from '../lib/events.js'
import { log } from '../lib/logger.js'
import { PDFParse } from 'pdf-parse'
import { diffWords, structuredPatch } from 'diff'
import { GoogleGenerativeAI } from '@google/generative-ai'

/**
 * AI Analysis JSON Shape (Component 9)
 */
export interface ContractAiAnalysis {
  version: number
  fromThreadId: string | null
  toThreadId: string
  fromStorageKey: string | null
  toStorageKey: string
  oldText: string
  newText: string
  patch: any
  stats: {
    additions: number
    deletions: number
    changedHunks: number
  }
  summary: string
  summaryStatus: 'ok' | 'skipped_no_key' | 'failed'
  model: string | null
  extractor: string
  diffEngine: string
  generatedAt: string
  error?: string
}

interface RunDiffAnalysisArgs {
  contractId: string
  ownerUserId: string
  newThreadId: string
  newAttachmentKey: string
}

export async function runDiffAnalysis({
  contractId,
  ownerUserId,
  newThreadId,
  newAttachmentKey,
}: RunDiffAnalysisArgs) {
  log.info('aiAnalysis', 'Starting AI diff analysis', { contractId, newThreadId })

  try {
    // 6.1 Mark start
    await db
      .update(contracts)
      .set({
        status: 'ai_processing',
        aiStartedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(contracts.id, contractId))

    await notifyUser(ownerUserId, { contractId, status: 'ai_processing' })

    // 6.2 Select the previous version
    const newThreadRow = await db
      .select({ emailDate: contractThreads.emailDate })
      .from(contractThreads)
      .where(eq(contractThreads.id, newThreadId))
      .then((rows) => rows[0])

    if (!newThreadRow) {
      throw new Error('New thread row not found')
    }

    const previousVersion = await db
      .select({
        id: contractThreads.id,
        attachments: contractThreads.attachments,
        emailDate: contractThreads.emailDate,
      })
      .from(contractThreads)
      .where(
        and(
          eq(contractThreads.contractId, contractId),
          lt(contractThreads.emailDate, newThreadRow.emailDate || new Date())
          // Note: jsonb_array_length check handled in JS below for Drizzle simplicity
        )
      )
      .orderBy(desc(contractThreads.emailDate))
      .then((rows) => rows.find((r) => (r.attachments?.length ?? 0) > 0))

    let fromStorageKey: string | null = null
    let fromThreadId: string | null = null

    if (previousVersion && previousVersion.attachments && previousVersion.attachments.length > 0) {
      fromStorageKey = previousVersion.attachments[0].storageKey
      fromThreadId = previousVersion.id
    } else {
      // Fallback to contract's original PDF
      const contractRow = await db
        .select({ storageKey: contracts.storageKey })
        .from(contracts)
        .where(eq(contracts.id, contractId))
        .then((rows) => rows[0])
      
      if (contractRow) {
        fromStorageKey = contractRow.storageKey
        fromThreadId = null // Not from a thread
      }
    }

    if (!fromStorageKey) {
      log.info('aiAnalysis', 'No previous version found to diff against', { contractId })
      await db
        .update(contracts)
        .set({
          status: 'replied',
          aiAnalysis: null,
          updatedAt: new Date(),
        })
        .where(eq(contracts.id, contractId))
      await notifyUser(ownerUserId, { contractId, status: 'replied' })
      return
    }

    // 6.3 Download both PDFs from GCS
    log.info('aiAnalysis', 'Downloading PDFs', { fromStorageKey, toStorageKey: newAttachmentKey })
    const [oldBuf] = await contractsBucket.file(fromStorageKey).download()
    const [newBuf] = await contractsBucket.file(newAttachmentKey).download()

    // 6.4 Extract text (pdf-parse)
    log.info('aiAnalysis', 'Extracting text')
    let oldRawText = ''
    let newRawText = ''
    try {
      const oldParser = new PDFParse({ data: oldBuf })
      oldRawText = (await oldParser.getText()).text
      await oldParser.destroy()
      const newParser = new PDFParse({ data: newBuf })
      newRawText = (await newParser.getText()).text
      await newParser.destroy()
    } catch (err: any) {
      log.error('aiAnalysis', 'Extraction failed', { error: err.message })
      const analysis: Partial<ContractAiAnalysis> = {
        version: 1,
        summaryStatus: 'failed',
        summary: '',
        error: 'extraction_failed',
        generatedAt: new Date().toISOString(),
      }
      await db
        .update(contracts)
        .set({
          aiAnalysis: analysis as any,
          aiCompletedAt: new Date(),
          status: 'completed',
          updatedAt: new Date(),
        })
        .where(eq(contracts.id, contractId))
      await notifyUser(ownerUserId, { contractId, status: 'completed' })
      return
    }

    // 6.5 Normalize
    const normalize = (text: string) => {
      return text
        .replace(/([A-Za-z])-\n([A-Za-z])/g, '$1$2') // Re-join hyphenated line breaks
        .replace(/\r\n|\r/g, '\n') // Normalize newlines
        .replace(/[ \t]+/g, ' ') // Collapse spaces/tabs
        .replace(/\n{3,}/g, '\n\n') // Cap blank-line runs
        .trim()
    }

    const oldText = normalize(oldRawText)
    const newText = normalize(newRawText)

    // 6.6 Compute the diff
    log.info('aiAnalysis', 'Computing diff')
    const patch = structuredPatch('previous.txt', 'returned.txt', oldText, newText, '', '', { context: 3 })
    
    let additions = 0
    let deletions = 0
    patch.hunks.forEach((hunk) => {
      hunk.lines.forEach((line) => {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++
        if (line.startsWith('-') && !line.startsWith('---')) deletions++
      })
    })

    // 6.7 Optional LLM Summary
    let summary = ''
    let summaryStatus: 'ok' | 'skipped_no_key' | 'failed' = 'skipped_no_key'
    let modelName: string | null = null

    const apiKey = process.env.GEMINI_API_KEY
    if (apiKey) {
      try {
        log.info('aiAnalysis', 'Generating LLM summary')
        const genAI = new GoogleGenerativeAI(apiKey)
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' })
        
        const prompt = `You summarize contract edits for a non-lawyer. You are given ONLY a diff (added/removed text). Summarize ONLY changes present in the diff. Do not infer, invent, or comment on anything not in the diff. Output 1–5 short bullet points in plain English (e.g. 'Payment term changed from 30 to 45 days'). If the diff is trivial or empty, say so.

Diff:
${JSON.stringify(patch.hunks.map(h => h.lines).flat(), null, 2)}`

        const result = await Promise.race([
          model.generateContent(prompt),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('LLM timeout')), 20000))
        ])
        
        summary = result.response.text()
        summaryStatus = 'ok'
        modelName = 'gemini-2.5-flash-lite'
      } catch (err: any) {
        log.error('aiAnalysis', 'LLM summary failed', { error: err.message })
        summaryStatus = 'failed'
      }
    }

    // 6.8 Write results
    const aiAnalysis: ContractAiAnalysis = {
      version: 1,
      fromThreadId,
      toThreadId: newThreadId,
      fromStorageKey,
      toStorageKey: newAttachmentKey,
      oldText,
      newText,
      patch,
      stats: {
        additions,
        deletions,
        changedHunks: patch.hunks.length,
      },
      summary,
      summaryStatus,
      model: modelName,
      extractor: 'pdf-parse@2.4.5',
      diffEngine: 'jsdiff@9.0.0 diffWords',
      generatedAt: new Date().toISOString(),
    }

    await db
      .update(contracts)
      .set({
        aiAnalysis: aiAnalysis as any,
        aiCompletedAt: new Date(),
        status: 'completed',
        updatedAt: new Date(),
      })
      .where(eq(contracts.id, contractId))

    await notifyUser(ownerUserId, { contractId, status: 'completed' })
    log.info('aiAnalysis', 'AI diff analysis complete', { contractId })

  } catch (err: any) {
    log.error('aiAnalysis', 'Fatal error in pipeline', { contractId, error: err.message })
    // Revert to replied so it's not stuck in processing
    await db
      .update(contracts)
      .set({ status: 'replied', updatedAt: new Date() })
      .where(eq(contracts.id, contractId))
      .catch(() => {}) // Ignore secondary failure
    await notifyUser(ownerUserId, { contractId, status: 'replied' })
  }
}
