import { describe, expect, it } from 'vitest'
import { parseOfficialMarkup } from '../src/official-markup'

describe('official text markup', () => {
  it('highlights type 1 tags while preserving paragraphs and punctuation', () => {
    expect(parseOfficialMarkup('坚守<i=1>新戈23</i>。\n\n完成<i=1>1,250,000场行动</i>。')).toEqual([
      { text: '坚守', highlight: false },
      { text: '新戈23', highlight: true },
      { text: '。\n\n完成', highlight: false },
      { text: '1,250,000场行动', highlight: true },
      { text: '。', highlight: false },
    ])
  })

  it('does not color title tags or interpret arbitrary HTML', () => {
    expect(parseOfficialMarkup('<i=3>新闻标题</i><img src=x onerror=alert(1)>')).toEqual([
      { text: '新闻标题', highlight: false },
      { text: '<img src=x onerror=alert(1)>', highlight: false },
    ])
  })

  it('accepts typed closing tags returned by the Chinese API', () => {
    expect(parseOfficialMarkup('据报告，<i=1>文德米塔里克斯主星</i=1>上出现了机器人<i=1>炽灼部队</i=1>。')).toEqual([
      { text: '据报告，', highlight: false },
      { text: '文德米塔里克斯主星', highlight: true },
      { text: '上出现了机器人', highlight: false },
      { text: '炽灼部队', highlight: true },
      { text: '。', highlight: false },
    ])
  })

  it('accepts the malformed bare i tag used to close Chinese news highlights', () => {
    expect(parseOfficialMarkup('政府已批准建造<i=1>麦拉芬蒙河纪念碑与人权审讯中心<i>')).toEqual([
      { text: '政府已批准建造', highlight: false },
      { text: '麦拉芬蒙河纪念碑与人权审讯中心', highlight: true },
    ])
  })
})
