/**
 * pipeline.ts
 * Orchestrates the full transcription pipeline:
 *   File -> extract -> OCR fallback -> fix encoding -> structure -> quality metadata
 */

import { extractPdfText } from './extractPdf'
import { ocrPdf, type OcrProfileId } from './ocrPdf'
import { structureOutput, type TranscribeResult, type StructureFormat } from './structureOutput'
import { generateDiff, type CorrectionEntry } from './fixEncoding'

const DEFAULT_PIPELINE_VERSION = 'frontend-reliability-v1'

export interface PipelineOptions {
  fixEncoding?: boolean            // default true
  forceOcr?: boolean               // default false -> auto-detect
  ocrLang?: string                 // default from OCR profile
  ocrProfileId?: OcrProfileId      // default 'ethiopic'
  lowConfidenceThreshold?: number  // default 70
  retryLowConfidence?: boolean     // default true
  forceFormat?: StructureFormat    // override auto-detection
  extraWordMap?: Record<string, string>
  pipelineVersion?: string
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
    ocrLang = '',
    ocrProfileId,
    lowConfidenceThreshold,
    retryLowConfidence = true,
    forceFormat,
    extraWordMap = {},
    pipelineVersion = DEFAULT_PIPELINE_VERSION,
  } = options

  const report = (step: PipelineStep, page?: number, totalPages?: number, message?: string) =>
    onProgress?.({ step, page, totalPages, message })

  report('extracting')

  let pages: string[] = []
  let extractionMethod: 'text' | 'ocr' | 'needs-ocr' = 'text'
  let averageOcrConfidence: number | undefined
  let lowConfidencePages: number[] = []
  let ocrPageConfidence:
    | Array<{ page: number; confidence: number; text_length: number; low_confidence: boolean; pass: string; error?: string }>
    | undefined
  let ocrEngine: string | undefined
  let ocrLanguage: string | undefined
  let languageProfile = ocrProfileId ?? 'ethiopic'
  const qualityWarnings: string[] = []

  if (forceOcr) {
    report('extracting', 0, undefined, 'OCR mode')
    const ocrResult = await ocrPdf(
      file,
      ocrLang,
      p => report('extracting', p.page, p.total, p.status),
      { profileId: ocrProfileId, lowConfidenceThreshold, retryLowConfidence }
    )
    pages = ocrResult.pages
    extractionMethod = 'ocr'
    averageOcrConfidence = ocrResult.averageConfidence
    lowConfidencePages = ocrResult.lowConfidencePages
    ocrPageConfidence = ocrResult.pageMetrics.map(metric => ({
      page: metric.page,
      confidence: metric.confidence,
      text_length: metric.textLength,
      low_confidence: metric.lowConfidence,
      pass: metric.pass,
      error: metric.error,
    }))
    ocrEngine = ocrResult.engine
    ocrLanguage = ocrResult.tesseractLang
    languageProfile = ocrResult.profileId
  } else {
    const extracted = await extractPdfText(file, p => report('extracting', p.page, p.total))
    if (extracted.method === 'needs-ocr') {
      report('detecting', 0, extracted.pageCount, 'Scanned PDF detected, switching to OCR')
      const ocrResult = await ocrPdf(
        file,
        ocrLang,
        p => report('extracting', p.page, p.total, p.status),
        { profileId: ocrProfileId, lowConfidenceThreshold, retryLowConfidence }
      )
      pages = ocrResult.pages
      extractionMethod = 'ocr'
      averageOcrConfidence = ocrResult.averageConfidence
      lowConfidencePages = ocrResult.lowConfidencePages
      ocrPageConfidence = ocrResult.pageMetrics.map(metric => ({
        page: metric.page,
        confidence: metric.confidence,
        text_length: metric.textLength,
        low_confidence: metric.lowConfidence,
        pass: metric.pass,
        error: metric.error,
      }))
      ocrEngine = ocrResult.engine
      ocrLanguage = ocrResult.tesseractLang
      languageProfile = ocrResult.profileId
    } else {
      pages = extracted.pages
      extractionMethod = 'text'
    }
  }

  report('fixing-encoding')
  const rawText = pages.join('\n')
  const diff = fixEncodingFlag ? generateDiff(rawText) : []

  report('structuring')
  const result = structureOutput(pages, file.name, extractionMethod, {
    fixEncodingFlag,
    forceFormat,
    extraWordMap,
  })

  result.pipeline_version = pipelineVersion
  result.language_profile = languageProfile

  if (averageOcrConfidence !== undefined) {
    result.average_ocr_confidence = averageOcrConfidence
  }
  if (ocrEngine) {
    result.ocr_engine = ocrEngine
  }
  if (ocrLanguage) {
    result.ocr_language = ocrLanguage
  }
  if (lowConfidencePages.length > 0) {
    result.low_confidence_pages = lowConfidencePages
    qualityWarnings.push(`${lowConfidencePages.length} page(s) were recognized with low confidence.`)
  }
  if (ocrPageConfidence) {
    result.ocr_page_confidence = ocrPageConfidence
  }
  if (result.correction_count > 0) {
    qualityWarnings.push(`Encoding normalizer applied ${result.correction_count} character correction(s).`)
  }
  if (qualityWarnings.length > 0) {
    result.quality_warnings = qualityWarnings
  }

  report('complete')
  return { data: result, diff, rawText }
}
