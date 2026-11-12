const CITATION_PATTERN = /\[Chunk\s+([0-9]+(?:\s*,\s*(?:Chunk\s+)?[0-9]+)*)\]/gi

export interface CitationPart { text: string; indices?: number[] }

export function splitCitations(text: string): CitationPart[] {
  const parts: CitationPart[] = []
  let offset = 0
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const start = match.index!
    if (start > offset) parts.push({ text: text.slice(offset, start) })
    parts.push({ text: match[0], indices: match[1].split(",").map(value => Number(value.replace(/Chunk\s*/i, "").trim())) })
    offset = start + match[0].length
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) })
  return parts
}

export function citationIndices(text: string): number[] {
  return splitCitations(text).flatMap(part => part.indices || [])
}

export function validCitations<T extends { id: string; index?: number }>(text: string, citations: T[]): boolean {
  const parts = splitCitations(text)
  const indices = parts.flatMap(part => part.indices || [])
  const remainder = parts.filter(part => !part.indices).map(part => part.text).join("")
  return indices.length > 0 && !/\[Chunk\b/i.test(remainder) &&
    indices.every(index => citations.some(c => c.index === index && c.id.trim().length > 0))
}

export function safeCitationPrefix(text: string, citations: { id: string; index: number }[]): string {
  for (const marker of text.matchAll(/\[Chunk\b/gi)) {
    const start = marker.index!
    const end = text.indexOf("]", start)
    if (end === -1 || !validCitations(text.slice(start, end + 1), citations)) return text.slice(0, start)
  }
  for (let n = Math.min(text.length, 6); n > 0; n--) {
    if ("[chunk".startsWith(text.slice(-n).toLowerCase())) return text.slice(0, -n)
  }
  return text
}
