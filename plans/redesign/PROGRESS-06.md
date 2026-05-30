# Plan 06 — Email Templates — Progress Log

[START] Plan 06 initiated. Read all relevant files:
  - backend/src/services/postmarkClient.ts
  - backend/src/routes/contracts.ts
  - backend/src/db/schema.ts

## Observations before first edit

### postmarkClient.ts
- `sendContractEmail`: generic body, no sender name, no contract title, no branding
- `sendReplyEmail`: sends bodyText as-is, no wrapper context
- `sendSigningInvitationEmail`: links to a /sign/ page — but Plan 07 switched to email-link flow,
  so Dropbox Sign sends its own signing email. This function is still called from contracts.ts
  for non-Genie signers. Plan says: keep but update to "you'll receive a separate email from Dropbox Sign".

### contracts.ts — POST /upload
- Line 144: `title: title || file.name` — title is already stored correctly.
- BUT the `subject` field is NOT set at upload time (subject is null after upload).
  The `subject` field is set at send time (POST /:id/send) from the form body.
  The plan says to set subject = title (user-typed) rather than filename at that point.
  Looking at POST /:id/send (line 255): subject comes from `c.req.json()` — the caller
  passes whatever subject they want. The fix should be: use contract.title as the subject
  instead of whatever the frontend passes, OR update the subject assignment in POST /upload.
  
  Actually re-reading the plan: "set the `subject` field to the user-provided `title`...not from the file's original name."
  The subject field is currently set at send time from the JSON body. At upload time no subject is set.
  The problem is the frontend was passing subject = filename. The fix is: at POST /:id/send,
  ignore the incoming `subject` param and derive from `contract.title` instead.

### contracts.ts — signed URL endpoints
Endpoints that call generateDownloadSignedUrl:
1. GET /:id/download-url (line 488-499) — returns { url, expiresIn }
2. GET /:id/attachment (line 510-555) — returns { url, expiresIn }
3. GET /:id/signed-document (line 798-814) — returns { url, expiresIn }

Also GET /:id/sign-url (line 772-792) — calls getEmbeddedSignUrl (not GCS), but also
returns a time-limited URL. Should add Cache-Control: no-store.

### sendReplyEmail caller (POST /:id/reply, line 436-450)
Currently passes: fromAddress, toAddress, toName, subject, bodyText, inReplyToMessageId, attachment
New signature will need: recipientName, senderName, contractTitle, replyBody, hasAttachment
Some of these are available: contract.recipientName (recipientName), user.name (senderName),
contract.title (contractTitle).

[ABOUT TO EDIT] backend/src/services/postmarkClient.ts — update all three email functions with richer templates and updated signatures
[EDITED] backend/src/services/postmarkClient.ts — sendContractEmail: new contextual body + added contractTitle/senderName/recipientName params; sendReplyEmail: new contextual body + added senderName/recipientName/contractTitle/hasAttachment params; sendSigningInvitationEmail: updated body to "separate email from Dropbox Sign", signingPageUrl made optional

[ABOUT TO EDIT] backend/src/routes/contracts.ts — fix subject at upload, update email callers to pass new params, add Cache-Control: no-store to signed URL endpoints
[EDITED] backend/src/routes/contracts.ts — POST /:id/send: removed `subject` from JSON destructure, derive subject as `{contract.title} — Review Requested`, pass contractTitle/senderName/recipientName to sendContractEmail; POST /:id/reply: pass senderName/recipientName/contractTitle/hasAttachment to sendReplyEmail; added Cache-Control: no-store to GET /:id/download-url, GET /:id/attachment, GET /:id/sign-url, GET /:id/signed-document

[TSC] npx tsc --noEmit — zero errors

[PLAN DONE] Files changed:
  - backend/src/services/postmarkClient.ts
  - backend/src/routes/contracts.ts

