/**
 * Unit tests for the scoring engine.
 *
 * These are pure-function tests: no database, no clock, no I/O.
 */
import { describe, expect, it } from 'vitest';
import {
  bandFor,
  coverageFor,
  matchProfiles,
  normaliseStoredValue,
  parseAnswer,
  RESPONSE_SEPARATOR,
  scoreDimensions,
  scoreItem,
  type ScoredItem,
} from '@/lib/scoring/engine';
import type { Dimension } from '@/lib/domain/types';
import {
  DIMENSIONS,
  STREAM_PROFILES,
} from '@/server/content/stream-selector';
import {
  assertBankIntegrity,
  buildStreamSelectorQuestions,
  EXPECTED_QUESTION_COUNT,
} from '@/server/content/stream-selector-questions';

const likert = (id: string, dimensionKey: string, reverse = false): ScoredItem => ({
  id,
  dimensionKey,
  type: 'likert',
  reverseScored: reverse,
  options: [],
});

const choice = (id: string, dimensionKey: string, correctId: string): ScoredItem => ({
  id,
  dimensionKey,
  type: 'single_choice',
  reverseScored: false,
  options: [
    { id: correctId, value: null, isCorrect: true },
    { id: `${correctId}-b`, value: null, isCorrect: false },
  ],
});

const dim = (key: string, kind: 'aptitude' | 'interest'): Dimension => ({
  key,
  label: key,
  kind,
  description: '',
  weight: 1,
});

describe('parseAnswer', () => {
  it('reads a likert value', () => {
    expect(parseAnswer('4')).toEqual({ kind: 'likert', value: 4 });
  });

  it('reads a single option id', () => {
    expect(parseAnswer('abc-123')).toEqual({ kind: 'single', optionId: 'abc-123' });
  });

  it('reads a multi-select value', () => {
    expect(parseAnswer(`a${RESPONSE_SEPARATOR}b${RESPONSE_SEPARATOR}c`)).toEqual({
      kind: 'multi',
      optionIds: ['a', 'b', 'c'],
    });
  });

  it('treats blank as empty', () => {
    expect(parseAnswer('')).toEqual({ kind: 'empty' });
    expect(parseAnswer(null)).toEqual({ kind: 'empty' });
    expect(parseAnswer(undefined)).toEqual({ kind: 'empty' });
  });

  it('does not mistake an out-of-range likert number for a choice', () => {
    expect(parseAnswer('7')).toEqual({ kind: 'single', optionId: '7' });
  });
});

describe('normaliseStoredValue', () => {
  it('canonicalises a multi-select', () => {
    expect(normaliseStoredValue(`b${RESPONSE_SEPARATOR}a`)).toBe(`a${RESPONSE_SEPARATOR}b`);
  });

  it('maps blank to null so it is never persisted', () => {
    expect(normaliseStoredValue('')).toBeNull();
  });
});

