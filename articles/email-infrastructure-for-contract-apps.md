# How We Built a Purpose-Built Contract Inbox Without Gmail

## The Problem We Were Actually Solving

We were building a legal contract workflow app. The core feature: a user uploads a PDF contract, sends it to a recipient, and when the recipient replies — with comments or a modified document — that reply is automatically captured and shown in the app's dashboard.

Simple to describe. Surprisingly complex to engineer correctly.

The first instinct for any developer is: use Gmail. Everyone has Gmail. Gmail can send. Gmail can receive. Done.

That instinct is wrong for a production-grade app. Here is why, and what we built instead.

---

## First, Understand What Email Actually Is

Email is not one thing. It is two distinct layers that most people — including most developers — conflate because Gmail bundles them together invisibly.

**Layer 1: Infrastructure**
The protocols and servers that move email from one place to another. When you send an email, it travels through SMTP servers. When someone's email arrives, it was routed there by MX records in DNS. This layer is invisible. You never interact with it directly.

**Layer 2: The Mailbox**
The database where received emails are stored, plus the interface to read them. When you open Gmail in your browser, you are not opening something on your computer. You are opening Google's interface that queries Google's database of your emails. Google holds your emails. You view them through their app.

Gmail is both layers bundled together. That is why it feels like one thing.

Postmark, SendGrid, Mailgun — these are infrastructure only. They send and receive email, but they do not store it or show it to you. What happens after the email arrives is your problem to solve.

This distinction is the entire foundation of what we built.

---

## The Options We Evaluated

### Option 1: Gmail API with gmail.send + gmail.readonly

**What it is:** Google gives you OAuth scopes that let your app send emails from a user's real Gmail account and read their inbox to detect replies.

**Why it seems perfect:** Replies go into the user's actual Gmail inbox. You detect them by watching the inbox. Everything lives in one place the user already knows.

**Why we rejected it:**

**Security — the blast radius problem.** `gmail.readonly` does not read only the emails your app sent. It reads the user's entire inbox. Every email they have ever received. Bank statements. Personal messages. Medical records. Your app gets access to all of it to detect one type of reply. This is an unacceptable blast radius for a legal app where trust is everything.

**Compliance — Google's CASA Tier 2 audit.** Any app that requests `gmail.readonly` or `gmail.send` and wants to serve more than 100 users must pass Google's Cloud Application Security Assessment (CASA) Tier 2. This is a third-party security audit that costs between $4,000 and $75,000 and takes months. A startup cannot absorb this before launch.

**Perception — a legal AI company would flag this immediately.** If a sophisticated user — or the legal AI company evaluating this POC — saw that the app requested full Gmail inbox access, they would reject it before reading further. The security model communicates who you are as an engineer.

**Architectural fragility.** Gmail Pub/Sub watch subscriptions expire every 7 days and must be renewed. If the renewal fails silently, reply detection stops working and the user has no idea. You are now maintaining a background job that fights Gmail's infrastructure to stay alive.

**Verdict: Rejected.**

---

### Option 2: A Custom Email Server (Running Your Own MTA)

**What it is:** Run your own mail transfer agent — software like Postfix or Haraka — on a server you control. You own the full stack.

**Why it seems appealing:** Total control. No third-party dependency. You can build exactly the inbox you want.

**Why we rejected it:**

**Deliverability is a full-time job.** Getting email delivered reliably requires a reputation — IP warming, DKIM signing, SPF records, DMARC policies, and years of clean sending history. A new IP address will have its emails sent to spam by Gmail, Outlook, and Yahoo until it has built trust. This is not a technical problem you can solve by writing better code.

**Spam and abuse.** The moment you run an open mail server, it will be targeted. Spam relaying, abuse complaints, IP blacklisting — managing this is a dedicated role at mature companies.

**Cost and maintenance.** Servers, monitoring, on-call for deliverability incidents. For a POC, this is months of work before you write a single line of application logic.

**Verdict: Rejected.**

---

### Option 3: A Full Email Hosting Provider (Fastmail, Google Workspace, Zoho)

**What it is:** Use a business email hosting service. Create real mailboxes like `swaraj@mail.usetend.in` that have actual inboxes, and poll or connect to them via IMAP to read replies.

