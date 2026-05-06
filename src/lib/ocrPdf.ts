/**
 * ocrPdf.ts
 * Frontend-only OCR pipeline with reliability upgrades:
 * - PDF loaded once per run (avoids per-page reloads)
 * - profile-based language normalization
 * - low-confidence retries with alternate preprocessing
 * - per-page confidence telemetry
 */

import { createWorker, PSM, type Worker } from 'tesseract.js'
import { openPdfDocument, rasterizePageFromSession } from './extractPdf'

export type OcrProfileId = 'ethiopic' | 'koine-greek' | 'hebrew' | 'polyglot'
export type OcrPass = 'primary' | 'binary-retry' | 'highres-retry' | 'failed'

export interface OcrProfile {
  id: OcrProfileId
  label: string
  lang: string
  description: string
  normalize: (text: string) => string
}

export interface OcrProgress {
  page: number
  total: number
  status: string
  confidence?: number
}

export interface OcrPageMetric {
  page: number
  confidence: number
  textLength: number
  lowConfidence: boolean
  pass: OcrPass
  error?: string
}

export interface OcrResult {
  pages: string[]
  pageCount: number
  method: 'ocr'
  averageConfidence: number
  pageMetrics: OcrPageMetric[]
  lowConfidencePages: number[]
  profileId: OcrProfileId
  tesseractLang: string
  engine: 'tesseract.js'
  engineVersion?: string
}

export interface OcrOptions {
  profileId?: OcrProfileId
  lowConfidenceThreshold?: number
  retryLowConfidence?: boolean
}

const DEFAULT_PROFILE_ID: OcrProfileId = 'ethiopic'
const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 70

function normalizeCommon(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u00AD\u200B-\u200F\u202A-\u202E]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeEthiopic(text: string): string {
  return normalizeCommon(text)
    .replace(/[።]/g, '.')
    .replace(/[፣]/g, ',')
}

function normalizeKoineGreek(text: string): string {
  return normalizeCommon(text)
    .replace(/\u03D0/g, 'β')
    .replace(/\u03D1/g, 'θ')
    .replace(/\u03D5/g, 'φ')
}

function normalizeHebrew(text: string): string {
  return normalizeCommon(text)
}

export const OCR_PROFILES: Record<OcrProfileId, OcrProfile> = {
  'ethiopic': {
    id: 'ethiopic',
    label: 'Amharic / Ge\'ez',
    lang: 'amh+eng',
    description: 'Optimized for Ethiopic script with mixed English terms.',
    normalize: normalizeEthiopic,
  },
  'koine-greek': {
    id: 'koine-greek',
    label: 'Koine Greek',
    lang: 'grc+eng',
    description: 'Polytonic Greek OCR normalization for theological texts.',
    normalize: normalizeKoineGreek,
  },
  'hebrew': {
    id: 'hebrew',
    label: 'Hebrew',
    lang: 'heb+eng',
    description: 'Hebrew script OCR with mixed Latin terms.',
    normalize: normalizeHebrew,
  },
  'polyglot': {
    id: 'polyglot',
    label: 'Polyglot',
    lang: 'amh+grc+heb+eng',
    description: 'Mixed-script profile for multilingual pages.',
    normalize: normalizeCommon,
  },
}

function resolveProfile(profileId?: OcrProfileId): OcrProfile {
  const id = profileId ?? DEFAULT_PROFILE_ID
  return OCR_PROFILES[id] ?? OCR_PROFILES[DEFAULT_PROFILE_ID]
}

function preprocessCanvas(source: HTMLCanvasElement, mode: 'none' | 'grayscale' | 'binary'): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const ctx = out.getContext('2d')
  if (!ctx) {
    throw new Error('Unable to initialize OCR preprocessing canvas')
  }
  ctx.drawImage(source, 0, 0)

  if (mode === 'none') return out

  const imageData = ctx.getImageData(0, 0, out.width, out.height)
  const pixels = imageData.data

  let sum = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114
    sum += gray
    pixels[i] = gray
    pixels[i + 1] = gray
    pixels[i + 2] = gray
  }

  if (mode === 'binary') {
    const avg = sum / (pixels.length / 4)
    const threshold = Math.max(90, Math.min(185, avg * 0.92))
    for (let i = 0; i < pixels.length; i += 4) {
      const value = pixels[i] >= threshold ? 255 : 0
      pixels[i] = value
      pixels[i + 1] = value
      pixels[i + 2] = value
    }
  }

  ctx.putImageData(imageData, 0, 0)
  return out
}

function cleanupCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

interface OcrCandidate {
  text: string
  confidence: number
  pass: OcrPass
  version?: string
}

function scoreCandidate(candidate: OcrCandidate): number {
  const chars = candidate.text.replace(/\s+/g, '').length
  const lengthBoost = Math.min(12, chars / 140)
  return candidate.confidence + lengthBoost
}

function selectBestCandidate(current: OcrCandidate, contender: OcrCandidate): OcrCandidate {
  return scoreCandidate(contender) > scoreCandidate(current) ? contender : current
}

async function recognizeCanvas(worker: Worker, canvas: HTMLCanvasElement, pass: OcrPass): Promise<OcrCandidate> {
  const { data } = await worker.recognize(canvas, { rotateAuto: true })
  return {
    text: data.text,
    confidence: data.confidence,
    pass,
    version: data.version,
  }
}

/**
 * OCR a full PDF file page by page with reliability retries.
 *
 * @param file        The PDF File object
 * @param lang        Tesseract language string override
 * @param onProgress  Progress callback
 * @param options     OCR profile + retry options
 */
