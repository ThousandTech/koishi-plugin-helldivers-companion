import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface Entry { original: string; translated: string; success: boolean; updatedAt: number; fingerprint: string }

export class TranslationCache {
  private entries = new Map<string, Entry>()
  private ready: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private writing: Promise<void> = Promise.resolve()
  private dirty = false
  private path: string

  constructor(directory: string, private fingerprint: string, private fallbackTtl: number) {
    this.path = join(directory, 'translations.json')
    this.ready = readFile(this.path, 'utf8').then(text => {
      const rows: unknown = JSON.parse(text)
      if (!Array.isArray(rows)) return
      for (const row of rows.slice(-4096)) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[1]) continue
        const entry = row[1] as Entry
        if (entry.fingerprint === this.fingerprint && typeof entry.original === 'string' && typeof entry.translated === 'string' && typeof entry.success === 'boolean' && Number.isFinite(entry.updatedAt)) this.entries.set(row[0], entry)
      }
    }).catch(() => undefined)
  }

  async get(key: string, original: string) {
    await this.ready
    const entry = this.entries.get(key)
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!entry || normalize(entry.original) !== normalize(original) || (!entry.success && Date.now() - entry.updatedAt > this.fallbackTtl)) return
    return entry
  }

  async store(key: string, original: string, translated: string, success = true) {
    await this.ready
    this.entries.delete(key)
    this.entries.set(key, { original, translated, success, updatedAt: Date.now(), fingerprint: this.fingerprint })
    while (this.entries.size > 4096) this.entries.delete(this.entries.keys().next().value!)
    this.dirty = true
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(error => console.warn('[HD2] Translation cache write failed', error)) }, 1000)
      this.timer.unref()
    }
  }

  async flush() {
    await this.ready
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.dirty) {
      this.dirty = false
      const payload = JSON.stringify([...this.entries])
      this.writing = this.writing.catch(() => undefined).then(async () => {
        await mkdir(dirname(this.path), { recursive: true })
        const temporary = `${this.path}.${process.pid}.tmp`
        await writeFile(temporary, payload)
        await rename(temporary, this.path)
      }).catch(error => { this.dirty = true; throw error })
    }
    await this.writing
  }
}
