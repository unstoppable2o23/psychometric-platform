/**
 * Scoring engine.
 *
 * Pure functions with no database, filesystem, or clock dependencies, so the
 * same code path runs in the request handler, in the seed preview, and in unit
 * tests. Every score is derived from a versioned question pool plus the
 * student's actual stored answers.
 *
 * Two deliberate constraints, per the measurement-integrity rules in the README:
 *
 *  1. Aptitude and interest scores are never merged. They answer different
 *     questions ("what can you do" vs "what draws you"), and averaging them into
 *     a single number hides exactly the tension a student needs to see.
 *  2. No percentiles, population means, or diagnostic cut-offs are produced.
 *     There is no norm group behind this instrument, so a raw-to-normalised
 *     score and a within-student rank are the honest outputs.
 */
import {
  LIKERT_MAX,
  LIKERT_MIN,
  type Dimension,
  type DimensionScore,
  type QuestionType,
  type StreamKey,
  type StreamMatch,
} from '../domain/types';

/* -------------------------------------------------------------------------- */
/* Wire format for stored answers                                              */
/* -------------------------------------------------------------------------- */

export const RESPONSE_SEPARATOR = '|';

export type ScoredOption = { id: string; value: number | null; isCorrect: boolean };

export interface ScoredItem {
  id: string;
  dimensionKey: string;
  type: QuestionType;
  reverseScored: boolean;
  options: ScoredOption[];
}

export interface MatchProfile {
  key: string;
  label: string;
  dimensionWeights: Record<string, number>;
}

/* -------------------------------------------------------------------------- */
/* Answer parsing                                                              */
/* -------------------------------------------------------------------------- */

export type ParsedAnswer =
  | { kind: 'likert'; value: number }
  | { kind: 'single'; optionId: string }
  | { kind: 'multi'; optionIds: string[] }
  | { kind: 'empty' };

export function parseAnswer(raw: string | null | undefined): ParsedAnswer {
  if (raw === null || raw === undefined || raw === '') return { kind: 'empty' };

  // likert
  if (/^[1-5]$/.test(raw)) return { kind: 'likert', value: Number(raw) };

  // single choice: a bare uuid with no separator
  if (!raw.includes(RESPONSE_SEPARATOR)) return { kind: 'single', optionId: raw };

  const optionIds = raw.split(RESPONSE_SEPARATOR).filter(Boolean);
  return { kind: 'multi', optionIds };
}

/** Normalises a client value into the exact string stored in `responses.value`. */
export function normaliseStoredValue(raw: string): string | null {
  const parsed = parseAnswer(raw);
  switch (parsed.kind) {
    case 'empty':
      return null;
    case 'likert':
      return String(parsed.value);
    case 'single':
      return parsed.optionId;
    case 'multi':
      // Canonical order so that "a|b" and "b|a" are stored identically. Without
      // this, re-saving the same selection in a different order leaves a
      // different string on disk for no reason.
      return [...new Set(parsed.optionIds)].sort().join(RESPONSE_SEPARATOR);
  }
}

/* -------------------------------------------------------------------------- */
/* Item-level scoring                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Fraction of the item's available credit earned, in [0, 1].
 *
 * Unanswered items earn 0. That is intentional: this is a timed assessment, and
 * treating a skipped item as "not counted" would let a student raise their score
 * by answering only the easy questions. `itemsAnswered` is reported alongside
 * so a report can state coverage plainly rather than hiding it.
 */
