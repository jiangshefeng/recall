import test from 'node:test';
import assert from 'node:assert/strict';
import { supplementLinkedSummaries } from '../scripts/locomo-linked-summaries';
import { DEFAULT_RETRIEVAL_POLICY } from '../src/lib/retrieval';
import type { Evidence, Memory } from '../src/lib/types';

const memory = (id: string, sourceIds: string[], vector = [1, 0]): Memory => ({
  id, sourceIds, vector, scope: 's', space: 'e', summary: `Summary ${id}`, status: 'hot',
  parentIds: [], reason: '', createdAt: '2024-01-01', kind: 'fact',
});
function evidence(memories: Memory[]): Evidence {
  return {
    first: memories.map(({ vector: _vector, ...m }) => ({ ...m, score: 1 })), second: [], records: [], strategy: 'expand',
    context: memories.map((m, i) => ({ id: m.id, content: m.summary, date: m.createdAt, citation: i + 1, kind: 'summary', truncated: false })),
    trace: { expanded: false, reason: 'enough-first-results', firstCandidates: memories.length, minScore: 0.45,
      policy: DEFAULT_RETRIEVAL_POLICY, usage: { records: memories.length, chars: 0, estimatedTokens: 0, truncatedRecords: 0 } },
  };
}

test('expands all sources of first eight seeds once, deduplicates and ranks added summaries by query', () => {
  const seeds = Array.from({ length: 9 }, (_, i) => memory(`seed${i + 1}`, [`r${i + 1}`]));
  seeds[0].sourceIds.push('extra1', 'extra2', 'extra3', 'extra4');
  const input = evidence(seeds), before = structuredClone(input);
  const candidates = [memory('a', ['r1', 'r8', 'indirect'], [0.8, 0.6]), memory('b', ['r8']),
    memory('last-source', ['extra4'], [0, 1]), memory('ninth', ['r9']), memory('recursive', ['indirect'])];
  const result = supplementLinkedSummaries(input, [...seeds, ...candidates, candidates[0]], [1, 0]);
  assert.deepEqual(result.selected.map(m => m.id), ['b', 'a', 'last-source']);
  assert.equal(result.seedIds.length, 8);
  assert.deepEqual(result.context.slice(0, input.context.length), input.context);
  assert.equal(result.context.every(m => m.kind === 'summary'), true);
  assert.deepEqual(input, before);
});

test('excludes cold/other scope/other space summaries and respects shared budgets', () => {
  const seed = memory('seed', ['r']);
  const input = evidence([seed]);
  input.trace.policy = { ...DEFAULT_RETRIEVAL_POLICY, maxContextChars: 700, maxEstimatedTokens: 250, maxRecordChars: 500 };
  const good = { ...memory('good', ['r']), summary: 'Long summary '.repeat(500) };
  const result = supplementLinkedSummaries(input, [seed, good,
    { ...memory('cold', ['r']), status: 'cold' }, { ...memory('otherScope', ['r']), scope: 'other' },
    { ...memory('otherSpace', ['r']), space: 'other' }], [1, 0]);
  assert.deepEqual(result.selected.map(m => m.id), ['good']);
  assert.equal(result.addedSummaries[0].truncated, true);
  assert.ok(result.usage.chars <= 700 && result.usage.estimatedTokens <= 250);
  assert.deepEqual(supplementLinkedSummaries(evidence([]), [], [1, 0]).selected, []);
  assert.throws(() => supplementLinkedSummaries(evidence([seed]), [memory('bad', ['r'], [1])], [1, 0]), /compatible/);
});
