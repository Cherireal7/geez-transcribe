/**
 * preprocess.ts
 * Client-side image preprocessing to give Tesseract cleaner input on
 * scanned Ge'ez / Amharic documents.
 *
 * Steps (each optional):
 *   1. Grayscale — always run
 *   2. Deskew — projection-profile angle search over a downsampled copy
 *   3. Adaptive threshold — integral-image local mean (Bradley/Roth style)
 *   4. Upscale — bilinear 2x when the long edge is small
 *
 * All heavy work runs on OffscreenCanvas where available, HTMLCanvasElement
 * otherwise, and stays synchronous per page so we never hold GPU memory.
 */

export interface EnhanceOptions {
  binarize?: boolean         // adaptive threshold pass
  deskew?: boolean           // rotate to align text baselines
  upscaleMinLongEdge?: number  // 0 disables; otherwise 2x if long edge < this
  clahe?: boolean            // contrast-limited adaptive histogram equalization
}

export interface EnhanceResult {
  canvas: HTMLCanvasElement
  appliedDeskewDegrees: number
  appliedUpscale: 1 | 2
  binarized: boolean
  claheApplied: boolean
}

const DEFAULT_UPSCALE_THRESHOLD = 2200

export function enhanceCanvas(source: HTMLCanvasElement, options: EnhanceOptions = {}): EnhanceResult {
  const {
    binarize = false,
    deskew = true,
    upscaleMinLongEdge = DEFAULT_UPSCALE_THRESHOLD,
    clahe = true,
  } = options

  let working = toGrayscale(source)
  let appliedDeskewDegrees = 0
  let appliedUpscale: 1 | 2 = 1
  let claheApplied = false

  if (deskew) {
    const angle = estimateSkewDegrees(working)
    if (Math.abs(angle) >= 0.4) {
      working = rotateCanvas(working, angle)
      appliedDeskewDegrees = angle
    }
  }

  const longEdge = Math.max(working.width, working.height)
  if (upscaleMinLongEdge > 0 && longEdge < upscaleMinLongEdge) {
    working = upscale2x(working)
    appliedUpscale = 2
  }

  if (clahe) {
    working = applyClahe(working)
    claheApplied = true
  }

  if (binarize) {
    working = adaptiveThreshold(working)
  }

  return {
    canvas: working,
    appliedDeskewDegrees,
    appliedUpscale,
    binarized: binarize,
    claheApplied,
  }
}

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(width))
  canvas.height = Math.max(1, Math.floor(height))
  return canvas
}

function getCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Unable to acquire 2D canvas context')
  return ctx
}

function toGrayscale(source: HTMLCanvasElement): HTMLCanvasElement {
  const out = newCanvas(source.width, source.height)
  const ctx = getCtx(out)
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, out.width, out.height)
  const px = image.data
  for (let i = 0; i < px.length; i += 4) {
    const g = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114
    px[i] = g
    px[i + 1] = g
    px[i + 2] = g
  }
  ctx.putImageData(image, 0, 0)
  return out
}

function upscale2x(source: HTMLCanvasElement): HTMLCanvasElement {
  const out = newCanvas(source.width * 2, source.height * 2)
  const ctx = getCtx(out)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, out.width, out.height)
  return out
}

function rotateCanvas(source: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  const radians = (degrees * Math.PI) / 180
  const sin = Math.abs(Math.sin(radians))
  const cos = Math.abs(Math.cos(radians))
  const width = Math.ceil(source.width * cos + source.height * sin)
  const height = Math.ceil(source.width * sin + source.height * cos)
  const out = newCanvas(width, height)
  const ctx = getCtx(out)
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, width, height)
  ctx.translate(width / 2, height / 2)
  ctx.rotate(radians)
  ctx.drawImage(source, -source.width / 2, -source.height / 2)
  return out
}

/**
 * Bradley–Roth adaptive threshold using an integral image.
 * Threshold at pixel (x,y) = mean of an s×s window centered on that pixel,
 * scaled by (1 - t). Robust to uneven lighting, which is exactly the
 * failure mode of Otsu on smartphone-shot scans.
 */
function adaptiveThreshold(source: HTMLCanvasElement, windowFraction = 0.03125, offset = 0.15): HTMLCanvasElement {
  const out = newCanvas(source.width, source.height)
  const ctx = getCtx(out)
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, out.width, out.height)
  const px = image.data
  const w = out.width
  const h = out.height
  const s = Math.max(8, Math.floor(Math.min(w, h) * windowFraction))
  const half = Math.floor(s / 2)

  const integral = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    for (let x = 0; x < w; x++) {
      const gray = px[(y * w + x) * 4]
      rowSum += gray
      integral[y * w + x] = (y > 0 ? integral[(y - 1) * w + x] : 0) + rowSum
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(1, x - half)
      const x2 = Math.min(w - 1, x + half)
      const y1 = Math.max(1, y - half)
      const y2 = Math.min(h - 1, y + half)
      const count = (x2 - x1) * (y2 - y1)
      const sum =
        integral[y2 * w + x2] -
        integral[y1 * w + x2] -
        integral[y2 * w + x1] +
        integral[y1 * w + x1]
      const gray = px[(y * w + x) * 4]
      const mean = sum / count
      const value = gray < mean * (1 - offset) ? 0 : 255
      const i = (y * w + x) * 4
      px[i] = value
      px[i + 1] = value
      px[i + 2] = value
    }
  }

  ctx.putImageData(image, 0, 0)
  return out
}

/**
 * Estimate skew angle by scoring horizontal-projection variance at multiple
 * candidate angles. Text rows produce sharp minima/maxima in the profile;
 * variance peaks when the page is upright, so we pick the angle that
 * maximizes it. Runs on a downsampled copy for speed.
 */
