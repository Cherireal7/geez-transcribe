/**
 * ocrPdf.ts
 * Frontend-only OCR pipeline with reliability upgrades:
 * - PDF loaded once per run (avoids per-page reloads)
 * - profile-based language normalization
 * - low-confidence retries with alternate preprocessing
 * - per-page confidence telemetry
 * - AbortSignal support so the UI can cancel long jobs
 */

import { createWorker, PSM, type Worker } from 'tesseract.js'
import { openPdfDocument, rasterizePageFromSession } from './extractPdf'
import { enhanceCanvas, releaseCanvas } from './preprocess'

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

export type PageSegMode =
  | 'auto'
  | 'single-block'
  | 'single-column'
  | 'sparse-text'
  | 'single-line'

export interface OcrOptions {
  profileId?: OcrProfileId
  lowConfidenceThreshold?: number
  retryLowConfidence?: boolean
  signal?: AbortSignal
  highAccuracy?: boolean       // use tessdata_best (default true)
  applyClahe?: boolean         // adaptive contrast (default true)
  psm?: PageSegMode            // page segmentation mode (default 'auto')
}

const DEFAULT_PROFILE_ID: OcrProfileId = 'ethiopic'
const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 70
const PRIMARY_RASTER_SCALE = 3.0
const HIGHRES_RASTER_SCALE = 4.0

const TESSDATA_BEST_URL = 'https://tessdata.projectnaptha.com/4.0.0_best'
const TESSDATA_FAST_URL = 'https://tessdata.projectnaptha.com/4.0.0'

const PSM_MAP: Record<PageSegMode, PSM> = {
  'auto': PSM.AUTO,
  'single-block': PSM.SINGLE_BLOCK,
  'single-column': PSM.SINGLE_COLUMN,
  'sparse-text': PSM.SPARSE_TEXT,
  'single-line': PSM.SINGLE_LINE,
}

function normalizeCommon(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[­​-‏‪-‮]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeEthiopic(text: string): string {
  return normalizeCommon(text)
}

function normalizeKoineGreek(text: string): string {
  return normalizeCommon(text)
    .replace(/ϐ/g, 'β')
    .replace(/ϑ/g, 'θ')
    .replace(/ϕ/g, 'φ')
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

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Transcription cancelled', 'AbortError')
  }
}

/**
 * Run recognition + retries on a single already-rasterized page canvas.
 * Extracted so image OCR can reuse the same reliability logic.
 */
export interface PageRecognitionInput {
  worker: Worker
  baseCanvas: HTMLCanvasElement
  highResFactory?: () => Promise<HTMLCanvasElement>
  lowConfidenceThreshold: number
  retryLowConfidence: boolean
  applyClahe?: boolean
  onStatus?: (status: string) => void
  signal?: AbortSignal
}

export interface PageRecognitionOutput {
  best: OcrCandidate
  lowConfidence: boolean
}

export async function recognizePageCanvas(input: PageRecognitionInput): Promise<PageRecognitionOutput> {
  const {
    worker,
    baseCanvas,
    highResFactory,
    lowConfidenceThreshold,
    retryLowConfidence,
    applyClahe = true,
    onStatus,
    signal,
  } = input

  let primaryCanvas: HTMLCanvasElement | null = null
  let binaryCanvas: HTMLCanvasElement | null = null
  let highResBase: HTMLCanvasElement | null = null
  let highResBinary: HTMLCanvasElement | null = null

  try {
    const primary = enhanceCanvas(baseCanvas, { deskew: true, binarize: false, clahe: applyClahe })
    primaryCanvas = primary.canvas
    onStatus?.(primary.appliedDeskewDegrees !== 0 ? 'recognizing-primary-deskewed' : 'recognizing-primary')
    ensureNotAborted(signal)
    let best = await recognizeCanvas(worker, primaryCanvas, 'primary')

    if (retryLowConfidence && best.confidence < lowConfidenceThreshold) {
      onStatus?.('retrying-binary')
      ensureNotAborted(signal)
      const binary = enhanceCanvas(baseCanvas, { deskew: true, binarize: true, clahe: applyClahe })
      binaryCanvas = binary.canvas
      const binaryResult = await recognizeCanvas(worker, binaryCanvas, 'binary-retry')
      best = selectBestCandidate(best, binaryResult)
    }

    if (retryLowConfidence && best.confidence < lowConfidenceThreshold - 10 && highResFactory) {
      onStatus?.('retrying-highres')
      ensureNotAborted(signal)
      highResBase = await highResFactory()
      const highRes = enhanceCanvas(highResBase, { deskew: true, binarize: true, clahe: applyClahe, upscaleMinLongEdge: 0 })
      highResBinary = highRes.canvas
      const highResResult = await recognizeCanvas(worker, highResBinary, 'highres-retry')
      best = selectBestCandidate(best, highResResult)
    }

    return { best, lowConfidence: best.confidence < lowConfidenceThreshold }
  } finally {
    releaseCanvas(primaryCanvas)
    releaseCanvas(binaryCanvas)
    releaseCanvas(highResBinary)
    releaseCanvas(highResBase)
  }
}

