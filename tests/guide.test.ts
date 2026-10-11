import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { guideArticles, guideArticleBySlug, guideCategories, guideCollections, guideCollectionFor, featuredSlugs, popularSlugs, searchGuide, guidePlural } from '../src/pages/guide/content/index.ts'

import { guideExampleIds } from '../src/pages/guide/content/types.ts'

const projectFile = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
test('guide content has stable unique addresses, valid anchors and complete references', () => {
  assert.equal(guideArticleBySlug.size, guideArticles.length, 'duplicate article address')
  assert.equal(new Set(guideCategories.map(item => item.id)).size, guideCategories.length)
  for (const category of guideCategories) assert.ok(guideArticles.some(item => item.category === category.id), category.id)
  for (const article of guideArticles) {
    assert.match(article.slug, /^[a-z]+(?:-[a-z]+)*$/)
    assert.ok(guideCategories.some(category => category.id === article.category), article.slug)
    assert.ok(article.title && article.summary && article.sections.length && article.sources.length, article.slug)
    assert.match(article.updated, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(new Set(article.sections.map(section => section.id)).size, article.sections.length, article.slug)
    for (const section of article.sections) {
      assert.match(section.id, /^[a-z]+(?:-[a-z]+)*$/)
      assert.notEqual(section.id, 'questions', 'reserved FAQ anchor')
      assert.ok(section.paragraphs?.length || section.items?.length || section.steps?.length || section.table, `${article.slug}#${section.id}`)
      if (section.table) for (const row of section.table.rows) assert.equal(row.length, section.table.headings.length)
      if (section.example) assert.ok(guideExampleIds.includes(section.example), `${article.slug}: unknown interface example`)
    }
    for (const slug of article.related) assert.ok(guideArticleBySlug.has(slug), `${article.slug} points to missing ${slug}`)
    for (const source of article.sources) assert.ok(existsSync(projectFile(source)), `${article.slug}: missing source ${source}`)
  }
  for (const slug of [...featuredSlugs, ...popularSlugs]) assert.ok(guideArticleBySlug.has(slug), slug)
})
test('search finds common Russian task wording, synonyms, inflections and body text', () => {
  for (const [query, slug] of [['отдать смену', 'transfer-shift'], ['поменяться', 'swap-shifts'], ['ЭКСЕЛЬ', 'excel-report'], ['табель', 'excel-report'], ['пересекающиеся смены', 'review-requests'], ['сеансы', 'security'], ['больничный', 'submit-request']]) {
    assert.ok(searchGuide(query).some(article => article.slug === slug), `${query}: missing ${slug}`)
  }
  assert.deepEqual(searchGuide('  '), guideArticles)
  assert.deepEqual(searchGuide('unfindable-article-928471'), [])
  const docs = guideArticles.filter(item => item.category === 'documents')
  assert.ok(searchGuide('ознакомление', docs).length > 0)
  assert.ok(searchGuide('ознакомление', docs).every(article => article.category === 'documents'))
})
test('Russian material counts use correct forms', () => {
  assert.equal(guidePlural(1, ['статья', 'статьи', 'статей']), '1 статья')
  assert.equal(guidePlural(43, ['статья', 'статьи', 'статей']), '43 статьи')
  assert.equal(guidePlural(12, ['статья', 'статьи', 'статей']), '12 статей')
})

test('five public themes cover every source topic once and preserve valid shortcuts', () => {
  assert.equal(guideCollections.length, 5)
  const topics = guideCollections.flatMap(item => item.categories)
  assert.equal(new Set(topics).size, topics.length, 'topic appears in multiple themes')
  assert.deepEqual([...topics].sort(), guideCategories.map(item => item.id).sort())
  assert.equal(new Set(guideCollections.map(item => item.id)).size, guideCollections.length)
  for (const collection of guideCollections) {
    for (const id of collection.categories) assert.equal(guideCollectionFor(id), collection)
    for (const slug of collection.shortcuts) {
      const article = guideArticleBySlug.get(slug)
      assert.ok(article && collection.categories.includes(article.category), `${collection.id}: ${slug}`)
    }
  }
})

test('every published article is searchable by its full title', () => {
  for (const article of guideArticles) {
    assert.ok(searchGuide(article.title).some(result => result.slug === article.slug), article.slug)
  }
})
