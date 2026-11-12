import assert from "node:assert/strict"
import test from "node:test"
import { splitMarkdown } from "../lib/chunking/splitter"

test("large prose is bounded without losing words, hierarchy or chunk order", () => {
  const text = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(" ")
  const chunks = splitMarkdown(`# Source\n\n${text}`, { minTokens: 300, maxTokens: 800 })
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every(chunk => chunk.content.length <= 3200))
  assert.equal(chunks.map(chunk => chunk.content).join(" ").replace(/^# Source\s+/, ""), text)
  chunks.forEach((chunk, i) => {
    assert.equal(chunk.metadata.chunk_index, i)
    assert.deepEqual(chunk.metadata.parent_headers, ["Source"])
    assert.equal(chunk.metadata.is_tabular, false)
  })
})

test("long unbroken tokens preserve Unicode across chunk boundaries", () => {
  const text = "a" + "😀".repeat(16000)
  const chunks = splitMarkdown(text, { maxTokens: 800 })
  assert.ok(chunks.every(chunk => chunk.content.length <= 3200 && chunk.content.isWellFormed()))
  assert.equal(chunks.map(chunk => chunk.content).join(""), text)
})

test("paragraph splitting preserves whitespace boundaries and keeps tables and code atomic", () => {
  const prose = Array.from({ length: 6000 }, (_, i) => `word${i}`).join("\t\n")
  const chunks = splitMarkdown(prose)
  assert.deepEqual(chunks.flatMap(chunk => chunk.content.split(/\s+/)), prose.split(/\s+/))
  const code = "```txt\n" + "code ".repeat(6000) + "\n```"
  const table = "| Name | Value |\n| --- | --- |\n" + "| name | value |\n".repeat(2000)
  for (const block of [code, table]) {
    const atomic = splitMarkdown(block)
    assert.equal(atomic.length, 1)
    assert.equal(atomic[0].content, block.trim())
  }
  assert.equal(splitMarkdown(table)[0].metadata.is_tabular, true)
})