**Why it seems reasonable:** Real mailboxes. Real inboxes. You can log in and see what arrived. IMAP is a well-understood protocol.

**Why we rejected it:**

**Polling is architecturally broken.** To detect a reply via IMAP, you must check the inbox repeatedly — every 30 seconds, every minute, however often you choose. This burns API quota proportional to the number of active contracts. It introduces latency — a reply sent at 14:00:01 might not appear in the dashboard until 14:00:31. And you must run a background scheduler to keep it alive.

**One mailbox per user is an operational nightmare.** To route replies correctly, each user needs their own mailbox. You would be provisioning and deprovisioning email accounts at Fastmail or Google Workspace every time a user signs up or leaves. Most providers have per-mailbox pricing. At 1,000 users, this is a significant cost.

**IMAP is ancient.** The protocol was designed in 1986. Working with it in modern async TypeScript is painful. Libraries exist, but none of them are pleasant.

**Verdict: Rejected.**

---

### Option 4: Postmark Inbound Webhook with a Custom Domain — What We Built

**What it is:** Point the MX record for a subdomain you own (`mail.usetend.in`) to Postmark's inbound servers. Postmark receives every email sent to that domain, parses it completely — body, attachments, headers — and immediately POSTs it as structured JSON to a webhook endpoint on your backend. Your backend processes it and saves it to your database. Your dashboard is the inbox.

**How per-user routing works:** Every user gets a service address in the format `{slug}-{token}@mail.usetend.in`. For example, `swaraj-a3x9k2@mail.usetend.in`. The slug comes from their name. The token is a 6-character random string. This address is unique per user and is stored in your database. When a reply arrives, the backend reads the local part of the `OriginalRecipient` field (`swaraj-a3x9k2`) and looks up which user it belongs to. Routing is instant, exact, and requires no mailbox infrastructure.

**The send flow:**
1. User uploads contract PDF
2. App sends email via Postmark: `From: swaraj-a3x9k2@mail.usetend.in`, `To: john@acmecorp.com`
3. John receives the email in his normal inbox, sees it came from the user's service address

**The reply flow:**
1. John hits Reply — his email client addresses the reply to `swaraj-a3x9k2@mail.usetend.in`
2. John's email provider looks up the MX record for `mail.usetend.in` — finds `inbound.postmarkapp.com`
3. John's reply is delivered to Postmark's servers
4. Postmark parses the email and POSTs JSON to `POST /webhooks/postmark/inbound`
5. Backend verifies the request, extracts attachments, updates the contract status, saves to database
6. Dashboard shows the reply within seconds

No polling. No expiring subscriptions. No inbox to manage. No per-user mailbox costs.

---

## Angle-by-Angle Comparison

### Security

| Approach | Risk |
|---|---|
| Gmail API | Full inbox access to personal Gmail account. Unacceptable blast radius. CASA audit required. |
| Custom MTA | You control everything — but you also own every security vulnerability in your mail server. |
| IMAP polling | Credentials for mailboxes stored in your app. Exposure of those credentials = exposure of every user's mailbox. |
| Postmark inbound | Postmark receives email only for your domain. Your personal Gmail is never touched. No stored credentials beyond a webhook secret. Blast radius is limited to emails sent to `@mail.usetend.in`. |

**Winner: Postmark inbound.** The scope of access is precisely limited to what the app needs and nothing more.

---

### Cost

| Approach | Cost |
|---|---|
| Gmail API | Free — until you need the CASA audit ($4k–$75k) |
| Custom MTA | Server hosting + engineering time to maintain deliverability |
| IMAP (Google Workspace) | ~$6/user/month per mailbox. 1,000 users = $6,000/month just for mailboxes |
| Postmark inbound | $15/month for 10,000 emails inbound + outbound. Per-message pricing beyond that. Not per-user. |

**Winner: Postmark inbound.** Flat pricing per message, not per user. Scales cleanly.

---

### Deliverability

| Approach | Deliverability |
|---|---|
| Gmail API | Excellent — Gmail's reputation is the best in the world |
| Custom MTA | Poor until warmed up — potentially years to build trust |
| IMAP (Google Workspace) | Good — Google's infrastructure for sending |
| Postmark inbound | Excellent — Postmark is purpose-built for transactional email, maintains its own IP reputation |

