import { PDFParse } from 'pdf-parse'

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer })
  const result = await parser.getText()
  await parser.destroy()
  return normalizeText(result.text)
}

function normalizeText(text: string): string {
  return text
    .replace(/([A-Za-z])-\n([A-Za-z])/g, '$1$2')
    .replace(/\r\n|\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
