export interface CacheBackend {
  get(_key: string): Promise<string | null>
  set(_key: string, _value: string, _ttlMs: number): Promise<void>
}

type CacheEntry = {
  expiresAt: number
  value: string
}

export class MemoryCacheBackend implements CacheBackend {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly getCurrentTime: () => number

  constructor(now: () => number = Date.now) {
    this.getCurrentTime = now
  }

  async get(key: string) {
    const entry = this.entries.get(key)
    if (!entry) {
      return null
    }

    if (entry.expiresAt <= this.getCurrentTime()) {
      this.entries.delete(key)
      return null
    }

    return entry.value
  }

  async set(key: string, value: string, ttlMs: number) {
    const now = this.getCurrentTime()

    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(entryKey)
      }
    }

    this.entries.set(key, {
      expiresAt: now + ttlMs,
      value,
    })
  }
}
