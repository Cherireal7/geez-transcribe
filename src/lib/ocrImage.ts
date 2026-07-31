/**
 * ocrImage.ts
 * OCR for raw image inputs (PNG, JPG, WebP, TIFF via browser support).
 * Uses the same recognizePageCanvas pipeline as the PDF path so image
 * results carry the same reliability + telemetry shape.
 */

import { releaseCanvas } from './preprocess'
import {
  OCR_PROFILES,
  createTesseractWorker,
  isAbortError,
  recognizePageCanvas,
  resolveProfile,
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  type OcrOptions,
  type OcrResult,
  type OcrProgress,
} from './ocrPdf'

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/bmp',
] as const

export const SUPPORTED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'] as const

export function isImageFile(file: File): boolean {
  if (SUPPORTED_IMAGE_MIME_TYPES.some(mime => file.type === mime)) return true
  const lower = file.name.toLowerCase()
  return SUPPORTED_IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))
}

async function loadImageToCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await tryCreateBitmap(file)
  const width = bitmap.width
  const height = bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    throw new Error('Unable to acquire canvas context for image')
  }
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0)
  if ('close' in bitmap && typeof bitmap.close === 'function') {
    bitmap.close()
  }
  return canvas
}

async function tryCreateBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // fall through to <img> path
    }
  }
  return await loadImageElement(file)
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`Unable to decode image: ${file.name}`))
    }
    img.src = url
  })
}

export async function ocrImage(
  file: File,
  lang = '',
  onProgress?: (p: OcrProgress) => void,
  options: OcrOptions = {}
): Promise<OcrResult> {
  const profile = resolveProfile(options.profileId)
  const language = lang || profile.lang
  const lowConfidenceThreshold = options.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD
  const retryLowConfidence = options.retryLowConfidence ?? true
  const signal = options.signal

  onProgress?.({ page: 1, total: 1, status: 'rasterizing' })
  let baseCanvas: HTMLCanvasElement | null = null
  const worker = await createTesseractWorker(language, {
    highAccuracy: options.highAccuracy ?? true,
    psm: options.psm ?? 'auto',
  })

  try {
    baseCanvas = await loadImageToCanvas(file)
    const { best, lowConfidence } = await recognizePageCanvas({
      worker,
      baseCanvas,
      lowConfidenceThreshold,
      retryLowConfidence,
      applyClahe: options.applyClahe ?? true,
      onStatus: status => onProgress?.({ page: 1, total: 1, status }),
      signal,
    })

    const text = profile.normalize(best.text)
    onProgress?.({
      page: 1,
      total: 1,
      status: lowConfidence ? 'recognized-low-confidence' : 'recognized',
      confidence: best.confidence,
    })

    return {
      pages: [text],
      pageCount: 1,
      method: 'ocr',
      averageConfidence: best.confidence,
      pageMetrics: [
        {
          page: 1,
          confidence: best.confidence,
          textLength: text.replace(/\s+/g, '').length,
          lowConfidence,
          pass: best.pass,
        },
      ],
      lowConfidencePages: lowConfidence ? [1] : [],
      profileId: profile.id,
      tesseractLang: language,
      engine: 'tesseract.js',
      engineVersion: best.version,
    }
  } catch (error: unknown) {
    if (isAbortError(error)) throw error
    const message = error instanceof Error ? error.message : 'Unknown image OCR error'
    throw new Error(message)
  } finally {
    releaseCanvas(baseCanvas)
    await worker.terminate()
  }
}

export { OCR_PROFILES }
