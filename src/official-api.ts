import type { PluginConfig } from './types'

export interface OfficialText {
  assignments: unknown
  news: unknown
  status: unknown
  source?: { assignments: unknown; news: unknown; status: unknown }
}

export interface OfficialMajorOrder {
  id: string
  title: string
  message: string
  localizedTitle: string
  localizedMessage: string
}

export type OfficialTextKind = 'news' | 'overview' | 'mo'


/** Pair each current global event by its stable game identifier, not array order. */
export function collectOfficialMajorOrders(data: OfficialText): OfficialMajorOrder[] {
  const localized = data.status && typeof data.status === 'object' ? data.status as Record<string, unknown> : {}
  const sourceStatus = data.source?.status && typeof data.source.status === 'object' ? data.source.status as Record<string, unknown> : localized
  const zhEvents = Array.isArray(localized.globalEvents) ? localized.globalEvents : []
  const enEvents = Array.isArray(sourceStatus.globalEvents) ? sourceStatus.globalEvents : zhEvents
  const zhById = new Map<string, Record<string, unknown>>()
  for (const value of zhEvents) {
    if (!value || typeof value !== 'object') continue
    const event = value as Record<string, unknown>
    const id = event.eventId ?? event.messageId32 ?? event.id32
    if (id !== undefined) zhById.set(String(id), event)
  }
  const plain = (value: unknown) => typeof value === 'string' ? value.replace(/<\/?i(?:=\d+)?>/gi, '').trim() : ''
  const sourcePlain = (value: unknown) => plain(value).replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').toLowerCase()
  return enEvents.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return []
    const source = value as Record<string, unknown>
    const id = source.eventId ?? source.messageId32 ?? source.id32 ?? index
    const identity = source.eventId !== undefined ? 'eventId' : source.messageId32 !== undefined ? 'messageId32' : source.id32 !== undefined ? 'id32' : ''
    const target = (identity ? zhById.get(String(id)) : undefined) ?? zhEvents.map(item => item && typeof item === 'object' ? item as Record<string, unknown> : undefined).find(item =>
      item && sourcePlain(item.title) === sourcePlain(source.title) && sourcePlain(item.message) === sourcePlain(source.message))
    if (!target) return []
    const title = plain(source.title), message = plain(source.message)
    const localizedTitle = typeof target.title === 'string' ? target.title.trim() : ''
    const localizedMessage = typeof target.message === 'string' ? target.message.trim() : ''
    if (!title || !message || !localizedTitle || !localizedMessage) return []
    return [{ id: String(id), title, message, localizedTitle, localizedMessage }]
  })
}

export class OfficialApiClient {
  constructor(private config: PluginConfig) {}

