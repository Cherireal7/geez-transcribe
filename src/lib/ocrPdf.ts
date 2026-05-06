/**
 * ocrPdf.ts
 * Client-side OCR for scanned/image PDFs using Tesseract.js.
 * Runs entirely in the browser — no server cost.
 *
 * Install: npm install tesseract.js
 * Amharic language data downloads automatically on first use (~4MB).
 */

import { createWorker, type Worker } from 'tesseract.js'
import { rasterizePage, getPdfPageCount } from './extractPdf'

export interface OcrProgress {
  page: number
  total: number
  status: string
  confidence?: number
}

export interface OcrResult {
  pages: string[]
  pageCount: number
  method: 'ocr'
  averageConfidence: number
}

/**
 * OCR a full PDF file page by page.
 *
 * @param file        The PDF File object
 * @param lang        Tesseract language string. Use 'amh' for Amharic,
 *                    'amh+eng' for mixed Amharic/English documents,
 *                    'tir' for Tigrinya (if lang pack installed)
 * @param onProgress  Progress callback
 */
export async function ocrPdf(
  file: File,
  lang = 'amh+eng',
  onProgress?: (p: OcrProgress) => void
): Promise<OcrResult> {
  const pageCount = await getPdfPageCount(file)
  const pages: string[] = []
  const confidences: number[] = []

  // Initialize Tesseract worker once and reuse across pages (much faster)
  const worker: Worker = await createWorker(lang, 1, {
    // Logger suppressed — we handle progress ourselves
    logger: () => {},
  })

  try {
    for (let i = 1; i <= pageCount; i++) {
      onProgress?.({ page: i, total: pageCount, status: 'rasterizing' })

      // Rasterize at 2x scale for better OCR accuracy
      const canvas = await rasterizePage(file, i, 2.0)

      onProgress?.({ page: i, total: pageCount, status: 'recognizing' })

      const { data } = await worker.recognize(canvas)
      pages.push(data.text)
      confidences.push(data.confidence)

      // Clean up canvas to free memory
      canvas.width = 0
      canvas.height = 0
    }
  } finally {
    await worker.terminate()
  }

  const averageConfidence =
    confidences.reduce((sum, c) => sum + c, 0) / confidences.length

  return { pages, pageCount, method: 'ocr', averageConfidence }
}

/**
 * OCR a single page — useful for preview/sampling before full run.
 */
export async function ocrSinglePage(
  file: File,
  pageNumber: number,
  lang = 'amh+eng'
): Promise<{ text: string; confidence: number }> {
  const canvas = await rasterizePage(file, pageNumber, 2.0)
  const worker = await createWorker(lang, 1, { logger: () => {} })
  try {
    const { data } = await worker.recognize(canvas)
    return { text: data.text, confidence: data.confidence }
  } finally {
    await worker.terminate()
  }
}