function estimateSkewDegrees(source: HTMLCanvasElement): number {
  const maxDim = 720
  const scale = Math.min(1, maxDim / Math.max(source.width, source.height))
  const w = Math.max(64, Math.floor(source.width * scale))
  const h = Math.max(64, Math.floor(source.height * scale))
  const small = newCanvas(w, h)
  const ctx = getCtx(small)
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(source, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data

  // Quick global-mean binarize for scoring only.
  let sum = 0
  for (let i = 0; i < px.length; i += 4) sum += px[i]
  const mean = sum / (px.length / 4)
  const threshold = mean * 0.9
  const binary = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    binary[j] = px[i] < threshold ? 1 : 0
  }

  const angles: number[] = []
  for (let a = -5; a <= 5; a += 0.5) angles.push(a)

  let bestAngle = 0
  let bestScore = -Infinity
  for (const angle of angles) {
    const score = projectionVariance(binary, w, h, (angle * Math.PI) / 180)
    if (score > bestScore) {
      bestScore = score
      bestAngle = angle
    }
  }
  return bestAngle
}

function projectionVariance(binary: Uint8Array, w: number, h: number, radians: number): number {
  const sin = Math.sin(radians)
  const cos = Math.cos(radians)
  const cx = w / 2
  const cy = h / 2
  const bins = new Uint32Array(h)
  const step = Math.max(1, Math.floor(Math.min(w, h) / 240))
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (!binary[y * w + x]) continue
      const rx = x - cx
      const ry = y - cy
      const ny = Math.round(-rx * sin + ry * cos + cy)
      if (ny >= 0 && ny < h) bins[ny]++
    }
  }
  let mean = 0
  for (let i = 0; i < h; i++) mean += bins[i]
  mean /= h
  let variance = 0
  for (let i = 0; i < h; i++) {
    const d = bins[i] - mean
    variance += d * d
  }
  return variance / h
}

export function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return
  canvas.width = 0
  canvas.height = 0
}

/**
 * Contrast-Limited Adaptive Histogram Equalization.
 *
 * Splits the image into tiles, equalizes each tile's histogram, clips
 * over-represented bins to `clipLimit * (tilePixels/256)`, then bilinearly
 * interpolates between tile CDFs so tile seams don't show up.
 *
 * Dramatically improves faded photocopies and phone-shot pages where a
 * global histogram fix would over-darken already-dark regions.
 */
function applyClahe(source: HTMLCanvasElement, tileGrid = 8, clipLimit = 3.0): HTMLCanvasElement {
  const w = source.width
  const h = source.height
  const out = newCanvas(w, h)
  const ctx = getCtx(out)
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, w, h)
  const px = image.data

  const tilesX = tileGrid
  const tilesY = tileGrid
  const tileW = Math.max(1, Math.floor(w / tilesX))
  const tileH = Math.max(1, Math.floor(h / tilesY))
  const tilePixels = tileW * tileH
  const clipCount = Math.max(1, Math.floor((clipLimit * tilePixels) / 256))

  // One CDF (lookup table) per tile
  const luts = new Uint8Array(tilesX * tilesY * 256)

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * tileW
      const y0 = ty * tileH
      const x1 = tx === tilesX - 1 ? w : x0 + tileW
      const y1 = ty === tilesY - 1 ? h : y0 + tileH
      const hist = new Uint32Array(256)
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          hist[px[(y * w + x) * 4]]++
        }
      }
      // Clip
      let excess = 0
      for (let i = 0; i < 256; i++) {
        if (hist[i] > clipCount) {
          excess += hist[i] - clipCount
          hist[i] = clipCount
        }
      }
      const perBin = Math.floor(excess / 256)
      const remainder = excess - perBin * 256
      for (let i = 0; i < 256; i++) hist[i] += perBin
      // Distribute the remainder across the low bins
      for (let i = 0; i < remainder; i++) hist[i]++

      // CDF → LUT
      const total = (x1 - x0) * (y1 - y0)
      let cum = 0
      const lutOffset = (ty * tilesX + tx) * 256
      for (let i = 0; i < 256; i++) {
        cum += hist[i]
        luts[lutOffset + i] = Math.max(0, Math.min(255, Math.round((cum * 255) / total)))
      }
    }
  }

  const readLut = (tx: number, ty: number, value: number): number => {
    const cx = Math.max(0, Math.min(tilesX - 1, tx))
    const cy = Math.max(0, Math.min(tilesY - 1, ty))
    return luts[(cy * tilesX + cx) * 256 + value]
  }

  for (let y = 0; y < h; y++) {
    const gy = y / tileH - 0.5
    const ty0 = Math.floor(gy)
    const ty1 = ty0 + 1
    const fy = gy - ty0
    for (let x = 0; x < w; x++) {
      const gx = x / tileW - 0.5
      const tx0 = Math.floor(gx)
      const tx1 = tx0 + 1
      const fx = gx - tx0
      const v = px[(y * w + x) * 4]
      const v00 = readLut(tx0, ty0, v)
      const v10 = readLut(tx1, ty0, v)
      const v01 = readLut(tx0, ty1, v)
      const v11 = readLut(tx1, ty1, v)
      const top = v00 * (1 - fx) + v10 * fx
      const bottom = v01 * (1 - fx) + v11 * fx
      const value = Math.round(top * (1 - fy) + bottom * fy)
      const i = (y * w + x) * 4
      px[i] = value
      px[i + 1] = value
      px[i + 2] = value
    }
  }

  ctx.putImageData(image, 0, 0)
  return out
}