**Winner: Postmark inbound (tied with Gmail API).** Postmark's transactional reputation is industry-leading. Emails land in inboxes, not spam folders.

---

### Latency (time from reply sent to app detecting it)

| Approach | Latency |
|---|---|
| Gmail API + Pub/Sub | 2–5 seconds — push notification |
| Custom MTA | Instant — you receive directly |
| IMAP polling | Up to polling interval — 30 seconds to 5 minutes |
| Postmark inbound | 2–5 seconds — webhook fired immediately on receipt |

**Winner: Postmark inbound (tied with Gmail+Pub/Sub).** Webhook fires as soon as Postmark receives the email. No polling delay.

---

### Operational Complexity

| Approach | Complexity |
|---|---|
| Gmail API | Gmail watch expires every 7 days. Must renew or reply detection silently breaks. Pub/Sub topic and subscription to manage. |
| Custom MTA | Server maintenance, deliverability monitoring, spam abuse handling, IP blacklist monitoring |
| IMAP polling | Background scheduler, connection pooling, handling IMAP disconnections |
| Postmark inbound | One MX record. One webhook endpoint. Postmark retries on failure up to 10 times. Nothing to renew. |

**Winner: Postmark inbound.** By a large margin. There is no moving part that can silently fail and take down reply detection without anyone noticing.

---

### Compliance and Auditability

| Approach | Compliance |
|---|---|
| Gmail API | CASA Tier 2 audit required beyond 100 users ($4k–$75k, months to complete) |
| Custom MTA | You own compliance entirely — GDPR, email retention, data residency |
| IMAP | Storing mailbox credentials raises data handling questions |
| Postmark inbound | No restricted OAuth scopes. No audit requirement. Postmark is SOC 2 Type II certified. GDPR-compliant. |

**Winner: Postmark inbound.** No audit gate. No compliance blocker between you and your first 100,000 users.

---

### User Privacy

| Approach | Privacy |
|---|---|
| Gmail API | App can read the user's entire personal inbox |
| Custom MTA | Only app-related email, but you run the infrastructure |
| IMAP | Only the mailboxes you provision — but you hold the credentials |
| Postmark inbound | App only ever touches emails sent to `@mail.usetend.in`. User's personal email is never accessed. |

**Winner: Postmark inbound.** The architecture makes it structurally impossible for the app to access anything outside its own domain. Not a policy. A hard technical boundary.

---

## What We Actually Built: A Purpose-Built Inbox

The insight at the centre of this architecture is that an inbox is not a product — it is a pattern.

An inbox is: receive email → store it → display it. Gmail does all three. We do all three too. We just do it only for the emails that matter to the app, with zero excess access.

When someone realises this, it changes how they think about the problem. Instead of asking "how do I plug into Gmail?", they ask "how do I receive email in a way that is scoped, controlled, and purpose-built?" The answer is: own your domain, point an MX record at a reliable inbound processor, and build the storage and display layer yourself.

The result is an inbox that:
- Has zero access to anything outside its scope
- Has no per-user mailbox cost
- Has no expiring subscriptions to renew
- Delivers replies to the dashboard in under 5 seconds
- Can scale to any number of users without architectural changes

---

## The DNS Piece Most Developers Miss

One subtlety worth explaining: you do not need to "create" a subdomain before adding an MX record. Adding the MX record for `mail.usetend.in` in Cloudflare is what creates the subdomain for email routing. No A record. No CNAME. Just the MX record — and the internet knows to route email for that domain to Postmark.

DNS caching (TTL) means this change propagates within minutes on Cloudflare. Other DNS servers around the internet cache your MX record for the duration of the TTL. When the TTL expires, they re-check. With Cloudflare's default Auto TTL (~300 seconds), the worst case is 5 minutes before a change is globally visible.

---

## Summary

We evaluated four approaches to the same problem — capturing email replies in a contract workflow app. The winner was not the most obvious choice. It was the one that understood email as two separable layers, took only the infrastructure it needed, and built the mailbox layer itself — scoped precisely to the problem.

That is the difference between integrating with email and engineering with email.
