import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranslationCache } from '../src/translation-cache'

const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('persistent translation cache', () => {
  it('expires failed entries using the configured fallback TTL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koishi-cache-test-')); dirs.push(directory)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const cache = new TranslationCache(directory, 'fingerprint', 180000)
    await cache.store('failed', 'English fragment', 'English fragment', false)
    expect((await cache.get('failed', 'English fragment'))?.success).toBe(false)
    now.mockReturnValue(181001)
    expect(await cache.get('failed', 'English fragment')).toBeUndefined()
    await cache.flush()
  })

  it('keeps only the newest 4096 records and restores the same fingerprint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koishi-cache-test-')); dirs.push(directory)
    const cache = new TranslationCache(directory, 'fingerprint', 180000)
    for (let index = 0; index < 4097; index++) await cache.store('key-' + index, 'source-' + index, '译文-' + index)
    await cache.flush()
    const rows = JSON.parse(await readFile(join(directory, 'translations.json'), 'utf8')) as unknown[]
    expect(rows).toHaveLength(4096)
    const restored = new TranslationCache(directory, 'fingerprint', 180000)
    expect((await restored.get('key-4096', 'source-4096'))?.translated).toBe('译文-4096')
    const other = new TranslationCache(directory, 'other', 180000)
    expect(await other.get('key-4096', 'source-4096')).toBeUndefined()
  })
})
