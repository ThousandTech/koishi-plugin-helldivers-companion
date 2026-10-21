import type { PageKind, ScreenshotTarget } from './types'
import { planetNamesByChinese } from './glossary'

const origin = 'https://helldiverscompanion.com/'
const preset: Record<Exclude<PageKind, 'planet'>, ScreenshotTarget> = {
  news: { kind: 'news', key: 'latest', url: `${origin}#news`, label: '新闻页', viewport: { width: 1280, height: 900 }, clip: { x: 268, y: 154, width: 744, height: 644 } },
  home: { kind: 'home', key: 'home', url: origin, label: '首页', viewport: { width: 1920, height: 1080 } },
  dss: { kind: 'dss', key: 'dss', url: `${origin}#hellpad/stations`, label: 'DSS 页', viewport: { width: 1280, height: 900 }, clip: { x: 209, y: 82, width: 862, height: 734 } },
  overview: { kind: 'overview', key: 'overview', url: `${origin}#overview`, label: '重要指令页', viewport: { width: 1280, height: 1000 } },
  mo: { kind: 'mo', key: 'major-order', url: `${origin}#news`, label: '最高指令弹窗', viewport: { width: 1280, height: 900 } },
}

export function getTarget(kind: Exclude<PageKind, 'planet'>): ScreenshotTarget {
  return { ...preset[kind], viewport: { ...preset[kind].viewport }, ...(preset[kind].clip ? { clip: { ...preset[kind].clip! } } : {}) }
}

function planetInput(input: string): string {
  const raw = input.trim()
  if (!raw) throw new Error('请提供星球名称、编号、slug 或 Companion 链接')
  let fragment = raw.replace(/^[#/]+/, '')
  let isUrl = false
  if (/^https?:\/\//i.test(raw)) {
    isUrl = true
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'helldiverscompanion.com' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('只允许 helldiverscompanion.com 的 HTTPS 链接')
    fragment = url.hash.slice(1)
  }
  const route = /^hellpad\/planets\/([a-z0-9][a-z0-9_-]{0,63}(?:_\(\d{1,6}\))?)$/i.exec(fragment)
  if ((isUrl || /^hellpad\//i.test(fragment)) && !route) throw new Error('Companion 星球链接格式无效')
  return route?.[1] ?? raw
}

function makePlanetTarget(slugInput: string): ScreenshotTarget {
  let slug = slugInput.toLowerCase().replace(/\s+/g, '_')
  if (!/^[a-z0-9][a-z0-9_-]{0,63}(?:_\(\d{1,6}\))?$/.test(slug)) throw new Error('星球 slug 无效，例如 meissa 或 luxuriant_(268)')
  return { kind: 'planet', key: slug, url: `${origin}#hellpad/planets/${slug}`, label: `星球详情：${slug.toUpperCase()}`, viewport: { width: 2560, height: 1440 } }
}

export function planetTarget(input: string): ScreenshotTarget {
  return makePlanetTarget(planetInput(input))
}

export function resolvePlanetTarget(input: string, planets: Record<string, unknown>[]): ScreenshotTarget {
  const value = planetInput(input)
  const query = value.trim()
  const indexedSlug = /^[a-z0-9][a-z0-9_-]{0,63}_\(\d{1,6}\)$/i.test(query)
  if (indexedSlug) return makePlanetTarget(query)

  const normalized = query.replace(/_/g, ' ')
  const translated = planetNamesByChinese[normalized.toLocaleLowerCase()]
  const search = translated ?? normalized
  const idQuery = /^(\d+)(?:\s*-\s*.*)?$/.exec(search)
  if (!planets.length) {
    if (translated || /\p{Script=Han}/u.test(query) || idQuery) throw new Error('暂时无法获取星球数据，请稍后重试')
    return makePlanetTarget(query)
  }
  const planetId = (planet: Record<string, unknown>) => {
    for (const key of ['index', 'planetIndex', 'id']) {
      const rawId = planet[key]
      if (typeof rawId !== 'number' && !(typeof rawId === 'string' && /^\d+$/.test(rawId))) continue
      const number = Number(rawId)
      if (Number.isSafeInteger(number)) return number
    }
    return undefined
  }
  let matches: Record<string, unknown>[]
  if (idQuery) {
    const id = Number(idQuery[1])
    matches = planets.filter(planet => planetId(planet) === id)
  } else {
    const folded = search.toLocaleLowerCase()
    const exact: Record<string, unknown>[] = []
    const partial: Record<string, unknown>[] = []
    for (const planet of planets) {
      const name = String(planet.name ?? planet.planetName ?? '')
      if (!name.trim()) continue
      const nameFolded = name.toLocaleLowerCase()
      if (nameFolded === folded) exact.push(planet)
      else if (nameFolded.includes(folded) || folded.includes(nameFolded)) partial.push(planet)
    }
    const players = (planet: Record<string, unknown>) => Number((planet.statistics as Record<string, unknown> | undefined)?.playerCount ?? planet.players ?? 0)
    matches = [...exact, ...partial].sort((left, right) => players(right) - players(left))
  }

  let selected = matches.length === 1 ? matches[0] : undefined
  if (matches.length > 1) {
    const exact = matches.filter(planet => String(planet.name ?? planet.planetName ?? '').toLocaleLowerCase() === search.toLocaleLowerCase() || String(planetId(planet)) === search)
    if (exact.length === 1) selected = exact[0]
  }
  if (selected) {
    const name = String(selected.name ?? selected.planetName ?? '').trim()
    const index = planetId(selected)
    if (!name || index === undefined || index < 0 || index > 999999) throw new Error('星球数据缺少有效名称或编号，无法打开 Companion 星球页')
    return makePlanetTarget(`${name.toLocaleLowerCase().replace(/\s+/g, '_')}_(${index})`)
  }

  if (matches.length > 1) {
    const candidates = matches.slice(0, 8).map(planet => `${planet.name ?? planet.planetName ?? '未知'} (${planetId(planet) ?? '?'})`)
    throw new Error(`星球名称不够精确，请从候选项中选择：${candidates.join('、')}`)
  }
  if (translated || /\p{Script=Han}/u.test(query) || /^\d/.test(query)) throw new Error(`未找到星球：${query}`)
  // Preserve direct English slugs while the catalog is unavailable or does not include a newer planet.
  return makePlanetTarget(query)
}

export function targetFromArgs(kind: string, arg = ''): ScreenshotTarget {
  if (kind === 'planet') return planetTarget(arg)
  if (!(kind in preset)) throw new Error(`未知页面类型：${kind}`)
  return getTarget(kind as Exclude<PageKind, 'planet'>)
}