export function scoreItem(item: ScoredItem, answer: ParsedAnswer): number {
  switch (answer.kind) {
    case 'empty':
      return 0;

    case 'likert': {
      if (item.type !== 'likert') return 0;
      const clamped = Math.min(LIKERT_MAX, Math.max(LIKERT_MIN, answer.value));
      const scaled = (clamped - LIKERT_MIN) / (LIKERT_MAX - LIKERT_MIN);
      return item.reverseScored ? 1 - scaled : scaled;
    }

    case 'single': {
      if (item.type !== 'single_choice') return 0;
      const option = item.options.find((o) => o.id === answer.optionId);
      if (!option) return 0;
      const credit = option.isCorrect ? 1 : 0;
      return item.reverseScored ? 1 - credit : credit;
    }

    case 'multi': {
      if (item.type !== 'multi_select') return 0;
      // Partial credit by overlap, then penalised by over-selection so that
      // ticking every box does not outperform a considered answer.
      const selected = new Set(answer.optionIds);
      const correct = new Set(item.options.filter((o) => o.isCorrect).map((o) => o.id));
      if (correct.size === 0) return 0;

      let hits = 0;
      for (const id of selected) if (correct.has(id)) hits += 1;

      const recall = hits / correct.size;
      const precision = selected.size === 0 ? 0 : hits / selected.size;
      const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
      return item.reverseScored ? 1 - f1 : f1;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Dimension aggregation                                                       */
/* -------------------------------------------------------------------------- */

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function scoreDimensions(
  dimensions: Dimension[],
  items: ScoredItem[],
  responses: ReadonlyMap<string, string>,
): DimensionScore[] {
  const byDimension = new Map<string, ScoredItem[]>();
  for (const dimension of dimensions) byDimension.set(dimension.key, []);
  for (const item of items) {
    const bucket = byDimension.get(item.dimensionKey);
    if (bucket) bucket.push(item);
  }

  const partial = dimensions.map((dimension) => {
    const bucket = byDimension.get(dimension.key) ?? [];
    let raw = 0;
    let answered = 0;

    for (const item of bucket) {
      const rawAnswer = responses.get(item.id);
      if (rawAnswer !== undefined && parseAnswer(rawAnswer).kind !== 'empty') answered += 1;
      raw += scoreItem(item, parseAnswer(rawAnswer));
    }

    const max = bucket.length;
    const normalized = max === 0 ? 0 : round2((raw / max) * 100);

    return {
      key: dimension.key,
      label: dimension.label,
      kind: dimension.kind,
      description: dimension.description,
      rawScore: round2(raw),
      maxRawScore: max,
      normalizedScore: normalized,
      itemsAnswered: answered,
      itemsTotal: max,
      rank: 0,
    } satisfies DimensionScore;
  });

  // Rank within this student's own profile only. A 70 here and a 30 there mean
  // "relative to each other", never "compared with other students".
  const ordered = [...partial].sort((a, b) => b.normalizedScore - a.normalizedScore);
  ordered.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  return partial;
}

/* -------------------------------------------------------------------------- */
/* Weighted stream matching                                                    */
/* -------------------------------------------------------------------------- */

export const STREAM_LABELS: Record<StreamKey, string> = {
  science: 'Science (PCMB)',
  commerce: 'Commerce',
  arts: 'Arts and Humanities',
  vocational: 'Vocational and Skill-Based',
};

/**
 * Bands group a student's own four fit scores into narrative tiers. They are a
 * presentation device, not validated cut-scores: with no norm group behind this
 * instrument there is no basis for calling 66 a "high" score in absolute terms.
 */
export function bandFor(fitScore: number): 1 | 2 | 3 {
  if (fitScore >= 66) return 3;
  if (fitScore >= 45) return 2;
  return 1;
}

export interface MatchOutcome {
  matches: StreamMatch[];
  byKey: Map<StreamKey, StreamMatch>;
}

/**
 * Weighted fit: each stream declares how much it draws on each dimension, and
 * the fit score is the weighted mean of the student's normalised dimension
 * scores. Adding a dimension or reweighting a stream is a data change, not a
 * code change.
 */
export function matchProfiles(
  profiles: readonly MatchProfile[],
  dimensionScores: DimensionScore[],
  rationales: Record<string, string[]> = {},
): MatchOutcome {
  const scoreByKey = new Map(dimensionScores.map((d) => [d.key, d.normalizedScore]));

  const matches = profiles.map((profile) => {
    const entries = Object.entries(profile.dimensionWeights).filter(([, w]) => w > 0);
    const weightTotal = entries.reduce((sum, [, w]) => sum + w, 0);

    const fitScore =
      weightTotal === 0
        ? 0
        : round2(
            entries.reduce((sum, [key, weight]) => sum + (scoreByKey.get(key) ?? 0) * weight, 0) /
              weightTotal,
          );

    // Name the dimensions that actually lifted this stream, strongest first.
    const ranked = entries
      .map(([key, weight]) => ({
        key,
        weight,
        score: scoreByKey.get(key) ?? 0,
        contribution: weight * (scoreByKey.get(key) ?? 0),
      }))
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 4);

    const contributing = ranked.map((entry) => {
      const label = dimensionScores.find((d) => d.key === entry.key)?.label ?? entry.key;
      return `${label} (${entry.score.toFixed(0)}/100, weight ${entry.weight})`;
    });

    const streamKey = profile.key as StreamKey;

    return {
      stream: streamKey,
      label: STREAM_LABELS[streamKey] ?? profile.label,
      fitScore,
      band: bandFor(fitScore),
      headline: '',
      rationale: rationales[profile.key] ?? [],
      contributingDimensions: contributing,
      contributingDimensionKeys: ranked.map((entry) => entry.key),
    } satisfies StreamMatch;
  });

  matches.sort((a, b) => b.fitScore - a.fitScore);

  return {
    matches,
    byKey: new Map(matches.map((m) => [m.stream, m])),
  };
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                   */
/* -------------------------------------------------------------------------- */

export interface Coverage {
  answered: number;
  total: number;
  ratio: number;
  meetsMinimum: boolean;
}

export function coverageFor(items: ScoredItem[], responses: ReadonlyMap<string, string>, minRatio: number): Coverage {
  const total = items.length;
  let answered = 0;
  for (const item of items) {
    if (parseAnswer(responses.get(item.id)).kind !== 'empty') answered += 1;
  }
  const ratio = total === 0 ? 0 : answered / total;
  return { answered, total, ratio: round2(ratio), meetsMinimum: ratio >= minRatio };
}
