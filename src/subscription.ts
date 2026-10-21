import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import type { OfficialMajorOrder } from './official-api'

export type SubscriptionKind = 'news' | 'mo'

export function majorOrderFingerprint(orders: OfficialMajorOrder[]) {
  const entries = orders.map(order => [order.id, order.title, order.message, order.localizedTitle, order.localizedMessage])
  entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return createHash('sha1').update(JSON.stringify(entries)).digest('hex')
}

export class SubscriptionStore {
  private fingerprints: Partial<Record<SubscriptionKind, string>> = {}
  private loading?: Promise<void>
  private saving: Promise<void> = Promise.resolve()
  constructor(private file: string) {}

  private async load() {
    this.loading ??= (async () => {
      try {
        const value = JSON.parse(await readFile(this.file, 'utf8')) as { fingerprints?: Partial<Record<SubscriptionKind, unknown>> }
        for (const kind of ['news', 'mo'] as const) {
          const fingerprint = value.fingerprints?.[kind]
          if (typeof fingerprint === 'string' && fingerprint) this.fingerprints[kind] = fingerprint
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })()
    return this.loading
  }

  private save() {
    const content = JSON.stringify({ fingerprints: this.fingerprints }, null, 2)
    const task = this.saving.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, content, 'utf8')
    })
    this.saving = task
    return task
  }

  async fingerprint(kind: SubscriptionKind) { await this.load(); return this.fingerprints[kind] }
  async commit(kind: SubscriptionKind, fingerprint: string) {
    await this.load()
    const previous = this.fingerprints[kind]
    this.fingerprints[kind] = fingerprint
    try { await this.save() } catch (error) {
      this.fingerprints[kind] = previous
      throw error
    }
  }
}

/** Serialize each topic; failures leave its fingerprint pending for the next poll. */
export class SubscriptionPoller {
  private running = new Set<SubscriptionKind>()
  constructor(private store: SubscriptionStore, private channels: Record<SubscriptionKind, string[]>) {}

  async poll(kind: SubscriptionKind, fetchUpdate: () => Promise<{ fingerprint: string; empty?: boolean; send: (channels: string[]) => Promise<unknown> }>) {
    if (this.running.has(kind)) return
    this.running.add(kind)
    try {
      const update = await fetchUpdate()
      const previous = await this.store.fingerprint(kind)
      if (previous === update.fingerprint) return
      const channels = this.channels[kind]
      if (previous && !update.empty) {
        if (!channels.length) return
        // A failed send must not advance the stored fingerprint.
        await update.send(channels)
      }
      await this.store.commit(kind, update.fingerprint)
    } finally {
      this.running.delete(kind)
    }
  }
}
