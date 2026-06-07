import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const interB64 = readFileSync(join(__dirname, '../fonts/inter-latin.woff2')).toString('base64');
const playfairB64 = readFileSync(join(__dirname, '../fonts/playfair-latin-700.woff2')).toString('base64');
const FONT_FACE_CSS = `
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url('data:font/woff2;base64,${interB64}') format('woff2');
}
@font-face {
  font-family: 'Playfair Display';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('data:font/woff2;base64,${playfairB64}') format('woff2');
}`;
export async function htmlToPdf(html) {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        const pdf = await page.pdf({
            format: 'A4',
            margin: { top: '20mm', right: '22mm', bottom: '20mm', left: '22mm' },
            printBackground: true,
        });
        return Buffer.from(pdf);
    }
    finally {
        await browser.close();
    }
}
// Wrap plain contract text in a professional HTML shell
export function contractTextToHtml(title, text) {
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    // Turn paragraphs into <p> tags, preserve section breaks
    const body = escaped
        .split(/\n\n+/)
        .map(para => {
        const t = para.trim();
        if (!t)
            return '';
        // ALL CAPS short lines = section heading
        if (/^[A-Z0-9][A-Z0-9\s.,()-]{4,}$/.test(t) || /^\d+\.\s+[A-Z]/.test(t)) {
            return `<h2>${t}</h2>`;
        }
        return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    })
        .join('\n');
    return buildHtmlShell(title, body);
}
export function buildHtmlShell(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  ${FONT_FACE_CSS}

  *, *::before, *::after { box-sizing: border-box; }

  body {
    font-family: 'Inter', -apple-system, Helvetica, sans-serif;
    font-size: 10.5pt;
    line-height: 1.75;
    color: #111827;
    background: #fff;
    margin: 0;
    padding: 0;
  }

  .page {
    max-width: 680px;
    margin: 0 auto;
    padding: 48px 0;
  }

  /* Title block */
  .contract-title {
    font-family: 'Playfair Display', Georgia, 'Times New Roman', serif;
    font-size: 22pt;
    font-weight: 700;
    text-align: center;
    color: #111827;
    margin: 0 0 6px;
    line-height: 1.25;
  }

  .contract-date {
    text-align: center;
    font-size: 9pt;
    color: #6b7280;
    margin-bottom: 36px;
    letter-spacing: 0.04em;
  }

  .title-rule {
    border: none;
    border-top: 2px solid #6c81fa;
    margin: 0 0 32px;
    width: 60px;
    margin-left: auto;
    margin-right: auto;
  }

  /* Section headings */
  h2 {
    font-family: 'Inter', sans-serif;
    font-size: 9pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #374151;
    margin: 28px 0 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid #e5e7eb;
  }

  p {
    margin: 0 0 10px;
    text-align: justify;
    hyphens: auto;
  }

  /* Signature blocks */
  .signature-section {
    margin-top: 48px;
    display: flex;
    gap: 48px;
  }

  .signature-block {
    flex: 1;
  }

  .signature-line {
    border-top: 1px solid #374151;
    padding-top: 8px;
    margin-top: 48px;
  }

  .signature-label {
    font-size: 8.5pt;
    color: #6b7280;
    margin: 0;
  }

  /* Footer */
  .footer {
    margin-top: 48px;
    padding-top: 16px;
    border-top: 1px solid #e5e7eb;
    font-size: 8pt;
    color: #9ca3af;
    text-align: center;
  }

  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
<div class="page">
  <h1 class="contract-title">${title.replace(/</g, '&lt;')}</h1>
  <hr class="title-rule">
  <div class="contract-body">
    ${bodyHtml}
  </div>
  <div class="footer">Generated via Genie AI · Confidential</div>
</div>
</body>
</html>`;
}
// Legacy pdfkit function kept for reference — replaced by htmlToPdf
export async function generateContractPdf(opts) {
    const html = contractTextToHtml(opts.title, opts.text);
    return htmlToPdf(html);
}