async function createTesseractWorker(
  language: string,
  { highAccuracy = true, psm = 'auto' as PageSegMode }: { highAccuracy?: boolean; psm?: PageSegMode } = {}
): Promise<Worker> {
  const worker = await createWorker(language, 1, {
    logger: () => {},
    langPath: highAccuracy ? TESSDATA_BEST_URL : TESSDATA_FAST_URL,
  })
  await worker.setParameters({
    tessedit_pageseg_mode: PSM_MAP[psm] ?? PSM.AUTO,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  })
  return worker
}

/**
 * OCR a full PDF file page by page with reliability retries.
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
  const highAccuracy = options.highAccuracy ?? true
  const applyClahe = options.applyClahe ?? true
  const psm = options.psm ?? 'auto'
  const signal = options.signal

  ensureNotAborted(signal)

  const session = await openPdfDocument(file)
  const pages: string[] = []
  const pageMetrics: OcrPageMetric[] = []
  let detectedEngineVersion: string | undefined

  const worker = await createTesseractWorker(language, { highAccuracy, psm })

  try {
    for (let pageNumber = 1; pageNumber <= session.pageCount; pageNumber++) {
      ensureNotAborted(signal)
      onProgress?.({ page: pageNumber, total: session.pageCount, status: 'rasterizing' })

      let baseCanvas: HTMLCanvasElement | null = null
      try {
        baseCanvas = await rasterizePageFromSession(session, pageNumber, PRIMARY_RASTER_SCALE)
        const { best, lowConfidence } = await recognizePageCanvas({
          worker,
          baseCanvas,
          highResFactory: () => rasterizePageFromSession(session, pageNumber, HIGHRES_RASTER_SCALE),
          lowConfidenceThreshold,
          retryLowConfidence,
          applyClahe,
          onStatus: status => onProgress?.({ page: pageNumber, total: session.pageCount, status }),
          signal,
        })

        const normalizedText = profile.normalize(best.text)
        const textLength = normalizedText.replace(/\s+/g, '').length
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
        if (isAbortError(error)) throw error
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
        releaseCanvas(baseCanvas)
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
  const worker = await createTesseractWorker(language, {
    highAccuracy: options.highAccuracy ?? true,
    psm: options.psm ?? 'auto',
  })

  let baseCanvas: HTMLCanvasElement | null = null
  try {
    baseCanvas = await rasterizePageFromSession(session, pageNumber, PRIMARY_RASTER_SCALE)
    const { best } = await recognizePageCanvas({
      worker,
      baseCanvas,
      lowConfidenceThreshold: options.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD,
      retryLowConfidence: options.retryLowConfidence ?? true,
      applyClahe: options.applyClahe ?? true,
      signal: options.signal,
    })
    return {
      text: profile.normalize(best.text),
      confidence: best.confidence,
    }
  } finally {
    releaseCanvas(baseCanvas)
    await worker.terminate()
    await session.release()
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (error instanceof Error && error.name === 'AbortError')
}

export { createTesseractWorker, resolveProfile, DEFAULT_LOW_CONFIDENCE_THRESHOLD }