describe('scoreItem', () => {
  it('awards full credit for a correct answer', () => {
    expect(scoreItem(choice('q1', 'verbal', 'right'), { kind: 'single', optionId: 'right' })).toBe(1);
  });

  it('awards nothing for a wrong answer', () => {
    expect(scoreItem(choice('q1', 'verbal', 'right'), { kind: 'single', optionId: 'right-b' })).toBe(0);
  });

  it('awards nothing for an unknown option id', () => {
    expect(scoreItem(choice('q1', 'verbal', 'right'), { kind: 'single', optionId: 'nope' })).toBe(0);
  });

  it('maps the likert endpoints onto 0 and 1', () => {
    const item = likert('q1', 'riasec_i');
    expect(scoreItem(item, { kind: 'likert', value: 1 })).toBe(0);
    expect(scoreItem(item, { kind: 'likert', value: 5 })).toBe(1);
    expect(scoreItem(item, { kind: 'likert', value: 3 })).toBeCloseTo(0.5, 5);
  });

  it('flips a reverse-scored item', () => {
    const item = likert('q1', 'riasec_c', true);
    expect(scoreItem(item, { kind: 'likert', value: 1 })).toBe(1);
    expect(scoreItem(item, { kind: 'likert', value: 5 })).toBe(0);
  });

  it('scores multi-select by F1 so over-selection is penalised', () => {
    const item: ScoredItem = {
      id: 'q1',
      dimensionKey: 'verbal',
      type: 'multi_select',
      reverseScored: false,
      options: [
        { id: 'a', value: null, isCorrect: true },
        { id: 'b', value: null, isCorrect: true },
        { id: 'c', value: null, isCorrect: false },
        { id: 'd', value: null, isCorrect: false },
      ],
    };
    const perfect = scoreItem(item, { kind: 'multi', optionIds: ['a', 'b'] });
    const everything = scoreItem(item, { kind: 'multi', optionIds: ['a', 'b', 'c', 'd'] });
    expect(perfect).toBeCloseTo(1, 5);
    expect(everything).toBeLessThan(perfect);
    // recall 2/2 = 1, precision 2/4 = 0.5, so F1 = 2*1*0.5 / 1.5 = 0.6667
    expect(everything).toBeCloseTo(2 / 3, 5);
  });

  it('awards nothing for an unanswered item rather than dropping it', () => {
    expect(scoreItem(choice('q1', 'verbal', 'right'), { kind: 'empty' })).toBe(0);
  });

  it('ignores a likert value submitted to a choice item', () => {
    expect(scoreItem(choice('q1', 'verbal', 'right'), { kind: 'likert', value: 5 })).toBe(0);
  });
});

describe('scoreDimensions', () => {
  it('normalises to 0-100 and ranks within the student', () => {
    const dimensions = [dim('verbal', 'aptitude'), dim('numerical', 'aptitude'), dim('spatial', 'aptitude')];
    const items = [
      choice('v1', 'verbal', 'v1a'),
      choice('v2', 'verbal', 'v2a'),
      choice('n1', 'numerical', 'n1a'),
      choice('s1', 'spatial', 's1a'),
    ];
    const responses = new Map([
      ['v1', 'v1a'],
      ['v2', 'v1b'],
      ['n1', 'n1a'],
      ['s1', 's1a'],
    ]);

    const scores = scoreDimensions(dimensions, items, responses);
    const byKey = new Map(scores.map((s) => [s.key, s]));

    expect(byKey.get('verbal')!.normalizedScore).toBe(50);
    expect(byKey.get('numerical')!.normalizedScore).toBe(100);
    expect(byKey.get('spatial')!.normalizedScore).toBe(100);

    // spatial and numerical tie at 100; both must rank above verbal, and ties
    // must not share a rank number.
    expect(byKey.get('verbal')!.rank).toBe(3);
    expect(byKey.get('numerical')!.rank).toBeLessThan(3);
    expect(byKey.get('spatial')!.rank).toBeLessThan(3);
  });

  it('reports coverage alongside the score', () => {
    const dimensions = [dim('verbal', 'aptitude')];
    const items = [choice('v1', 'verbal', 'v1a'), choice('v2', 'verbal', 'v2a')];
    const scores = scoreDimensions(dimensions, items, new Map([['v1', 'v1a']]));
    expect(scores[0].itemsAnswered).toBe(1);
    expect(scores[0].itemsTotal).toBe(2);
    expect(scores[0].normalizedScore).toBe(50);
  });

  it('handles a dimension with no items without dividing by zero', () => {
    const scores = scoreDimensions([dim('empty', 'aptitude')], [], new Map());
    expect(scores[0].normalizedScore).toBe(0);
    expect(scores[0].maxRawScore).toBe(0);
  });

  it('ignores responses for items outside the version', () => {
    const dimensions = [dim('verbal', 'aptitude')];
    const items = [choice('v1', 'verbal', 'v1a')];
    const responses = new Map([
      ['v1', 'v1a'],
      ['stray', 'v1a'],
    ]);
    expect(scoreDimensions(dimensions, items, responses)[0].normalizedScore).toBe(100);
  });
});

