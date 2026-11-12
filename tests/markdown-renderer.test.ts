import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MessageItem } from "../components/chat/message-item"
import { validCitations } from "../lib/chat-contract"
import { buildBaselinePrompt, buildStrictCitationPrompt } from "../lib/prompts/systemPrompt"

const citations = [{ id: "a", index: 1, content: "Source one" }, { id: "b", index: 2, content: "Source two" }]
const render = (content: string) => renderToStaticMarkup(createElement(MessageItem, {
  message: { id: "test", role: "user", content, citations },
}))
const badgeCount = (html: string) => (html.match(/Click to view verified source chunk evidence/g) || []).length

test("prompt and renderer use the same numbered citation contract", () => {
  for (const prompt of [buildBaselinePrompt("Evidence"), buildStrictCitationPrompt("Evidence")]) {
    assert.match(prompt, /\[Chunk <number>\]/)
    assert.ok(!prompt.includes("Doc Chunk:"))
  }
  assert.equal(badgeCount(render("Supported [Chunk 1, Chunk 2].")), 2)
  assert.equal(badgeCount(render("Legacy [Doc Chunk: a].")), 0)
  assert.equal(validCitations("Legacy [Doc Chunk: a].", citations), false)
  const unknown = render("Unknown [Chunk 99].")
  assert.equal(badgeCount(unknown), 0)
  assert.match(unknown, /Unverified citation 99/)
})

test("GFM tables have semantic headers, alignment, inline formatting and citation badges", () => {
  const html = render([
    "| **Setting** | Value | Evidence |",
    "| :--- | ---: | :---: |",
    "| `timeout` | 30 | [Chunk 1, Chunk 2] |",
    "| retries | 2 | [Chunk 99] |",
  ].join("\n"))
  assert.match(html, /<table\b/)
  assert.match(html, /<thead\b/)
  assert.equal((html.match(/<th scope="col"/g) || []).length, 3)
  assert.match(html, /<strong>Setting<\/strong>/)
  assert.match(html, /<code[^>]*>timeout<\/code>/)
  assert.match(html, /style="text-align:right"/)
  assert.match(html, /style="text-align:center"/)
  assert.match(html, /role="region" aria-label="Answer table" tabindex="0"/)
  assert.equal(badgeCount(html), 2)
  assert.match(html, /Unverified citation 99/)
})

test("tables without outer pipes and escaped cell pipes are parsed correctly", () => {
  const html = render("Key | Value\n--- | ---\nmode | read \\| write [Chunk 1]")
  assert.equal((html.match(/<td\b/g) || []).length, 2)
  assert.match(html, /read \| write/)
  assert.equal(badgeCount(html), 1)
})

test("inline and source-tray badges keep authoritative chunk numbers after unused sources are removed", () => {
  const html = renderToStaticMarkup(createElement(MessageItem, {
    message: { id: "test", role: "assistant", content: "Source [Chunk 2].", citations: [citations[1]] },
    isStreaming: true,
  }))
  assert.equal((html.match(/Chunk #2/g) || []).length, 2)
  assert.ok(!html.includes("Chunk #1"))
})

test("fenced code preserves its first line, indentation and literal citation/table syntax", () => {
  const html = render("```\nfirst line\n  [Chunk 1]\n| key | value |\n| --- | --- |\n```\n\nOutside [Chunk 2]")
  assert.match(html, /<pre>first line\n  \[Chunk 1\]\n\| key \| value \|/)
  assert.ok(!html.includes("<table"))
  assert.equal(badgeCount(html), 1)
  assert.match(html, /Copy/)
  assert.equal(badgeCount(render("Literal `[Chunk 1]`, cited [Chunk 2].")), 1)
})

test("citations remain interactive in emphasis, lists and block quotes without nesting buttons in links", () => {
  const html = render("**Fact [Chunk 1]**\n\n- Item [Chunk 2]\n\n> Quote [Chunk 1]\n\n[Link [Chunk 2]](https://example.com)")
  assert.match(html, /<strong>/)
  assert.match(html, /<ul\b/)
  assert.match(html, /<blockquote\b/)
  assert.equal(badgeCount(html), 3)
  assert.ok(!/<a\b[^>]*>[\s\S]*?<button[\s\S]*?<\/a>/.test(html))
})

test("untrusted Markdown does not execute HTML or load remote images", () => {
  const html = render('<script>alert(1)</script>\n\n![Image description](https://example.com/tracker.png)\n\n[unsafe](javascript:alert%281%29)\n\n[Chunk 1]')
  assert.ok(!html.includes("<script") && !html.includes("<img"))
  assert.ok(!html.includes("tracker.png") && !html.includes("javascript:"))
  assert.match(html, /Image description/)
  assert.equal(badgeCount(html), 1)
})

test("partial streamed tables render safely until their syntax is complete", () => {
  for (const content of ["| A | B |", "| A | B |\n| --- |", "| A | B |\n| --- | --- |\n| cell [Chunk 1]"]) {
    assert.doesNotThrow(() => render(content))
  }
})
