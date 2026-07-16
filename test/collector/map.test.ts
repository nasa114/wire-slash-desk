import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type Parser from 'rss-parser';
import { mapFeedItemToArticle } from '../../src/collector/map.ts';

const FEED_ID = 'feed-1';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

test('mapFeedItemToArticle: 通常のアイテムを正しくマップする', () => {
  const item: Parser.Item = {
    title: 'Hello World',
    link: 'https://example.com/a',
    guid: 'guid-a',
    pubDate: 'Mon, 15 Jul 2026 10:00:00 GMT',
    isoDate: '2026-07-15T10:00:00.000Z',
  };

  const result = mapFeedItemToArticle(FEED_ID, item, 'ja');
  assert.ok(result);
  assert.equal(result.feedId, FEED_ID);
  assert.equal(result.title, 'Hello World');
  assert.equal(result.url, 'https://example.com/a');
  assert.equal(result.guid, 'guid-a');
  assert.equal(result.publishedAt?.toISOString(), '2026-07-15T10:00:00.000Z');
  assert.equal(result.lang, 'ja');
});

test('mapFeedItemToArticle: link が無いアイテムは null', () => {
  const item: Parser.Item = { title: 'No link' };
  assert.equal(mapFeedItemToArticle(FEED_ID, item, null), null);
});

test('mapFeedItemToArticle: title が無ければ url を代替タイトルにする', () => {
  const item: Parser.Item = { link: 'https://example.com/no-title' };
  const result = mapFeedItemToArticle(FEED_ID, item, null);
  assert.equal(result?.title, 'https://example.com/no-title');
});

test('mapFeedItemToArticle: guid が無ければ sha256(url) の hex になる', () => {
  const item: Parser.Item = { title: 'X', link: 'https://example.com/no-guid' };
  const result = mapFeedItemToArticle(FEED_ID, item, null);
  assert.equal(result?.guid, sha256Hex('https://example.com/no-guid'));
});

test('mapFeedItemToArticle: 不正な日付は publishedAt=null になる', () => {
  const item: Parser.Item = { title: 'X', link: 'https://example.com/bad-date', pubDate: 'not-a-date' };
  const result = mapFeedItemToArticle(FEED_ID, item, null);
  assert.equal(result?.publishedAt, null);
});

test('mapFeedItemToArticle: 日付が無ければ publishedAt=null になる', () => {
  const item: Parser.Item = { title: 'X', link: 'https://example.com/no-date' };
  const result = mapFeedItemToArticle(FEED_ID, item, null);
  assert.equal(result?.publishedAt, null);
});

test('mapFeedItemToArticle: content / summary 等は結果に含まれない', () => {
  const item: Parser.Item = {
    title: 'X',
    link: 'https://example.com/has-content',
    content: 'body should not leak',
    contentSnippet: 'snippet should not leak',
    summary: 'summary should not leak',
  };
  const result = mapFeedItemToArticle(FEED_ID, item, null);
  assert.ok(result);
  assert.deepEqual(Object.keys(result).sort(), ['feedId', 'guid', 'lang', 'publishedAt', 'title', 'url']);
});
