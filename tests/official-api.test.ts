import { describe, expect, it, vi } from 'vitest'
import { collectOfficialChinese, collectOfficialMajorOrders, OfficialApiClient } from '../src/official-api'
import { defaults } from '../src/types'

describe('official API', () => {
  it('sends the specified public headers and requests all three endpoints', async () => {
    const calls: Array<{ url: string; headers: HeadersInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers ?? {} })
      return new Response('{}', { status: 200 })
    }))
    await new OfficialApiClient(defaults).fetchAll()
    expect(calls).toHaveLength(6)
    expect((calls[0].headers as Record<string, string>)['X-Super-Client']).toBe('1.0')
    expect((calls[0].headers as Record<string, string>)['Accept-Language']).toBe('zh-hans')
    expect(calls.map(call => call.url)).toContain(`${defaults.apiBase}/api/NewsFeed/${defaults.warId}?maxEntries=1&direction=Descending`)
    vi.unstubAllGlobals()
  })
  it('recognizes Chinese official fields', () => {
    const result = collectOfficialChinese({ assignments: [{ setting: { overrideTitle: '重要指令', overrideBrief: '保卫超级地球' } }], news: [], status: {} })
    expect([...result.values()]).toContain('重要指令')
    expect([...result.values()]).toContain('保卫超级地球')
  })

  it('fetches only the requested page text in Chinese and English', async () => {
    const calls: Array<{ url: string; language: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const language = (init?.headers as Record<string, string>)['Accept-Language']
      calls.push({ url: String(input), language })
      return new Response(JSON.stringify([{ title: language === 'zh-hans' ? '新闻' : 'NEWS' }]), { status: 200 })
    }))
    const data = await new OfficialApiClient(defaults).fetchText('news')
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.url.includes('/api/NewsFeed/'))).toBe(true)
    expect(calls.map(call => call.language).sort()).toEqual(['en-US', 'zh-hans'])
    expect(data.news).toEqual([{ title: '新闻' }])
    expect(data.source?.news).toEqual([{ title: 'NEWS' }])
    vi.unstubAllGlobals()
  })

  it('reuses the polled Chinese news payload and fetches only its English pair', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ title: 'NEWS' }]), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const data = await new OfficialApiClient(defaults).fetchText('news', [{ title: '新闻' }])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(data.news).toEqual([{ title: '新闻' }])
    expect(data.source?.news).toEqual([{ title: 'NEWS' }])
    vi.unstubAllGlobals()
  })

  it('fetches planet data from the configurable community API', async () => {
    const calls: Array<{ url: string; headers: HeadersInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers ?? {} })
      return new Response(JSON.stringify([{ index: 268, name: 'Luxuriant' }]), { status: 200 })
    }))
    await expect(new OfficialApiClient(defaults).fetchPlanets()).resolves.toEqual([{ index: 268, name: 'Luxuriant' }])
    expect(calls.map(call => call.url)).toEqual(['https://api.helldivers2.dev/api/v1/planets'])
    expect(calls[0].headers).toMatchObject({
      'X-Super-Client': 'koishi_plugin_Helldivers',
      'X-Super-Contact': 'noreply@example.com',
      Accept: 'application/json',
    })
    vi.unstubAllGlobals()
  })

  it('maps the three API payloads to their page-specific text fields', () => {
    const result = collectOfficialChinese({
      assignments: { setting: { overrideTitle: '最高指令', overrideBrief: '守住阵地' } },
      news: [{ title: '新闻标题', message: '新闻正文' }],
      status: { globalEvents: [{ title: '全球事件标题', message: '全球事件正文' }] },
      source: {
        assignments: { setting: { overrideTitle: 'MAJOR ORDER', overrideBrief: 'Hold the line' } },
        news: [{ title: 'NEWS TITLE', message: 'NEWS BODY' }],
        status: { globalEvents: [{ title: 'GLOBAL EVENT TITLE', message: 'GLOBAL EVENT BODY' }] },
      },
    })
    expect(result.get('MAJOR ORDER')).toBe('最高指令')
    expect(result.get('Hold the line')).toBe('守住阵地')
    expect(result.get('NEWS TITLE')).toBe('新闻标题')
    expect(result.get('NEWS BODY')).toBe('新闻正文')
    expect(result.get('GLOBAL EVENT TITLE')).toBe('全球事件标题')
    expect(result.get('GLOBAL EVENT BODY')).toBe('全球事件正文')
  })

  it('pairs multiple major orders by stable event id, independent of Chinese array order', () => {
    const orders = collectOfficialMajorOrders({
      assignments: {}, news: [],
      source: { assignments: {}, news: [], status: { globalEvents: [
        { eventId: 10, title: 'SUCCESS', message: 'First dispatch' },
        { eventId: 20, title: 'HONOR THE FALLEN', message: 'Second dispatch' },
      ] } },
      status: { globalEvents: [
        { eventId: 20, title: '缅怀烈士', message: '第二条正文' },
        { eventId: 10, title: '成功', message: '第一条正文' },
      ] },
    })
    expect(orders).toEqual([
      { id: '10', title: 'SUCCESS', message: 'First dispatch', localizedTitle: '成功', localizedMessage: '第一条正文' },
      { id: '20', title: 'HONOR THE FALLEN', message: 'Second dispatch', localizedTitle: '缅怀烈士', localizedMessage: '第二条正文' },
    ])
  })

  it('does not collect unrelated status title/message fields outside globalEvents', () => {
    const result = collectOfficialChinese({
      assignments: {}, news: [],
      status: { title: '不应采集', message: '不应采集正文', globalEvents: [] },
      source: { assignments: {}, news: [], status: { title: 'IGNORED TITLE', message: 'IGNORED BODY', globalEvents: [] } },
    })
    expect(result.has('IGNORED TITLE')).toBe(false)
    expect(result.has('IGNORED BODY')).toBe(false)
  })

  it('splits multi-paragraph news and event messages for separately rendered blocks', () => {
    const result = collectOfficialChinese({
      assignments: {},
      news: [{ message: '标题\n\n正文第一段\n\n正文第二段' }],
      status: { globalEvents: [{ message: '事件标题\n\n事件正文' }] },
      source: {
        assignments: {},
        news: [{ message: 'TITLE\n\nFirst paragraph\n\nSecond paragraph' }],
        status: { globalEvents: [{ message: 'EVENT TITLE\n\nEvent body' }] },
      },
    })
    expect(result.get('TITLE')).toBe('标题')
    expect(result.get('First paragraph\n\nSecond paragraph')).toBe('正文第一段\n\n正文第二段')
    expect(result.get('EVENT TITLE')).toBe('事件标题')
    expect(result.get('Event body')).toBe('事件正文')
  })

  it('preserves API emphasis markup in localized values while matching plain source text', () => {
    const result = collectOfficialChinese({
      assignments: {},
      news: [{ message: '<i=3>战略警告</i>\n\n据报告，<i=1>文德米塔里克斯主星</i>上出现了机器人。' }],
      status: {},
      source: { assignments: {}, news: [{ message: '<i=3>STRATEGIC ALERT</i>\n\nReported on <i=1>VINDEMITARIX PRIME</i>.' }], status: {} },
    })
    expect(result.get('STRATEGIC ALERT\n\nReported on VINDEMITARIX PRIME.')).toBe('<i=3>战略警告</i>\n\n据报告，<i=1>文德米塔里克斯主星</i>上出现了机器人。')
    expect(result.get('STRATEGIC ALERT')).toBe('<i=3>战略警告</i>')
    expect(result.get('Reported on VINDEMITARIX PRIME.')).toBe('据报告，<i=1>文德米塔里克斯主星</i>上出现了机器人。')
  })

  it('keeps an English news title when the Chinese API omits it', () => {
    const result = collectOfficialChinese({
      assignments: {}, status: {},
      news: [{ title: '', message: '本条新闻正文' }],
      source: { assignments: {}, status: {}, news: [{ title: 'STRATEGIC ALERT', message: 'The news body' }] },
    })
    expect(result.get('STRATEGIC ALERT')).toBe('STRATEGIC ALERT')
    expect(result.get('The news body')).toBe('本条新闻正文')
  })
})