export async function ocrPdf(
  file: File,
  lang = 'amh+eng',
  onProgress?: (p: OcrProgress) => void,
  options: OcrOptions = {}
): Promise<OcrResult> {
  const profile = resolveProfile(options.profileId)
  const language = lang || profile.lang
  const lowConfidenceThreshold = options.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD
  const retryLowConfidence = options.retryLowConfidence ?? true

  const session = await openPdfDocument(file)
  const pages: string[] = []
  const pageMetrics: OcrPageMetric[] = []
  let detectedEngineVersion: string | undefined

  const worker: Worker = await createWorker(language, 1, {
    logger: () => {},
  })

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    })

    for (let pageNumber = 1; pageNumber <= session.pageCount; pageNumber++) {
      onProgress?.({ page: pageNumber, total: session.pageCount, status: 'rasterizing' })

      let baseCanvas: HTMLCanvasElement | null = null
      let primaryCanvas: HTMLCanvasElement | null = null
      let binaryCanvas: HTMLCanvasElement | null = null
      let highResCanvas: HTMLCanvasElement | null = null
      let highResBinaryCanvas: HTMLCanvasElement | null = null

      try {
        baseCanvas = await rasterizePageFromSession(session, pageNumber, 2.4)
        primaryCanvas = preprocessCanvas(baseCanvas, 'grayscale')

        onProgress?.({ page: pageNumber, total: session.pageCount, status: 'recognizing-primary' })
        let best = await recognizeCanvas(worker, primaryCanvas, 'primary')

        if (retryLowConfidence && best.confidence < lowConfidenceThreshold) {
          onProgress?.({ page: pageNumber, total: session.pageCount, status: 'retrying-binary' })
          binaryCanvas = preprocessCanvas(baseCanvas, 'binary')
          const binaryResult = await recognizeCanvas(worker, binaryCanvas, 'binary-retry')
          best = selectBestCandidate(best, binaryResult)
        }

        if (retryLowConfidence && best.confidence < lowConfidenceThreshold - 10) {
          onProgress?.({ page: pageNumber, total: session.pageCount, status: 'retrying-highres' })
          highResCanvas = await rasterizePageFromSession(session, pageNumber, 3.2)
          highResBinaryCanvas = preprocessCanvas(highResCanvas, 'binary')
          const highResResult = await recognizeCanvas(worker, highResBinaryCanvas, 'highres-retry')
          best = selectBestCandidate(best, highResResult)
        }

        const normalizedText = profile.normalize(best.text)
        const textLength = normalizedText.replace(/\s+/g, '').length
        const lowConfidence = best.confidence < lowConfidenceThreshold
        if (!detectedEngineVersion && best.version) {
          detectedEngineVersion = best.version
        }

        pages.push(normalizedText)
        pageMetrics.push({
          page: pageNumber,
          confidence: best.confidence,
          textLength,
          lowConfidence,
          pass: best.pass,
        })
        onProgress?.({
          page: pageNumber,
          total: session.pageCount,
          status: lowConfidence ? 'recognized-low-confidence' : 'recognized',
          confidence: best.confidence,
        })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown OCR error'
        pages.push('')
        pageMetrics.push({
          page: pageNumber,
          confidence: 0,
          textLength: 0,
          lowConfidence: true,
          pass: 'failed',
          error: message,
        })
        onProgress?.({ page: pageNumber, total: session.pageCount, status: `failed: ${message}` })
      } finally {
        if (primaryCanvas) cleanupCanvas(primaryCanvas)
        if (binaryCanvas) cleanupCanvas(binaryCanvas)
        if (highResBinaryCanvas) cleanupCanvas(highResBinaryCanvas)
        if (highResCanvas) cleanupCanvas(highResCanvas)
        if (baseCanvas) cleanupCanvas(baseCanvas)
      }
    }
  } finally {
    await worker.terminate()
    await session.release()
  }

  const totalConfidence = pageMetrics.reduce((sum, metric) => sum + metric.confidence, 0)
  const averageConfidence = pageMetrics.length > 0 ? totalConfidence / pageMetrics.length : 0
  const lowConfidencePages = pageMetrics.filter(metric => metric.lowConfidence).map(metric => metric.page)

  return {
    pages,
    pageCount: session.pageCount,
    method: 'ocr',
    averageConfidence,
    pageMetrics,
    lowConfidencePages,
    profileId: profile.id,
    tesseractLang: language,
    engine: 'tesseract.js',
    engineVersion: detectedEngineVersion,
  }
}

/**
 * OCR a single page with profile-aware normalization.
 */
export async function ocrSinglePage(
  file: File,
  pageNumber: number,
  lang = 'amh+eng',
  options: OcrOptions = {}
): Promise<{ text: string; confidence: number }> {
  const profile = resolveProfile(options.profileId)
  const language = lang || profile.lang
  const session = await openPdfDocument(file)
  const worker = await createWorker(language, 1, { logger: () => {} })

  let baseCanvas: HTMLCanvasElement | null = null
  let processCanvas: HTMLCanvasElement | null = null
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    })
    baseCanvas = await rasterizePageFromSession(session, pageNumber, 2.4)
    processCanvas = preprocessCanvas(baseCanvas, 'grayscale')
    const { data } = await worker.recognize(processCanvas, { rotateAuto: true })
    return {
      text: profile.normalize(data.text),
      confidence: data.confidence,
    }
  } finally {
    if (processCanvas) cleanupCanvas(processCanvas)
    if (baseCanvas) cleanupCanvas(baseCanvas)
    await worker.terminate()
    await session.release()
  }
}
