import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function load(name: string): Record<string, string> {
  return JSON.parse(readFileSync(join(__dirname, '..', 'assets', 'glossary', `${name}.json`), 'utf8'))
}
const stratagems = load('stratagems')
export const staticTranslations = load('static')
const terms: Record<string, string> = { ...stratagems, ...load('sectors'), ...load('enemies'), ...load('planets'), ...staticTranslations }
export const glossaryTranslations: Record<string, string> = terms
export const planetTranslations: Record<string, string> = load('planets')
export const planetNamesByChinese: Record<string, string> = Object.entries(planetTranslations).reduce((reverse, [english, chinese]) => {
  const key = chinese.trim().toLocaleLowerCase()
  if (!(key in reverse)) reverse[key] = english
  return reverse
}, {} as Record<string, string>)
// Companion frequently renders a sector as "<name> Sector" and uses plural
// enemy labels. Keep these display variants in the same canonical table so
// they can be resolved before a model request.
for (const [name, value] of Object.entries(load('sectors'))) {
  terms[`${name} sector`] = value
  terms[`${name} sectors`] = value
}
for (const [name, value] of Object.entries(load('enemies'))) {
  if (name.endsWith('y')) terms[name.slice(0, -1) + 'ies'] = value
  else if (/(s|x|z|ch|sh)$/.test(name)) terms[name + 'es'] = value
  else terms[name + 's'] = value
}
Object.assign(terms, {
  illuminate: '光能者', illuminates: '光能者',
  terminid: '终结族', terminids: '终结族',
  automaton: '机器人', automatons: '机器人',
})
const aliases: Record<string, string> = {}
for (const [name, value] of Object.entries(stratagems)) {
  const short = name.replace(/^(?:[a-z]+\/)?[a-z]+-[a-z0-9]+(?:-[a-z0-9]+)?\s+/, '')
  if (short !== name && !aliases[short]) aliases[short] = value
}
Object.assign(terms, aliases)
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const normalizedTerms = new Map(Object.entries(terms).map(([source, value]) => [source.replace(/\s+/g, ' ').trim().toLowerCase(), value]))
const pattern = new RegExp(`(?<![A-Za-z0-9])(?:${[...normalizedTerms.keys()].sort((a, b) => b.length - a.length).map(source => escape(source).replace(/\s+/g, '\\s+')).join('|')})(?![A-Za-z])`, 'gi')

export function preapplyGlossary(text: string) {
  return text.replace(pattern, match => normalizedTerms.get(match.replace(/\s+/g, ' ').trim().toLowerCase()) ?? match)
}

const preserved = new Set(['api', 'dss', 'ftl', 'hd2', 'html', 'id', 'json', 'png', 'ui', 'url', 'utc', 'xp'])
export function hasTranslatableEnglish(text: string) {
  return (text.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).some(word => word.length >= 4 && !preserved.has(word.toLowerCase()))
}