describe('coverageFor', () => {
  it('reports the answered ratio and whether the minimum is met', () => {
    const items = [
      choice('a', 'verbal', 'a1'),
      choice('b', 'verbal', 'b1'),
      choice('c', 'verbal', 'c1'),
      choice('d', 'verbal', 'd1'),
    ];
    const responses = new Map([
      ['a', 'a1'],
      ['b', 'b1'],
      ['c', 'c1'],
    ]);

    const loose = coverageFor(items, responses, 0.5);
    expect(loose.answered).toBe(3);
    expect(loose.total).toBe(4);
    expect(loose.ratio).toBe(0.75);
    expect(loose.meetsMinimum).toBe(true);

    expect(coverageFor(items, responses, 0.9).meetsMinimum).toBe(false);
  });
});

describe('matchProfiles', () => {
  const dimensions = [
    { key: 'verbal', label: 'Verbal', kind: 'aptitude' as const, description: '', rawScore: 0, maxRawScore: 0, normalizedScore: 90, itemsAnswered: 0, itemsTotal: 0, rank: 1 },
    { key: 'numerical', label: 'Numerical', kind: 'aptitude' as const, description: '', rawScore: 0, maxRawScore: 0, normalizedScore: 20, itemsAnswered: 0, itemsTotal: 0, rank: 2 },
  ];

  it('produces a weighted mean, not an unweighted average', () => {
    const outcome = matchProfiles(
      [
        { key: 'verbal-heavy', label: 'Verbal heavy', dimensionWeights: { verbal: 3, numerical: 1 } },
        { key: 'even', label: 'Even', dimensionWeights: { verbal: 1, numerical: 1 } },
      ],
      dimensions,
    );
    // 3:1 -> (90*3 + 20*1) / 4 = 72.5 ; even -> 55
    expect(outcome.matches.find((m) => m.label === 'Verbal heavy')!.fitScore).toBe(72.5);
    expect(outcome.matches.find((m) => m.label === 'Even')!.fitScore).toBe(55);
  });

  it('sorts strongest fit first and indexes by key', () => {
    const outcome = matchProfiles(STREAM_PROFILES, dimensions);
    expect(outcome.matches[0].fitScore).toBeGreaterThanOrEqual(outcome.matches[1].fitScore);
    expect(outcome.byKey.get('science')).toBeDefined();
  });

  it('treats a profile with no weights as zero rather than NaN', () => {
    const outcome = matchProfiles([{ key: 'x', label: 'X', dimensionWeights: {} }], dimensions);
    expect(outcome.matches[0].fitScore).toBe(0);
  });

  it('bands on the fit score', () => {
    expect(bandFor(70)).toBe(3);
    expect(bandFor(50)).toBe(2);
    expect(bandFor(10)).toBe(1);
  });
});

describe('Stream Selector content', () => {
  it('has a complete, non-duplicated question bank', () => {
    expect(() => assertBankIntegrity()).not.toThrow();
    expect(buildStreamSelectorQuestions().length).toBe(EXPECTED_QUESTION_COUNT);
  });

  it('only references dimension keys that actually exist', () => {
    const keys = new Set(DIMENSIONS.map((d) => d.key));
    for (const profile of STREAM_PROFILES) {
      for (const weightKey of Object.keys(profile.dimensionWeights)) {
        expect(keys.has(weightKey), `stream "${profile.key}" references unknown dimension "${weightKey}"`).toBe(true);
      }
    }
  });

  it('gives every stream a non-empty weighting', () => {
    for (const profile of STREAM_PROFILES) {
      const total = Object.values(profile.dimensionWeights).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(0);
    }
  });

  it('maps every question to a real dimension', () => {
    const keys = new Set(DIMENSIONS.map((d) => d.key));
    for (const question of buildStreamSelectorQuestions()) {
      expect(keys.has(question.dimension), `${question.key} -> ${question.dimension}`).toBe(true);
    }
  });

  it('covers every dimension with at least one item', () => {
    const counts = new Map<string, number>();
    for (const q of buildStreamSelectorQuestions()) {
      counts.set(q.dimension, (counts.get(q.dimension) ?? 0) + 1);
    }
    for (const d of DIMENSIONS) {
      expect(counts.get(d.key) ?? 0, `dimension ${d.key} has no items`).toBeGreaterThan(0);
    }
  });

  it('only marks reverse scoring on likert items', () => {
    for (const q of buildStreamSelectorQuestions()) {
      if (q.reverseScored) expect(q.type).toBe('likert');
    }
  });
});
