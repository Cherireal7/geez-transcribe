/**
 * pipeline.ts
 * Orchestrates the full transcription pipeline:
 *   File → extract → fix encoding → structure → result
 *
 * This is the single entry point for the UI to call.
 */

import { extractPdfText } from './extractPdf'
import { ocrPdf } from './ocrPdf'
import { structureOutput, type TranscribeResult, type StructureFormat } from './structureOutput'
import { generateDiff, type CorrectionEntry } from './fixEncoding'

export interface PipelineOptions {
  fixEncoding?: boolean            // default true
  forceOcr?: boolean               // default false — auto-detect
  ocrLang?: string                 // default 'amh+eng'
  forceFormat?: StructureFormat    // override auto-detection
  extraWordMap?: Record<string, string>
}

export type PipelineStep =
  | 'extracting'
  | 'detecting'
  | 'fixing-encoding'
  | 'structuring'
  | 'complete'
  | 'error'

export interface PipelineProgress {
  step: PipelineStep
  page?: number
  totalPages?: number
  message?: string
}

export interface PipelineResult {
  data: TranscribeResult
  diff: CorrectionEntry[]
  rawText: string   // pre-fix, for diff display
}

/**
 * Run the full transcription pipeline on a PDF File.
 *
 * @param file        PDF File from the browser file input / drop zone
 * @param options     Pipeline configuration
 * @param onProgress  Progress callback for UI updates
 */
export async function transcribePdf(
  file: File,
  options: PipelineOptions = {},
  onProgress?: (p: PipelineProgress) => void
): Promise<PipelineResult> {
  const {
    fixEncoding: fixEncodingFlag = true,
    forceOcr = false,
    ocrLang = 'amh+eng',
    forceFormat,
    extraWordMap = {},
  } = options

  const report = (step: PipelineStep, page?: number, totalPages?: number, message?: string) =>
    onProgress?.({ step, page, totalPages, message })

  // ── Step 1: Extract text ─────────────────────────────────────────────────
  report('extracting')

  let pages: string[]
  let extractionMethod: 'text' | 'ocr' | 'needs-ocr'
  let averageOcrConfidence: number | undefined

  if (forceOcr) {
    report('extracting', 0, undefined, 'OCR mode')
    const ocrResult = await ocrPdf(file, ocrLang, p => {
      report('extracting', p.page, p.total, p.status)
    })
    pages = ocrResult.pages
    extractionMethod = 'ocr'
    averageOcrConfidence = ocrResult.averageConfidence
  } else {
    const extracted = await extractPdfText(file, p => {
      report('extracting', p.page, p.total)
    })

    if (extracted.method === 'needs-ocr') {
      // Auto-fallback to OCR
      report('extracting', 0, extracted.pageCount, 'Scanned PDF detected — switching to OCR')
      const ocrResult = await ocrPdf(file, ocrLang, p => {
        report('extracting', p.page, p.total, p.status)
      })
      pages = ocrResult.pages
      extractionMethod = 'ocr'
      averageOcrConfidence = ocrResult.averageConfidence
    } else {
      pages = extracted.pages
      extractionMethod = 'text'
    }
  }

  // ── Step 2: Generate diff (before fixing) ────────────────────────────────
  report('fixing-encoding')
  const rawText = pages.join('\n')
  const diff = fixEncodingFlag ? generateDiff(rawText) : []

  // ── Step 3: Structure output (includes encoding fix internally) ──────────
  report('structuring')
  const result = structureOutput(pages, file.name, extractionMethod, {
    fixEncodingFlag,
    forceFormat,
    extraWordMap,
  })

  if (averageOcrConfidence !== undefined) {
    result.average_ocr_confidence = averageOcrConfidence
  }

  report('complete')

  return { data: result, diff, rawText }
}
