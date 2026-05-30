import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { db } from '../db/client.js';
import { contracts, contractVersions } from '../db/schema.js';
import { contractsBucket } from '../lib/storage.js';
import { generateContractPdf } from '../services/pdfGenerate.js';
import { extractPdfText } from '../services/textExtract.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { log } from '../lib/logger.js';
const generateRouter = new Hono();
// POST /api/generate — AI-powered contract generation → PDF
generateRouter.post('/', requireAuth, async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => null);
    if (!body)
        return c.json({ error: 'Invalid request body' }, 400);
    const { title, contractType, partyA, partyB, description, projectId, } = body;
    if (!title?.trim())
        return c.json({ error: 'Title required' }, 400);
    if (!partyA?.trim() || !partyB?.trim())
        return c.json({ error: 'Both parties required' }, 400);
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey)
        return c.json({ error: 'AI generation not configured' }, 503);
    log.info('generate', 'Contract generation requested', {
        userId: user.id,
        title,
        contractType,
    });
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite-preview-06-17' });
    const today = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
    const prompt = `Generate a professional ${contractType ?? 'contract'} between the following parties:

Party A: ${partyA}
Party B: ${partyB}
Date: ${today}
${description ? `Additional context: ${description}` : ''}

Requirements:
- Write a complete, professional legal contract
- Use proper structure with numbered sections and clear headings in ALL CAPS
- Include all standard clauses appropriate for this contract type
- Be specific, clear, and use formal legal language
- Include signature blocks at the end with space for name, title, and date
- Length: 600–900 words
- Do not include any preamble, explanation, or markdown formatting — output ONLY the contract text`;
    let contractText;
    try {
        const result = await Promise.race([
            model.generateContent(prompt),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Generation timed out')), 45000)),
        ]);
        contractText = result.response.text().trim();
    }
    catch (err) {
        log.error('generate', 'Gemini generation failed', { error: err?.message });
        return c.json({ error: 'AI generation failed. Please try again.' }, 500);
    }
    // Generate PDF
    const pdfBuffer = await generateContractPdf({ title, text: contractText });
    // Store in GCS
    const contractId = crypto.randomUUID();
    const storageKey = `contracts/${user.id}/${contractId}/original.pdf`;
    await contractsBucket.file(storageKey).save(pdfBuffer, {
        metadata: { contentType: 'application/pdf' },
        resumable: false,
    });
    // Persist contract row
    await db.insert(contracts).values({
        id: contractId,
        userId: user.id,
        projectId: projectId ?? null,
        title,
        storageKey,
        originalFilename: `${title.replace(/\s+/g, '-')}.pdf`,
        fileSizeBytes: pdfBuffer.byteLength,
    });
    // Version 1
    try {
        const extractedText = await extractPdfText(pdfBuffer);
        await db.insert(contractVersions).values({
            contractId,
            versionNumber: 1,
            text: extractedText,
            storageKey,
            authoredBy: 'owner',
            message: 'AI-generated document',
        });
    }
    catch {
        await db.insert(contractVersions).values({
            contractId,
            versionNumber: 1,
            text: contractText,
            storageKey,
            authoredBy: 'owner',
            message: 'AI-generated document',
        });
    }
    log.info('generate', 'Contract generated', { contractId, userId: user.id });
    return c.json({ contractId }, 201);
});
export default generateRouter;
