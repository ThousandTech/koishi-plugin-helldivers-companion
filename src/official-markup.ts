export interface OfficialTextSegment {
  text: string
  highlight: boolean
}

export function parseOfficialMarkup(value: string): OfficialTextSegment[] {
  const segments: OfficialTextSegment[] = []
  const stack: boolean[] = []
  let offset = 0
  // Localized NewsFeed responses may close emphasis with </i=1> or the
  // malformed bare <i> tag instead of the standard </i>.
  for (const match of value.matchAll(/<i=(\d+)>|(?:<\/i(?:=\d+)?|<i)>/gi)) {
    if (match.index! > offset) segments.push({ text: value.slice(offset, match.index), highlight: stack.includes(true) })
    if (match[1] !== undefined) stack.push(match[1] === '1')
    else stack.pop()
    offset = match.index! + match[0].length
  }
  if (offset < value.length) segments.push({ text: value.slice(offset), highlight: stack.includes(true) })
  return segments
}
