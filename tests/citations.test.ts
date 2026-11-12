import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MessageItem } from "../components/chat/message-item"
import { citationIndices, validCitations } from "../lib/chat-contract"
import { splitCitations } from "../lib/citations"
import fixtures from "./fixtures/citations.json"

test("contract, renderer and Python use the shared citation fixtures", async t => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const citations = fixture.citations.map(c => ({ ...c, content: "Evidence" }))
      assert.deepEqual(citationIndices(fixture.text), fixture.indices)
      assert.equal(validCitations(fixture.text, citations), fixture.valid)
      assert.equal(splitCitations(fixture.text).map(part => part.text).join(""), fixture.text)
      const html = renderToStaticMarkup(createElement(MessageItem, {
        message: { id: "fixture", role: "user", content: fixture.text, citations },
      }))
      const verified = fixture.indices.filter(index => citations.some(c => c.index === index && c.id.trim()))
      assert.equal((html.match(/Click to view verified source chunk evidence/g) || []).length, verified.length)
      assert.equal((html.match(/Unverified citation/g) || []).length, fixture.indices.length - verified.length)
    })
  }
})
