# Plan 06 — Email Templates

## Purpose

Redesign all outbound emails sent via Postmark in `backend/src/services/postmarkClient.ts`. Currently, all emails contain hardcoded generic body text with no sender name, no contract title, and no contextual action CTA. Additionally, the subject line uses the raw uploaded filename instead of the contract title the user typed. Both problems undermine the product's credibility as a professional contract tool.

This plan also covers making the GCS signed URL filename dynamic so downloaded PDFs have real names instead of `contract.pdf`.

---

## Problems with Current Emails

### Problem 1: Hardcoded generic body

In `postmarkClient.ts`, `sendContractEmail` sends the body:
```
"Please review the attached contract and reply with your feedback."
```

No sender name, no contract title, no link, no branding. It looks like a script test email.

### Problem 2: Subject line shows filename not title

The contract subject line is derived from the uploaded filename (e.g., `MSA_v3_final_FINAL.pdf`) because the `subject` field is set from the file's original name at upload time, not from the user-typed title. The fix:

**File**: `backend/src/routes/contracts.ts`, the `POST /upload` handler

When creating the contract record, set the `subject` field to the user-provided `title` (which comes from `formData.get('title')`), not from the file's original name. The original filename is stored separately in `originalFilename` — it should not bleed into the subject line.

Check the Drizzle schema `contracts` table columns to verify: `subject` column exists as a separate string column (not the title column). After the fix, `subject = title` at upload time. Title and subject being the same is intentional at creation — subsequent negotiation rounds don't change the subject.

### Problem 3: No dynamic filename on download

In `storage.ts`, `generateDownloadSignedUrl` hardcodes `responseDisposition: 'attachment; filename="contract.pdf"'` (line 19). Every download — original contract, reply attachments, executed signed PDF — arrives named `contract.pdf` regardless of what the actual file was.

The fix is covered in Plan 07 and Plan 03, but the email template plan depends on it: once filenames are correct, the email attachment chip in the thread view can show the real name.

---

## Email Types and What Each Needs

There are three email-sending functions in `postmarkClient.ts`:
1. `sendContractEmail` — initial outbound contract delivery
2. `sendReplyEmail` — when Genie user replies to a thread
3. `sendSigningInvitationEmail` — when a signature request is sent

### Email 1: Contract Delivery (`sendContractEmail`)

**Current subject**: filename-derived (broken)
**New subject**: `{contractTitle} — Review Requested`

**Current body**: "Please review the attached contract and reply with your feedback."
**New body pattern**:
```
Hi {recipientName},

{senderName} has sent you a contract to review via Genie AI.

Contract: {contractTitle}

Please review the attached PDF and reply to this email with your feedback, 
proposed changes, or a revised PDF. Your reply will be captured directly in the 
contract thread.

If you have any questions, reply to this email.

—
Sent via Genie AI on behalf of {senderName}
```

Parameters needed that are already available in the calling code:
- `senderName`: from `user.name` (available in the route handler)
- `recipientName`: passed in the send form
- `contractTitle`: from `contract.title`
- The attachment: already attached as the PDF

All of these are available in the `POST /:id/send` route handler in `contracts.ts`. Update the `sendContractEmail` function signature to accept them.

### Email 2: Reply (`sendReplyEmail`)

**Current**: minimal, no sender context.
**New body pattern**:
```
Hi {recipientName},

{senderName} has replied to your contract discussion.

Contract: {contractTitle}

{replyBody}

---
{attachmentNote — if PDF is attached: "A revised contract PDF has been attached."}

Reply to this email to continue the discussion.

—
Genie AI
```

Parameters needed:
- `recipientName`, `senderName`, `contractTitle`, `replyBody`
- `hasAttachment: boolean`

### Email 3: Signing Invitation (`sendSigningInvitationEmail`)

This email is sent when the owner submits the "Send for Signature" form. After Plan 05's fix, Dropbox Sign sends its own signing email directly to signers — so this Postmark email is only needed if we want to send a _notification_ email in addition to Dropbox's email. In the POC context, the Dropbox Sign email is sufficient. Deprecate or remove `sendSigningInvitationEmail` to avoid double-emailing.

If kept (e.g., to add branding context before the Dropbox email arrives), update it to:
```
Subject: You've been invited to sign: {contractTitle}

{signerName}, you have been invited to review and sign:
{contractTitle}

You'll receive a separate email from Dropbox Sign with the signing link.

—
Genie AI
```

---

## HTML vs Plain Text

The current emails are plain text. For a POC, plain text is acceptable and avoids spam filters. Do NOT switch to HTML email templates. The improvements above are purely content improvements — same plain text format, just richer content.

If HTML email is desired in a future iteration, use a simple layout: Postmark's built-in template system supports a "base" layout with a header bar. The POC does not need this.

---

## The `generateDownloadSignedUrl` Filename Fix

**File**: `backend/src/lib/storage.ts`, line 19

Change the function signature from:
```typescript
generateDownloadSignedUrl(storageKey: string, expiresInSeconds = 3600)
```
to:
```typescript
generateDownloadSignedUrl(storageKey: string, filename: string, expiresInSeconds = 3600)
```

Change the `responseDisposition` from the hardcoded string to:
```
`attachment; filename="${encodeURIComponent(filename)}"`
```

The `encodeURIComponent` is important — filenames can contain spaces and Unicode characters. The `Content-Disposition` header must be ASCII-safe.

**Update all callers** of `generateDownloadSignedUrl` in `contracts.ts` to pass the actual filename. For each call site, determine which filename to use:
- Original contract download → `contract.originalFilename` (e.g., `MSA_v3.pdf`)
- Reply attachment download → the attachment filename from the `contractThreads` table (check schema for the attachment filename column)
- Executed signed PDF download → `${contract.title}-signed.pdf` (Dropbox does not give a meaningful name; derive from title)

---

## Cache-Control on Signed URL Endpoints

**This fix spans both Plans 06 and 07.** Cloudflare (which sits in front of the Astro frontend via Workers) can cache responses including redirect responses. If a signed URL response (which is a redirect to a time-limited GCS URL) gets cached by Cloudflare, the cached redirect will eventually point to an expired URL, and downloads will fail.

For every endpoint that returns a signed URL or issues a redirect to a signed URL, add the header:
```
Cache-Control: no-store
```

In Hono, this is: `c.header('Cache-Control', 'no-store')` before `c.json(...)` or `c.redirect(...)`.

Affected endpoints in `contracts.ts`:
- `GET /:id/download` (original PDF)
- `GET /:id/signed-url` (embedded sign URL for Genie-to-Genie signers)
- `GET /:id/executed-download` (if this endpoint exists, or wherever the executed PDF URL is served)
- Any thread attachment download endpoint

---

## Files to Modify

| File | Changes |
|---|---|
| `backend/src/services/postmarkClient.ts` | Update body and subject for all three email types; update function signatures to accept richer parameters |
| `backend/src/lib/storage.ts` | Add `filename` parameter to `generateDownloadSignedUrl`; encode in `responseDisposition` |
| `backend/src/routes/contracts.ts` | Update all callers of `generateDownloadSignedUrl` to pass filenames; update `sendContractEmail` calls to pass sender name and title; add `Cache-Control: no-store` to signed URL endpoints; fix subject line at upload time |

## Files to Reference

| File | Why |
|---|---|
| `backend/src/db/schema.ts` | Verify column names: `originalFilename`, `subject`, `title`; thread table attachment filename column |
| `approach.md` §3 (Email) | Canonical email flow description — what emails fire at what points |
