import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaults } from '../src/types'
import { extractBatch, Translator } from '../src/translator'
import { preapplyGlossary } from '../src/glossary'

const dirs: string[] = []
const instances: Translator[] = []
async function makeTranslator(overrides: Partial<typeof defaults> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'koishi-translation-test-'))
  dirs.push(directory)
  const translator = new Translator({ ...defaults, ...overrides, cacheDir: directory })
  instances.push(translator)
  return translator
}
afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.close())); vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

function reply(content: string) { return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }) }

describe('Companion translation pipeline', () => {
  it('applies the longest known term without calling a provider', async () => {
    const translator = await makeTranslator()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(preapplyGlossary('Orbital 380mm HE Barrage')).toMatch(/轨道|弹幕/)
    const result = await translator.translateCompanionFragments('dss', ['Major Order'])
    expect(result.translations['Major Order']).toBe('最高指令')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('loads static phrases from the bundled JSON glossary', () => {
    expect(preapplyGlossary('PLANET STATISTICS')).toBe('星球统计')
    expect(preapplyGlossary('The sector is Draco Sector')).toBe('The 扇区 is 天龙座分区')
  })

  it('covers DSS titles and current effect terminology case-insensitively', async () => {
    const translator = await makeTranslator({ translationEnabled: false })
    const sources = ['ORBITAL BLOCKADE', 'heavy ordnance distribution', 'eAgLe StOrM', 'Eagle Gas Strikes']
    const result = await translator.translateCompanionFragments('dss', sources)
    expect(result.translations).toMatchObject({
      'ORBITAL BLOCKADE': '轨道封锁',
      'heavy ordnance distribution': '重型军械配发',
      'eAgLe StOrM': '飞鹰风暴',
      'Eagle Gas Strikes': '飞鹰毒气空袭',
    })
  })

  it('falls back to glossary terms when a provider fails', async () => {
    const translator = await makeTranslator()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    const source = 'Defense Campaigns cannot originate here; Eagle Gas Strikes are active.'
    const result = await translator.translateCompanionFragments('dss', [source])
    expect(result.translations[source]).toContain('防御战役')
    expect(result.translations[source]).toContain('飞鹰毒气空袭')
  })

  it('normalizes sector suffixes, enemy plurals, and faction names before translation', async () => {
    expect(preapplyGlossary('Akira Sector')).toBe('阿基拉分区')
    expect(preapplyGlossary('Elevated Overseers')).toBe('崇高监视者')
    expect(preapplyGlossary('Illuminate')).toBe('光能者')
  })

  it('reuses official and provider results across case variants', async () => {
    const translator = await makeTranslator()
    translator.setOfficial(new Map([['known headline', '官方标题']]))
    const fetch = vi.fn(async () => reply('模型译文'))
    vi.stubGlobal('fetch', fetch)
    expect((await translator.translateCompanionFragments('news', ['KNOWN HEADLINE'])).translations['KNOWN HEADLINE']).toBe('官方标题')
    await translator.translateCompanionFragments('news', ['Fresh Dispatch Message'])
    await translator.close()
    const restored = new Translator({ ...defaults, cacheDir: dirs[0] })
    instances.push(restored)
    expect((await restored.translateCompanionFragments('news', ['fresh dispatch message'])).translations['fresh dispatch message']).toBe('模型译文')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps glossary substitutions when the provider returns no usable translation', async () => {
    const translator = await makeTranslator()
    const source = 'Akira Sector report'
    const fetch = vi.fn(async () => reply(preapplyGlossary(source)))
    vi.stubGlobal('fetch', fetch)
    const result = await translator.translateCompanionFragments('home', [source])
    expect(result.translations[source]).toBe('阿基拉分区 report')
    expect(result.complete).toBe(false)
    expect(result.cacheable).toBe(false)
  })

  it('prefers official mappings and deduplicates provider work', async () => {
    const translator = await makeTranslator()
    translator.setOfficial(new Map([['Known headline', '官方标题']]))
    const fetch = vi.fn(async () => reply('译文'))
    vi.stubGlobal('fetch', fetch)
    const result = await translator.translateCompanionFragments('news', ['Known headline', 'Another English line', 'Another English line'])
    expect(result.translations['Known headline']).toBe('官方标题')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result.translations['Another English line']).toBe('译文')
  })

  it('persists successful translations and separates providers by fingerprint', async () => {
    const translator = await makeTranslator()
    const fetch = vi.fn(async () => reply('持久译文'))
    vi.stubGlobal('fetch', fetch)
    await translator.translateCompanionFragments('news', ['Fresh dispatch message'])
    await translator.cache.flush()
    const saved = await readFile(join(translator['cache']['path']), 'utf8')
    expect(saved).toContain('持久译文')
    const directory = dirs[0]
    const restored = new Translator({ ...defaults, cacheDir: directory })
    instances.push(restored)
    await restored.translateCompanionFragments('news', ['Fresh dispatch message'])
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockImplementation(async () => new Response('', { status: 429 }))
    const other = new Translator({ ...defaults, cacheDir: directory, translationModel: 'different' })
    instances.push(other)
    const result = await other.translateCompanionFragments('news', ['Fresh dispatch message'])
    expect(result.translations['Fresh dispatch message']).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('extracts partial OpenAI arrays and preserves failed items as source', () => {
    expect(extractBatch('{"translations":["一","二"]}')).toEqual(['一', '二'])
    expect(extractBatch('not json')).toBeUndefined()
  })

  it('repairs only a missing batch tail and preserves positions', async () => {
    const translator = await makeTranslator()
    const fetch = vi.fn().mockResolvedValueOnce(reply('{"translations":["第一条"]}')).mockResolvedValueOnce(reply('第二条'))
    vi.stubGlobal('fetch', fetch)
    const result = await translator.translateMany(['First dispatch text', 'Second dispatch text'])
    expect(result).toEqual(['第一条', '第二条'])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(extractBatch('{"translations":["one",123,"three"]}')).toBeUndefined()
  })

  it('never caches an unchanged term-preprocessed payload as a successful translation', async () => {
    const translator = await makeTranslator()
    const source = 'Helldivers prepare for another dangerous operation'
    vi.stubGlobal('fetch', vi.fn(async () => reply(preapplyGlossary(source))))
    const result = await translator.translateCompanionFragments('news', [source])
    expect(result.untranslatedCount).toBe(1)
    expect(result.cacheable).toBe(false)
    await translator.cache.flush()
    await expect(readFile(join(dirs[0], 'translations.json'), 'utf8')).rejects.toThrow()
  })

  it('enters cooldown after 429 without issuing single-item fallback calls', async () => {
    const translator = await makeTranslator()
    const fetch = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '5' } }))
    vi.stubGlobal('fetch', fetch)
    await translator.translateMany(['First unknown message', 'Second unknown message'])
    await translator.translateMany(['Third unknown message'])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(translator.inTransientFailure()).toBe(true)
  })

  it('returns at the foreground timeout but keeps work for the next capture', async () => {
    const translator = await makeTranslator({ translationBatchTimeout: 10, translationBudget: 20 })
    let complete!: (response: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(resolve => { complete = resolve }))
    vi.stubGlobal('fetch', fetch)
    const first = await translator.translateCompanionFragments('news', ['Delayed dispatch message'])
    expect(first.complete).toBe(false)
    expect(first.untranslatedCount).toBe(1)
    complete(reply('后台完成的译文'))
    await translator.close()
    const second = await translator.translateCompanionFragments('news', ['Delayed dispatch message'])
    expect(second.complete).toBe(true)
    expect(second.translations['Delayed dispatch message']).toBe('后台完成的译文')
    expect(first.translations['Delayed dispatch message']).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('uses at most three concurrent requests and chunks 49 fragments into four batches', async () => {
    const translator = await makeTranslator()
    let active = 0, peak = 0
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      const body = JSON.parse(String(init.body))
      const user = body.messages[1].content
      return reply(user.startsWith('[') ? JSON.stringify({ translations: JSON.parse(user).map(() => '译文') }) : '译文')
    })
    vi.stubGlobal('fetch', fetch)
    const result = await translator.translateCompanionFragments('home', Array.from({ length: 49 }, (_, index) => 'Unknown dispatch text ' + index))
    expect(result.complete).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(peak).toBe(3)
  })

  it('preserves multiline builtin batch translations and uses builtin for a single item', async () => {
    const translator = await makeTranslator({ translationMode: 'builtin', translationApiUrl: 'https://example.com/translate' })
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ translatedText: '[[HD2_0]] 第一行\n第二行\n[[HD2_1]] 第二条' }))).mockResolvedValueOnce(new Response(JSON.stringify({ translated_text: '单条译文' })))
    vi.stubGlobal('fetch', fetch)
    expect(await translator.translateMany(['First multiline message', 'Second multiline message'])).toEqual(['第一行\n第二行', '第二条'])
    expect(await translator.translateMany(['Single unknown message'])).toEqual(['单条译文'])
    expect(fetch.mock.calls[1][0]).toBe('https://example.com/translate')
  })

  it('does not call a provider when translation is disabled', async () => {
    const translator = await makeTranslator({ translationEnabled: false })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await translator.translateMany(['Unknown English message'])).toEqual(['Unknown English message'])
    expect(fetch).not.toHaveBeenCalled()
  })
})
