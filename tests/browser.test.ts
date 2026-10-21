import { describe, expect, it, vi } from 'vitest'
import { KoishiBrowserProvider } from '../src/browser'

describe('Koishi Puppeteer provider', () => {
  it('uses Koishi managed page service', async () => {
    const page = { close: vi.fn() }
    const create = vi.fn().mockResolvedValue(page)
    const provider = new KoishiBrowserProvider({ puppeteer: { page: create } } as never)
    await expect(provider.createPage()).resolves.toBe(page)
    expect(create).toHaveBeenCalledOnce()
  })
  it('returns a useful error when service is not enabled', async () => {
    const provider = new KoishiBrowserProvider({} as never)
    await expect(provider.createPage()).rejects.toThrow('koishi-plugin-puppeteer')
  })
})
