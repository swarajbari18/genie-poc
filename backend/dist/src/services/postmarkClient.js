import * as postmark from 'postmark';
const client = new postmark.ServerClient(process.env.POSTMARK_SERVER_API_TOKEN);
export async function sendContractEmail(params) {
    const reviewSection = params.reviewUrl
        ? [
            '',
            '─────────────────────────────────',
            'Review and propose changes online:',
            params.reviewUrl,
            '─────────────────────────────────',
        ]
        : [];
    const body = [
        `Hi ${params.recipientName},`,
        '',
        `${params.senderName} has sent you a contract to review via Genie AI.`,
        '',
        `Contract: ${params.contractTitle}`,
        ...reviewSection,
        '',
        'The contract is also attached as a PDF. You can reply to this email with',
        'your feedback or a revised version.',
        '',
        '—',
        `Sent via Genie AI on behalf of ${params.senderName}`,
    ].join('\n');
    const response = await client.sendEmail({
        From: params.fromAddress,
        To: params.toAddress,
        Subject: params.subject,
        TextBody: body,
        Attachments: [
            {
                Name: params.pdfFilename,
                Content: params.pdfBase64,
                ContentType: 'application/pdf',
                ContentID: `cid:${params.contractId}`,
            },
        ],
        MessageStream: 'outbound',
        TrackOpens: false,
    });
    return { messageId: response.MessageID };
}
const REFERENCES_DOMAIN = process.env.MAIL_DOMAIN;
export async function sendReplyEmail(params) {
    const headerValue = `<${params.inReplyToMessageId}@${REFERENCES_DOMAIN}>`;
    const headers = [
        { Name: 'In-Reply-To', Value: headerValue },
        { Name: 'References', Value: headerValue },
    ];
    const attachmentNote = params.hasAttachment
        ? 'A revised contract PDF has been attached.'
        : '';
    const bodyLines = [
        `Hi ${params.recipientName},`,
        '',
        `${params.senderName} has replied to your contract discussion.`,
        '',
        `Contract: ${params.contractTitle}`,
        '',
        params.bodyText,
        '',
        '---',
    ];
    if (attachmentNote) {
        bodyLines.push(attachmentNote);
        bodyLines.push('');
    }
    bodyLines.push('Reply to this email to continue the discussion.');
    bodyLines.push('');
    bodyLines.push('—');
    bodyLines.push('Genie AI');
    const body = bodyLines.join('\n');
    const attachments = params.attachment
        ? [
            {
                Name: params.attachment.filename,
                Content: params.attachment.contentBase64,
                ContentType: params.attachment.contentType,
                ContentID: `cid:reply-${Date.now()}`,
            },
        ]
        : undefined;
    const response = await client.sendEmail({
        From: params.fromAddress,
        To: params.toName ? `${params.toName} <${params.toAddress}>` : params.toAddress,
        Subject: params.subject,
        TextBody: body,
        Headers: headers,
        Attachments: attachments,
        MessageStream: 'outbound',
        TrackOpens: false,
    });
    return { messageId: response.MessageID };
}
export async function sendReviewSubmittedEmail(params) {
    const frontendUrl = process.env.FRONTEND_URL ?? 'https://app.genieai.co';
    const contractUrl = `${frontendUrl}/contracts/${params.contractId}`;
    const body = [
        `Hi ${params.toName},`,
        '',
        `${params.counterpartyEmail} has submitted proposed changes to:`,
        `"${params.contractTitle}" (Version ${params.versionNumber})`,
        '',
        `Review the changes here:`,
        contractUrl,
        '',
        '—',
        'Genie AI',
    ].join('\n');
    await client.sendEmail({
        From: params.fromAddress,
        To: params.toAddress,
        Subject: `Changes proposed on ${params.contractTitle}`,
        TextBody: body,
        MessageStream: 'outbound',
        TrackOpens: false,
    });
}
export async function sendSigningInvitationEmail(params) {
    const headerValue = params.inReplyToMessageId
        ? `<${params.inReplyToMessageId}@${REFERENCES_DOMAIN}>`
        : undefined;
    const headers = headerValue
        ? [
            { Name: 'In-Reply-To', Value: headerValue },
            { Name: 'References', Value: headerValue },
        ]
        : undefined;
    const body = [
        `${params.toName}, you have been invited to review and sign:`,
        params.contractTitle,
        '',
        `Click here to review and sign: ${params.signingPageUrl}`,
        '',
        '—',
        'Genie AI',
    ].join('\n');
    const response = await client.sendEmail({
        From: params.fromAddress,
        To: `${params.toName} <${params.toAddress}>`,
        Subject: params.subject,
        TextBody: body,
        Headers: headers,
        MessageStream: 'outbound',
        TrackOpens: false,
    });
    return { messageId: response.MessageID };
}
