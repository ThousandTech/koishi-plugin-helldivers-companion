import { describe, expect, it } from 'vitest'
import { getTarget, planetTarget, resolvePlanetTarget } from '../src/targets'

describe('screenshot targets', () => {
  it.each(['news', 'home', 'dss', 'overview', 'mo'] as const)('builds %s target', kind => {
    expect(getTarget(kind).url).toContain('helldiverscompanion.com')
  })
  it('uses the news route for the major-order popup', () => expect(getTarget('mo').url).toBe('https://helldiverscompanion.com/#news'))
  it('uses the requested overview route', () => expect(getTarget('overview').url).toBe('https://helldiverscompanion.com/#overview'))
  it('normalizes planet slug and route', () => expect(planetTarget('Luxuriant_(268)').url).toContain('#hellpad/planets/luxuriant_(268)'))
  it('rejects foreign screenshot hosts', () => expect(() => planetTarget('https://evil.example/#hellpad/planets/foo')).toThrow())
  const planets = [
    { index: 268, name: 'Luxuriant', statistics: { playerCount: 300 } },
    { index: 269, name: 'Meissa', statistics: { playerCount: 100 } },
  ]
  it('resolves Chinese names through the glossary and adds the API index', () => expect(resolvePlanetTarget('富源', planets).key).toBe('luxuriant_(268)'))
  it('resolves numeric IDs and index-name forms', () => {
    expect(resolvePlanetTarget('269', planets).key).toBe('meissa_(269)')
    expect(resolvePlanetTarget('268-Luxuriant', planets).key).toBe('luxuriant_(268)')
  })
  it('upgrades legacy routes but preserves indexed routes', () => {
    expect(resolvePlanetTarget('https://helldiverscompanion.com/#hellpad/planets/luxuriant', planets).key).toBe('luxuriant_(268)')
    expect(resolvePlanetTarget('#hellpad/planets/luxuriant_(268)', planets).key).toBe('luxuriant_(268)')
  })
  it('requests disambiguation for ambiguous names and rejects unknown Chinese names', () => {
    expect(() => resolvePlanetTarget('Mei', [...planets, { index: 270, name: 'Meissa Prime' }])).toThrow(/候选项/)
    expect(() => resolvePlanetTarget('不存在的星球', planets)).toThrow(/未找到星球/)
  })
  it('keeps indexed routes and English slugs usable without a catalog', () => {
    expect(resolvePlanetTarget('#hellpad/planets/luxuriant_(268)', []).key).toBe('luxuriant_(268)')
    expect(resolvePlanetTarget('luxuriant', []).key).toBe('luxuriant')
    expect(() => resolvePlanetTarget('富源', [])).toThrow(/获取星球数据/)
  })
})