  private async get(path: string, language: string): Promise<unknown> {
    const base = this.config.apiBase.replace(/\/$/, '')
    const response = await fetch(`${base}${path}`, { headers: { 'Accept-Language': language, 'X-Super-Client': '1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(this.config.apiTimeout) })
    if (!response.ok) throw new Error(`官方 API ${response.status}: ${path}`)
    return response.json()
  }

  private path(kind: OfficialTextKind) {
    if (kind === 'news') return `/api/NewsFeed/${this.config.warId}?maxEntries=1&direction=Descending`
    if (kind === 'overview') return `/api/v2/Assignment/War/${this.config.warId}`
    return `/api/WarSeason/${this.config.warId}/Status`
  }

  async fetchText(kind: OfficialTextKind, localized?: unknown): Promise<OfficialText> {
    const path = this.path(kind)
    const [target, source] = await Promise.all([
      localized === undefined ? this.get(path, 'zh-hans') : localized,
      this.get(path, 'en-US'),
    ])
    const data: OfficialText = { assignments: {}, news: [], status: {}, source: { assignments: {}, news: [], status: {} } }
    const field = kind === 'overview' ? 'assignments' : kind === 'news' ? 'news' : 'status'
    data[field] = target
    data.source![field] = source
    return data
  }

  async fetchAll(): Promise<OfficialText> {
    const paths = [`/api/v2/Assignment/War/${this.config.warId}`, `/api/NewsFeed/${this.config.warId}?maxEntries=1&direction=Descending`, `/api/WarSeason/${this.config.warId}/Status`]
    const [assignments, news, status, sourceAssignments, sourceNews, sourceStatus] = await Promise.all([
      ...paths.map(path => this.get(path, 'zh-hans')),
      ...paths.map(path => this.get(path, 'en-US')),
    ])
    return { assignments, news, status, source: { assignments: sourceAssignments, news: sourceNews, status: sourceStatus } }
  }

  async fetchNews(): Promise<unknown> {
    return this.get(this.path('news'), 'zh-hans')
  }

  async fetchPlanets(): Promise<Record<string, unknown>[]> {
    const base = this.config.planetApiBase.replace(/\/$/, '')
    const response = await fetch(`${base}/api/v1/planets`, {
      headers: {
        'X-Super-Client': this.config.planetApiClient,
        'X-Super-Contact': this.config.planetApiContact,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(this.config.planetApiTimeout),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240).trim()
      throw new Error(`星球 API ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    const data: unknown = await response.json()
    if (!Array.isArray(data)) throw new Error('星球 API 返回格式无效')
    return data.filter((planet): planet is Record<string, unknown> => !!planet && typeof planet === 'object' && !Array.isArray(planet))
  }
}

export function collectOfficialChinese(data: OfficialText): Map<string, string> {
  const result = new Map<string, string>()
  const plain = (value: string) => value.replace(/<\/?i(?:=\d+)?>/gi, '').trim()
  const add = (source: unknown, localized: unknown) => {
    if (typeof localized === 'string' && /\p{Script=Han}/u.test(localized)) {
      const zh = localized.trim()
      if (zh) result.set(zh, zh)
    }
    if (typeof source === 'string' && typeof localized === 'string' && plain(source) !== plain(localized) && /[A-Za-z]{3}/.test(source) && /\p{Script=Han}/u.test(localized)) {
      const sourceText = plain(source)
      // Keep localization markup in values so the screenshot renderer can
      // restore official emphasis; only matching keys should be plain text.
      const localizedText = localized.trim()
      result.set(sourceText, localizedText)
      // The Companion renders paragraphs separately (and news renders the
      // first paragraph as the card title), so retain paragraph-level pairs.
      const sourceParts = sourceText.split(/\n\s*\n/)
      const localizedParts = localizedText.split(/\n\s*\n/)
      if (sourceParts.length === localizedParts.length && sourceParts.length > 1) {
        sourceParts.forEach((part, index) => {
          const translated = localizedParts[index]?.trim()
          if (part.trim() && translated && /[A-Za-z]{3}/.test(part) && /\p{Script=Han}/u.test(translated)) {
            result.set(part.trim(), translated)
          }
        })
        const bodySource = sourceParts.slice(1).join('\n\n').trim()
        const bodyLocalized = localizedParts.slice(1).join('\n\n').trim()
        if (bodySource && bodyLocalized) result.set(bodySource, bodyLocalized)
      }
    }
  }
  const collectFields = (source: unknown, localized: unknown, fields: readonly string[], preserveMissingTitle = false) => {
    if (Array.isArray(source)) { source.forEach((item, index) => collectFields(item, Array.isArray(localized) ? localized[index] : undefined, fields, preserveMissingTitle)); return }
    if (!source || typeof source !== 'object') return
    const left = source as Record<string, unknown>, right = localized && typeof localized === 'object' ? localized as Record<string, unknown> : {}
    // News titles can be absent from the Chinese response. Keep the English
    // title as an identity translation instead of translating it or borrowing
    // the first paragraph of the message as a substitute.
    if (preserveMissingTitle && typeof left.title === 'string' && left.title.trim() && !(typeof right.title === 'string' && right.title.trim())) {
      const title = left.title.trim()
      result.set(title, title)
    }
    for (const field of fields) if (field in left && field in right) add(left[field], right[field])
    for (const key of Object.keys(left)) if (key in right && left[key] && typeof left[key] === 'object') collectFields(left[key], right[key], fields, preserveMissingTitle)
  }

  // Assignment/War/801: the overview card uses setting.overrideTitle/overrideBrief.
  collectFields(data.source?.assignments ?? data.assignments, data.assignments, ['overrideTitle', 'overrideBrief', 'taskDescription'])
  // NewsFeed/801: the news card uses each entry's title/message.
  collectFields(data.source?.news ?? data.news, data.news, ['title', 'message'], true)
  // WarSeason/801/Status: the MO popup uses only globalEvents[].title/message.
  const localizedStatus = data.status && typeof data.status === 'object' ? data.status as Record<string, unknown> : {}
  const sourceStatus = data.source?.status && typeof data.source.status === 'object' ? data.source.status as Record<string, unknown> : localizedStatus
  collectFields(sourceStatus.globalEvents ?? [], localizedStatus.globalEvents ?? [], ['title', 'message'])
  return result
}
