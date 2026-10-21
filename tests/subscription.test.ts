import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { majorOrderFingerprint, SubscriptionPoller, SubscriptionStore } from '../src/subscription'

const directories: string[] = []
async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'hd2-subscription-'))
  directories.push(directory)
  return new SubscriptionStore(join(directory, 'state.json'))
}

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('MO subscriptions', () => {
  it('uses independent configured channels and preserves fingerprints across restarts', async () => {
    const subscriptions = await store()
    const channels = { news: ['one:1'], mo: ['two:2', 'three:3'] }
    const poller = new SubscriptionPoller(subscriptions, channels)
    for (const kind of ['news', 'mo'] as const) {
      await poller.poll(kind, async () => ({ fingerprint: 'baseline', send: async () => {} }))
    }
    const reloaded = new SubscriptionStore(join(directories[0], 'state.json'))
    const restarted = new SubscriptionPoller(reloaded, channels)
    for (const kind of ['news', 'mo'] as const) {
      const send = vi.fn(async () => {})
      await restarted.poll(kind, async () => ({ fingerprint: 'baseline', send }))
      expect(send).not.toHaveBeenCalled()
      await restarted.poll(kind, async () => ({ fingerprint: 'updated', send }))
      expect(send).toHaveBeenCalledWith(channels[kind])
    }
  })

  it('ignores legacy command subscriptions while retaining their fingerprints', async () => {
    await store()
    const file = join(directories[0], 'state.json')
    await writeFile(file, JSON.stringify({ channels: ['old:1'], moChannels: ['old:2'], fingerprints: { news: 'baseline', mo: 'baseline' } }))
    const subscriptions = new SubscriptionStore(file)
    const poller = new SubscriptionPoller(subscriptions, { news: ['new:1'], mo: [] })
    const send = vi.fn(async () => {})
    await poller.poll('news', async () => ({ fingerprint: 'updated', send }))
    expect(send).toHaveBeenCalledWith(['new:1'])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ fingerprints: { news: 'updated', mo: 'baseline' } })
  })

  it('fingerprints MO content independent of event order and sensitive to edits', () => {
    const first = { id: '7', title: 'A', message: 'Body', localizedTitle: '甲', localizedMessage: '正文' }
    const second = { id: '8', title: 'B', message: 'Text', localizedTitle: '乙', localizedMessage: '文本' }
    expect(majorOrderFingerprint([first, second])).toBe(majorOrderFingerprint([second, first]))
    expect(majorOrderFingerprint([first])).not.toBe(majorOrderFingerprint([{ ...first, message: 'Updated' }]))
  })

  it('establishes a silent baseline, pushes changes, and retries failed delivery', async () => {
    const subscriptions = await store()
    const poller = new SubscriptionPoller(subscriptions, { news: [], mo: ['one:1'] })
    let fingerprint = 'initial'
    const send = vi.fn(async () => {})
    const fetchUpdate = async () => ({ fingerprint, send })
    await poller.poll('mo', fetchUpdate)
    expect(send).not.toHaveBeenCalled()
    fingerprint = 'changed'
    send.mockRejectedValueOnce(new Error('temporary send error'))
    await expect(poller.poll('mo', fetchUpdate)).rejects.toThrow('temporary send error')
    expect(await subscriptions.fingerprint('mo')).toBe('initial')
    await poller.poll('mo', fetchUpdate)
    expect(send).toHaveBeenCalledTimes(2)
    expect(await subscriptions.fingerprint('mo')).toBe('changed')
  })

  it('does not consume an update when the configured channel list is empty', async () => {
    const subscriptions = await store()
    const poller = new SubscriptionPoller(subscriptions, { news: [], mo: [] })
    await poller.poll('mo', async () => ({ fingerprint: 'baseline', send: async () => {} }))
    await poller.poll('mo', async () => ({ fingerprint: 'update', send: async () => { throw new Error('must not send') } }))
    expect(await subscriptions.fingerprint('mo')).toBe('baseline')
  })
})
