/**
 * pipeline.ts
 * Orchestrates the full transcription pipeline:
 *   File -> extract (PDF text or image) -> OCR fallback -> fix encoding -> structure -> quality metadata
 */

import { extractPdfText } from './extractPdf'
import { ocrPdf, isAbortError, type OcrProfileId } from './ocrPdf'
import { ocrImage, isImageFile } from './ocrImage'
import { structureOutput, type TranscribeResult, type StructureFormat } from './structureOutput'
import { generateDiff, type CorrectionEntry } from './fixEncoding'

const DEFAULT_PIPELINE_VERSION = 'workspace-v1'

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
  signal?: AbortSignal
}

export type PipelineStep =
  | 'extracting'
  | 'detecting'
  | 'fixing-encoding'
  | 'structuring'
  | 'complete'
  | 'error'
  | 'cancelled'

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
  kind: 'pdf' | 'image'
}

function isPdfFile(file: File): boolean {
  if (file.type === 'application/pdf') return true
  return file.name.toLowerCase().endsWith('.pdf')
}

export function isSupportedFile(file: File): boolean {
  return isPdfFile(file) || isImageFile(file)
}

/**
 * Run the full transcription pipeline on a supported File (PDF or image).
 */
export async function transcribeFile(
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
    signal,
  } = options

  const report = (step: PipelineStep, page?: number, totalPages?: number, message?: string) =>
    onProgress?.({ step, page, totalPages, message })

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new DOMException('Transcription cancelled', 'AbortError')
    }
  }

  try {
    throwIfAborted()
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
    let kind: 'pdf' | 'image' = 'pdf'
    const qualityWarnings: string[] = []

    const commonOcrOptions = {
      profileId: ocrProfileId,
      lowConfidenceThreshold,
      retryLowConfidence,
      signal,
    }

    const applyOcrResult = (result: Awaited<ReturnType<typeof ocrPdf>>) => {
      pages = result.pages
      extractionMethod = 'ocr'
      averageOcrConfidence = result.averageConfidence
      lowConfidencePages = result.lowConfidencePages
      ocrPageConfidence = result.pageMetrics.map(metric => ({
        page: metric.page,
        confidence: metric.confidence,
        text_length: metric.textLength,
        low_confidence: metric.lowConfidence,
        pass: metric.pass,
        error: metric.error,
      }))
      ocrEngine = result.engine
      ocrLanguage = result.tesseractLang
      languageProfile = result.profileId
    }

    if (isImageFile(file)) {
      kind = 'image'
      report('extracting', 1, 1, 'Preparing image for OCR')
      const result = await ocrImage(
        file,
        ocrLang,
        p => report('extracting', p.page, p.total, p.status),
        commonOcrOptions
      )
      applyOcrResult(result)
    } else if (!isPdfFile(file)) {
      throw new Error(`Unsupported file type: ${file.type || file.name}. Upload a PDF or image (PNG, JPG, WebP).`)
    } else if (forceOcr) {
      report('extracting', 0, undefined, 'OCR mode')
      const result = await ocrPdf(
        file,
        ocrLang,
        p => report('extracting', p.page, p.total, p.status),
        commonOcrOptions
      )
      applyOcrResult(result)
    } else {
      const extracted = await extractPdfText(file, p => {
        throwIfAborted()
        report('extracting', p.page, p.total)
      })
      if (extracted.method === 'needs-ocr') {
        report('detecting', 0, extracted.pageCount, 'Scanned PDF detected, switching to OCR')
        const result = await ocrPdf(
          file,
          ocrLang,
          p => report('extracting', p.page, p.total, p.status),
          commonOcrOptions
        )
        applyOcrResult(result)
      } else {
        pages = extracted.pages
        extractionMethod = 'text'
      }
    }

    throwIfAborted()
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
    return { data: result, diff, rawText, kind }
  } catch (error: unknown) {
    if (isAbortError(error)) {
      report('cancelled')
      throw error
    }
    if (error instanceof Error) {
      report('error', undefined, undefined, error.message)
    }
    throw error
  }
}

/**
 * Backwards-compatible alias — routes to transcribeFile for any supported input.
 */
export const transcribePdf = transcribeFile
