import { Hono } from 'hono';
import { db } from '../db/client.js';
import { reviewSessions, reviewMessages, contractVersions, contracts, contractThreads, } from '../db/schema.js';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { log } from '../lib/logger.js';
import { notifyUser } from '../lib/events.js';
import { getServiceEmailByUserId } from '../services/serviceEmail.js';
import { sendReviewSubmittedEmail } from '../services/postmarkClient.js';
// ── Document editing tools ───────────────────────────────────────────────────
const TOOL_DECLARATIONS = [
    {
        name: 'replace_text',
        description: 'Find an exact string in the contract and replace it with new text. Use this for targeted word, phrase, or clause changes.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                find: { type: SchemaType.STRING, description: 'Exact text to find (copy verbatim from the contract)' },
                replace: { type: SchemaType.STRING, description: 'Text to put in its place' },
            },
            required: ['find', 'replace'],
        },
    },
    {
        name: 'replace_section',
        description: 'Replace an entire numbered section identified by its heading (e.g. "8. GOVERNING LAW").',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                section: { type: SchemaType.STRING, description: 'Section heading or number as it appears in the contract' },
                new_content: { type: SchemaType.STRING, description: 'Full replacement text for this section, including the heading' },
            },
            required: ['section', 'new_content'],
        },
    },
    {
        name: 'insert_clause',
        description: 'Insert a new clause immediately after a named section.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                after_section: { type: SchemaType.STRING, description: 'Heading of the section to insert after' },
                clause_text: { type: SchemaType.STRING, description: 'Full text of the new clause to insert, including its heading' },
            },
            required: ['after_section', 'clause_text'],
        },
    },
    {
        name: 'delete_section',
        description: 'Remove an entire section from the contract.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                section: { type: SchemaType.STRING, description: 'Section heading or number to delete' },
            },
            required: ['section'],
        },
    },
];
function applyTool(text, toolName, args) {
    const isSectionHeading = (line) => /^\d+\./.test(line.trim()) || /^[A-Z][A-Z\s.,()-]{4,}$/.test(line.trim());
    if (toolName === 'replace_text') {
        const { find, replace } = args;
        if (!text.includes(find))
            return { success: false, newText: text, message: 'Text not found — try a shorter verbatim quote from the contract' };
        return { success: true, newText: text.replace(find, replace), message: 'replaced' };
    }
    if (toolName === 'replace_section') {
        const { section, new_content } = args;
        const lines = text.split('\n');
        const startIdx = lines.findIndex(l => l.toLowerCase().includes(section.toLowerCase()));
        if (startIdx === -1)
            return { success: false, newText: text, message: 'Section not found' };
        const endIdx = lines.findIndex((l, i) => i > startIdx + 1 && isSectionHeading(l));
        const before = lines.slice(0, startIdx).join('\n');
        const after = endIdx === -1 ? '' : '\n' + lines.slice(endIdx).join('\n');
        return { success: true, newText: before + '\n' + new_content + after, message: 'replaced' };
    }
    if (toolName === 'insert_clause') {
        const { after_section, clause_text } = args;
        const lines = text.split('\n');
        const startIdx = lines.findIndex(l => l.toLowerCase().includes(after_section.toLowerCase()));
        const endIdx = startIdx === -1 ? -1
            : lines.findIndex((l, i) => i > startIdx + 1 && isSectionHeading(l));
        const insertAt = endIdx === -1 ? lines.length : endIdx;
        const before = lines.slice(0, insertAt).join('\n');
        const after = lines.slice(insertAt).join('\n');
        return { success: true, newText: before + '\n\n' + clause_text + (after ? '\n\n' + after : ''), message: 'inserted' };
    }
    if (toolName === 'delete_section') {
        const { section } = args;
        const lines = text.split('\n');
        const startIdx = lines.findIndex(l => l.toLowerCase().includes(section.toLowerCase()));
        if (startIdx === -1)
            return { success: false, newText: text, message: 'Section not found' };
        const endIdx = lines.findIndex((l, i) => i > startIdx + 1 && isSectionHeading(l));
        const before = lines.slice(0, startIdx).join('\n');
        const after = endIdx === -1 ? '' : '\n' + lines.slice(endIdx).join('\n');
        return { success: true, newText: (before + after).replace(/\n{3,}/g, '\n\n'), message: 'deleted' };
    }
    return { success: false, newText: text, message: 'Unknown tool' };
}
const reviewRouter = new Hono();
// GET /api/review/:token — load session for the review workspace (public)
reviewRouter.get('/:token', async (c) => {
    const token = c.req.param('token');
    const session = await db.query.reviewSessions.findFirst({
        where: eq(reviewSessions.token, token),
    });
    if (!session)
        return c.json({ error: 'Not found' }, 404);
    const contract = await db.query.contracts.findFirst({
        where: eq(contracts.id, session.contractId),
    });
    if (!contract)
        return c.json({ error: 'Contract not found' }, 404);
    // Resolve base version text
    const baseVersion = session.baseVersionId
        ? await db.query.contractVersions.findFirst({
            where: eq(contractVersions.id, session.baseVersionId),
        })
        : await db.query.contractVersions.findFirst({
            where: eq(contractVersions.contractId, session.contractId),
            orderBy: [asc(contractVersions.versionNumber)],
        });
    const messages = await db.query.reviewMessages.findMany({
        where: eq(reviewMessages.reviewSessionId, session.id),
        orderBy: [asc(reviewMessages.createdAt)],
    });
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
    });
});
// PATCH /api/review/:token/text — auto-save working text
reviewRouter.patch('/:token/text', async (c) => {
    const token = c.req.param('token');
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== 'string')
        return c.json({ error: 'Invalid body' }, 400);
    const session = await db.query.reviewSessions.findFirst({
        where: and(eq(reviewSessions.token, token), eq(reviewSessions.status, 'active')),
    });
    if (!session)
        return c.json({ error: 'Not found or already submitted' }, 404);
    await db
        .update(reviewSessions)
        .set({ workingText: body.text, updatedAt: new Date() })
        .where(eq(reviewSessions.id, session.id));
    return c.json({ ok: true });
});
// POST /api/review/:token/chat — ReAct agent with document editing tools
reviewRouter.post('/:token/chat', async (c) => {
    const token = c.req.param('token');
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
        return c.json({ error: 'Message required' }, 400);
    }
    const session = await db.query.reviewSessions.findFirst({
        where: and(eq(reviewSessions.token, token), eq(reviewSessions.status, 'active')),
    });
    if (!session)
        return c.json({ error: 'Not found or already submitted' }, 404);
    await db.insert(reviewMessages).values({
        reviewSessionId: session.id,
        role: 'user',
        content: body.message,
    });
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        const fallback = 'AI assistant is not configured. Make your changes directly in the editor.';
        await db.insert(reviewMessages).values({ reviewSessionId: session.id, role: 'assistant', content: fallback });
        return c.json({ role: 'assistant', content: fallback, suggestedText: null });
    }
    const contractText = typeof body.currentText === 'string' ? body.currentText : session.workingText ?? '';
    // Build chat history from previous messages (all except the one we just inserted)
    const allMessages = await db.query.reviewMessages.findMany({
        where: eq(reviewMessages.reviewSessionId, session.id),
        orderBy: [asc(reviewMessages.createdAt)],
    });
    const historyMessages = allMessages.slice(0, -1);
    // Convert to Gemini Content format, collapsing consecutive same-role messages
    const history = [];
    for (const msg of historyMessages) {
        const role = msg.role === 'user' ? 'user' : 'model';
        if (history.length > 0 && history[history.length - 1].role === role)
            continue;
        history.push({ role, parts: [{ text: msg.content }] });
    }
    // Gemini requires history to start with a user turn
    while (history.length > 0 && history[0].role !== 'user')
        history.shift();
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash-lite',
            systemInstruction: `You are a contract review assistant. A counterparty is reviewing the following contract and may ask questions or request changes.

CONTRACT:
${contractText}

Rules:
- Answer questions conversationally without calling any tool.
- When the user requests a change, use the available tools to apply it. You may call multiple tools for a single request.
- After applying changes, confirm briefly what you changed.
- Never rewrite the full contract in your text reply — use tools for edits.`,
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        });
        const chat = model.startChat({ history });
        let response = await chat.sendMessage(body.message);
        let proposedText = contractText;
        // ReAct loop — execute tool calls until the model gives a plain text reply
        for (let i = 0; i < 6; i++) {
            const calls = response.response.functionCalls();
            if (!calls || calls.length === 0)
                break;
            const toolResults = calls.map((call) => {
                const result = applyTool(proposedText, call.name, call.args);
                if (result.success)
                    proposedText = result.newText;
                log.info('review', 'Tool call', { tool: call.name, success: result.success, sessionId: session.id });
                return {
                    functionResponse: {
                        name: call.name,
                        response: { result: result.message },
                    },
                };
            });
            response = await chat.sendMessage(toolResults);
        }
        const explanation = response.response.text();
        const suggestedText = proposedText !== contractText ? proposedText : null;
        await db.insert(reviewMessages).values({
            reviewSessionId: session.id,
            role: 'assistant',
            content: explanation,
            suggestedText,
        });
        log.info('review', 'Agent response', { sessionId: session.id, usedTools: suggestedText !== null });
        return c.json({ role: 'assistant', content: explanation, suggestedText });
    }
    catch (err) {
        log.error('review', 'Agent failed', { sessionId: session.id, error: err?.message });
        const msg = 'Sorry, I could not process that. Please try again or edit directly.';
        await db.insert(reviewMessages).values({ reviewSessionId: session.id, role: 'assistant', content: msg });
        return c.json({ role: 'assistant', content: msg, suggestedText: null });
    }
});
// POST /api/review/:token/submit — counterparty finalises and sends changes back
reviewRouter.post('/:token/submit', async (c) => {
    const token = c.req.param('token');
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== 'string')
        return c.json({ error: 'Text required' }, 400);
    const session = await db.query.reviewSessions.findFirst({
        where: and(eq(reviewSessions.token, token), eq(reviewSessions.status, 'active')),
    });
    if (!session)
        return c.json({ error: 'Not found or already submitted' }, 404);
    const contract = await db.query.contracts.findFirst({
        where: eq(contracts.id, session.contractId),
    });
    if (!contract)
        return c.json({ error: 'Contract not found' }, 404);
    // Next version number
    const latestVersion = await db.query.contractVersions.findFirst({
        where: eq(contractVersions.contractId, session.contractId),
        orderBy: [desc(contractVersions.versionNumber)],
    });
    const nextVersionNumber = (latestVersion?.versionNumber ?? 0) + 1;
    const [newVersion] = await db
        .insert(contractVersions)
        .values({
        contractId: session.contractId,
        versionNumber: nextVersionNumber,
        text: body.text,
        authoredBy: 'counterparty',
        message: body.message || `Proposed changes (v${nextVersionNumber})`,
    })
        .returning({ id: contractVersions.id });
    await db
        .update(reviewSessions)
        .set({
        status: 'submitted',
        workingText: body.text,
        submittedVersionId: newVersion.id,
        updatedAt: new Date(),
    })
        .where(eq(reviewSessions.id, session.id));
    await db
        .update(contracts)
        .set({ status: 'replied', updatedAt: new Date() })
        .where(eq(contracts.id, session.contractId));
    const senderAddress = session.counterpartyEmail ?? 'counterparty@review';
    await db.insert(contractThreads).values({
        contractId: session.contractId,
        direction: 'inbound',
        fromAddress: senderAddress,
        toAddress: contract.recipientEmail ?? 'owner',
        subject: `Re: ${contract.title} — Proposed Changes`,
        bodyText: body.message ||
            'Counterparty submitted proposed changes via the review workspace. View the diff on the contract page.',
        emailDate: new Date(),
    });
    notifyUser(contract.userId, { contractId: session.contractId, status: 'replied' }).catch(() => { });
    // Non-blocking email to owner
    const ownerServiceEmail = await getServiceEmailByUserId(contract.userId);
    if (ownerServiceEmail) {
        const ownerRows = await db.execute(sql `SELECT email, name FROM "user" WHERE id = ${contract.userId} LIMIT 1`);
        if (ownerRows.length > 0) {
            const owner = ownerRows[0];
            sendReviewSubmittedEmail({
                fromAddress: ownerServiceEmail,
                toAddress: owner.email,
                toName: owner.name ?? owner.email,
                contractTitle: contract.title,
                contractId: session.contractId,
                counterpartyEmail: senderAddress,
                versionNumber: nextVersionNumber,
            }).catch((err) => {
                log.error('review', 'Owner notification email failed', { error: err?.message });
            });
        }
    }
    log.info('review', 'Review submitted', {
        contractId: session.contractId,
        versionNumber: nextVersionNumber,
    });
    return c.json({ ok: true, versionNumber: nextVersionNumber });
});
export default reviewRouter;
