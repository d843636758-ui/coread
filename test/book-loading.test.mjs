import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOK_SLICE_SIZE, LARGE_BOOK_THRESHOLD, loadBookSlices } from '../web/book-loading.mjs';

test('a 14,594-paragraph EPUB is fetched in mobile-safe chunks', async () => {
  const totalParas = 14594;
  const calls = [];
  const result = await loadBookSlices({
    totalParas,
    fetchSlice: async (start, count) => {
      calls.push({ start, count });
      const length = Math.min(count, totalParas - start);
      return {
        paragraphs: Array.from({ length }, (_, i) => ({ idx: start + i, content: `p${start + i}` })),
        comments: [],
      };
    },
  });

  assert.ok(totalParas > LARGE_BOOK_THRESHOLD);
  assert.equal(result.paragraphs.length, totalParas);
  assert.ok(calls.length > 1);
  assert.ok(calls.every(call => call.count === BOOK_SLICE_SIZE));
  assert.equal(Math.max(...calls.map(call => call.count)), 1000);
});

test('a transient slice failure is retried without duplicating content or comments', async () => {
  let attempts = 0;
  const progress = [];
  const result = await loadBookSlices({
    totalParas: 2,
    chunkSize: 2,
    fetchSlice: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary network error');
      return {
        paragraphs: [{ idx: 0, content: 'a' }, { idx: 1, content: 'b' }],
        comments: [{ id: 7 }, { id: 7 }],
      };
    },
    onProgress: value => progress.push(value),
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result.paragraphs.map(p => p.idx), [0, 1]);
  assert.deepEqual(result.comments.map(c => c.id), [7]);
  assert.deepEqual(progress, [1]);
});
