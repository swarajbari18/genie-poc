import PDFDocument from 'pdfkit';
export function generateContractPdf(opts) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const doc = new PDFDocument({ margin: 72, size: 'A4' });
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        const dateStr = opts.date ?? new Date().toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric',
        });
        // Header rule
        doc.rect(72, 72, doc.page.width - 144, 2).fill('#6C81FA');
        // Title
        doc
            .moveDown(1)
            .font('Helvetica-Bold')
            .fontSize(18)
            .fillColor('#1A1A2E')
            .text(opts.title, { align: 'center' });
        // Date
        doc
            .moveDown(0.4)
            .font('Helvetica')
            .fontSize(10)
            .fillColor('#6B7280')
            .text(dateStr, { align: 'center' });
        // Divider
        doc
            .moveDown(1)
            .moveTo(72, doc.y)
            .lineTo(doc.page.width - 72, doc.y)
            .strokeColor('#E5E7EB')
            .lineWidth(1)
            .stroke()
            .moveDown(1);
        // Body text
        doc
            .font('Helvetica')
            .fontSize(10.5)
            .fillColor('#1F2937')
            .lineGap(3);
        // Split text into paragraphs and render
        const paragraphs = opts.text.split(/\n\n+/);
        for (const para of paragraphs) {
            const trimmed = para.trim();
            if (!trimmed)
                continue;
            // Section headings: all-caps short lines or numbered sections
            const isSectionHead = /^[A-Z][A-Z\s.]{4,}$/.test(trimmed) || /^\d+\.\s+[A-Z]/.test(trimmed);
            if (isSectionHead) {
                doc.moveDown(0.5).font('Helvetica-Bold').fontSize(10.5).text(trimmed).moveDown(0.25).font('Helvetica').fontSize(10.5);
            }
            else {
                doc.text(trimmed, { align: 'justify' }).moveDown(0.5);
            }
        }
        // Footer on each page
        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            doc
                .font('Helvetica')
                .fontSize(8)
                .fillColor('#9CA3AF')
                .text(`${opts.title}  ·  Page ${i + 1} of ${range.count}`, 72, doc.page.height - 48, { align: 'center', width: doc.page.width - 144 });
        }
        doc.end();
    });
}
