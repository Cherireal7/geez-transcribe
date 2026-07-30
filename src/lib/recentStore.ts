/**
 * recentStore.ts
 * IndexedDB-backed store for recent uploads and cached transcription results.
 * Falls back to localStorage if IndexedDB is unavailable.
 */

import type { TranscribeResult } from './structureOutput'

const DB_NAME = 'geez-transcribe'
const DB_VERSION = 1
const STORE = 'recent'
const LEGACY_LOCAL_KEY = 'geez-transcribe-recent'
const MAX_RECENT_ITEMS = 12

export interface RecentUploadEntry {
  id: string
  name: string
  size: number
  uploadedAt: string
  pageCount?: number
  extractionMethod?: string
  outputStructure?: string
  averageConfidence?: number
  kind?: 'pdf' | 'image'
  cachedResult?: TranscribeResult
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined'
}

async function openDb(): Promise<IDBDatabase | null> {
  if (!isBrowser()) return null
  return await new Promise<IDBDatabase | null>((resolve) => {
    let settled = false
    const finish = (db: IDBDatabase | null) => {
      if (!settled) {
        settled = true
        resolve(db)
      }
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => finish(request.result)
      request.onerror = () => finish(null)
      request.onblocked = () => finish(null)
    } catch {
      finish(null)
    }
  })
}

function readLegacyLocal(): RecentUploadEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(LEGACY_LOCAL_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT_ITEMS) : []
  } catch {
    return []
  }
}

function writeLegacyLocal(entries: RecentUploadEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    const compact = entries.map(({ cachedResult: _cachedResult, ...rest }) => rest).slice(0, MAX_RECENT_ITEMS)
    window.localStorage.setItem(LEGACY_LOCAL_KEY, JSON.stringify(compact))
  } catch {
    /* quota exceeded — swallow */
  }
}

async function list(): Promise<RecentUploadEntry[]> {
  const db = await openDb()
  if (!db) return readLegacyLocal()
  return await new Promise<RecentUploadEntry[]>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const store = tx.objectStore(STORE)
      const request = store.getAll()
      request.onsuccess = () => {
        const entries = (request.result as RecentUploadEntry[]) ?? []
        entries.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))
        resolve(entries.slice(0, MAX_RECENT_ITEMS))
      }
      request.onerror = () => resolve(readLegacyLocal())
    } catch {
      resolve(readLegacyLocal())
    }
  })
}

async function put(entry: RecentUploadEntry): Promise<void> {
  const existing = await list()
  const dedupedIds = new Set<string>()
  const filtered = [entry, ...existing.filter(item => item.name !== entry.name)]
    .filter(item => {
      if (dedupedIds.has(item.id)) return false
      dedupedIds.add(item.id)
      return true
    })
    .slice(0, MAX_RECENT_ITEMS)

  const db = await openDb()
  if (!db) {
    writeLegacyLocal(filtered)
    return
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const clear = store.clear()
      clear.onsuccess = () => {
        for (const item of filtered) {
          store.put(item)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => {
        writeLegacyLocal(filtered)
        resolve()
      }
    } catch {
      writeLegacyLocal(filtered)
      resolve()
    }
  })
}

async function remove(id: string): Promise<void> {
  const db = await openDb()
  if (!db) {
    const remaining = readLegacyLocal().filter(item => item.id !== id)
    writeLegacyLocal(remaining)
    return
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

async function clear(): Promise<void> {
  const db = await openDb()
  if (!db) {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(LEGACY_LOCAL_KEY)
    }
    return
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

export const recentUploadsStore = {
  list,
  put,
  remove,
  clear,
  MAX_RECENT_ITEMS,
}
