/**
 * Interpretation and recommendation generation.
 *
 * Every sentence produced here is derived from the student's own stored
 * responses. The generator takes scores as input and returns prose; it never
 * invents a number, and it never claims a comparison the data cannot support.
 * Where a real norm group would be required to make a claim, the text says so
 * instead of guessing.
 */
import type { DimensionScore, StreamKey, StreamMatch } from '../domain/types';

export interface StreamContent {
  key: StreamKey;
  label: string;
  subjects: string[];
  activities: string[];
  pathways: string[];
  /** Keyed by the dimension that justifies the suggestion. */
  rationale: Record<string, string>;
}

export interface InterpretationInput {
  studentDisplayName: string;
  grade: number | null;
  dimensions: DimensionScore[];
  matches: StreamMatch[];
  streamContent: Record<string, StreamContent>;
  answeredQuestions: number;
  totalQuestions: number;
  completedInSeconds: number;
}

export interface Interpretation {
  interpretation: string[];
  recommendations: { title: string; detail: string; dimensionKey?: string }[];
  actionPlan: { window: string; items: string[] }[];
  discussionQuestions: string[];
  strongestDimensions: DimensionScore[];
  developmentDimensions: DimensionScore[];
}

const pct = (n: number): string => `${Math.round(n)}%`;
const mins = (seconds: number): string => `${Math.max(1, Math.round(seconds / 60))} minutes`;

/** Dimensions that are close together are treated as a "balanced" pairing. */
function isBalanced(a: DimensionScore, b: DimensionScore, tolerance = 12): boolean {
  return Math.abs(a.normalizedScore - b.normalizedScore) <= tolerance;
}

function topOf<K extends string>(scores: DimensionScore[], kind: K): DimensionScore[] {
  return scores.filter((s) => s.kind === kind).sort((a, b) => a.rank - b.rank);
}

export function buildInterpretation(input: InterpretationInput): Interpretation {
  const { dimensions, matches, streamContent } = input;

  const aptitude = topOf(dimensions, 'aptitude').sort((a, b) => a.rank - b.rank);
  const interest = topOf(dimensions, 'interest').sort((a, b) => a.rank - b.rank);

  const strongest = [...dimensions].sort((a, b) => a.rank - b.rank);
  const topThree = strongest.slice(0, 3);
  const development = [...dimensions].sort((a, b) => b.normalizedScore - a.normalizedScore).slice(0, 2);

  const topAptitude = aptitude[0];
  const secondAptitude = aptitude[1];
  const topInterest = interest[0];
  const secondInterest = interest[1];
  const weakestInterest = interest[interest.length - 1];

  const leading = matches[0];
  const runnerUp = matches[1];

  /* ---------------- interpretation ---------------- */

  const interpretation: string[] = [];

  interpretation.push(
    `You answered ${input.answeredQuestions} of ${input.totalQuestions} questions in about ${mins(
      input.completedInSeconds,
    )}. The profile below is built only from the answers you gave; questions you left blank count as no credit rather than being quietly dropped, so a low score on any dimension is partly a signal about coverage as well as about the skill itself.`,
  );

  if (topThree.length >= 3) {
    interpretation.push(
      `Your three strongest dimensions are ${topThree
        .map((d) => `${d.label} (${pct(d.normalizedScore)})`)
        .join(', ')}. These are the areas where your answers clustered most strongly, and they are the best places to invest deliberate practice because effort here tends to show up fastest.`,
    );
  }

  if (topAptitude && secondAptitude) {
    if (isBalanced(topAptitude, secondAptitude)) {
      interpretation.push(
        `On the aptitude side your profile is notably even: ${topAptitude.label} (${pct(
          topAptitude.normalizedScore,
        )}) and ${secondAptitude.label} (${pct(
          secondAptitude.normalizedScore,
        )}) sit within a few points of each other. A balanced aptitude profile is genuinely useful at this stage, because it keeps more subject combinations open to you rather than ruling any out early.`,
      );
    } else {
      interpretation.push(
        `${topAptitude.label} (${pct(topAptitude.normalizedScore)}) stands clearly ahead of your next aptitude dimension, ${secondAptitude.label} (${pct(
          secondAptitude.normalizedScore,
        )}). A clear lead like this usually means you will get more out of subjects that lean on ${topAptitude.label.toLowerCase()}.`,
      );
    }
  }

  if (topInterest && secondInterest) {
    interpretation.push(
      `Your interest responses lean towards ${topInterest.label.toLowerCase()} (${pct(
        topInterest.normalizedScore,
      )}), with ${secondInterest.label.toLowerCase()} (${pct(
        secondInterest.normalizedScore,
      )}) next. Interests describe what you are drawn to when nobody is grading you, which is a different and less trainable signal than aptitude.`,
    );
  }

  // The most informative thing in the profile is usually the tension between
  // the two families, so it gets its own paragraph rather than being averaged away.
  if (topAptitude && topInterest) {
    if (isBalanced(topAptitude, topInterest, 10)) {
      interpretation.push(
        `Your strongest aptitude dimension and your strongest interest dimension point in broadly the same direction, which is the easiest situation to act on. Nothing in your profile is pulling you away from what you are already inclined towards.`,
      );
    } else {
      interpretation.push(
        `Here is the interesting tension in your profile: your aptitude leans towards ${topAptitude.label.toLowerCase()}, while your interest pulls you towards ${topInterest.label.toLowerCase()}. This is very common and it is not a contradiction to resolve. Plenty of students do well in a subject that is not their favourite. It is worth keeping both pieces of information in view when you choose a stream, rather than letting either one decide on its own.`,
      );
    }
  }

  if (weakestInterest && topInterest && !isBalanced(weakestInterest, topInterest, 10)) {
    interpretation.push(
      `${weakestInterest.label.toLowerCase()} drew the weakest responses (${pct(
        weakestInterest.normalizedScore,
      )}). Read that as a current preference rather than a fixed trait. Interests at this age are still forming, and many students find this changes once they have actually spent time in the activity.`,
    );
  }

  if (leading) {
    const content = streamContent[leading.stream];
    interpretation.push(
      `Weighing your aptitude and interest responses together, ${leading.label} shows the highest fit at ${pct(
        leading.fitScore,
      )}, ahead of ${runnerUp ? `${runnerUp.label} (${pct(runnerUp.fitScore)})` : 'the other options'}. This is a weighted comparison of your own scores, not a prediction and not a ranking against other students.`,
    );
    if (content) {
      // Looked up by dimension key. Previously this parsed the first word out of
      // the rendered label ("Numerical" from "Numerical Aptitude (...)"), which
      // never matches the lowercase keys in the content table, so this paragraph
      // silently never appeared.
      const strongestKey = leading.contributingDimensionKeys[0];
      const rationaleForDimension = strongestKey ? content.rationale[strongestKey] : undefined;
      if (rationaleForDimension) {
        interpretation.push(rationaleForDimension);
      }
    }
  }

  interpretation.push(
    `A note on what this report cannot do. These scores are not compared against any population, because we do not have a validated norm group for this assessment. That means a score here should not be read as "you scored higher than X% of students", and it should not be used on its own to decide an admission, a scholarship, or an eligibility. Treat it as a structured starting point for a conversation.`,
  );

  /* ---------------- recommendations ---------------- */

  const recommendations: { title: string; detail: string; dimensionKey?: string }[] = [];

  for (const match of matches.slice(0, 3)) {
    const content = streamContent[match.stream];
    if (!content) continue;
    const topDriver = leading === match ? match.contributingDimensions : match.contributingDimensions;

    recommendations.push({
      title: `Explore ${content.label}`,
      dimensionKey: topDriver[0]?.split(' ')[0],
      detail: `${match.label} fits your current profile at ${pct(match.fitScore)}. If it interests you, the subjects that carry it most directly are ${content.subjects
        .slice(0, 3)
        .join(', ')}. Try one of these before committing: ${content.activities[0]}.`,
    });
  }

  if (topAptitude) {
    recommendations.push({
      title: `Build on ${topAptitude.label}`,
      dimensionKey: topAptitude.key,
      detail: `This is your strongest measured dimension at ${pct(
        topAptitude.normalizedScore,
      )}. ${topAptitude.description} Because it is already your strongest area, it is the one where extra effort pays back fastest.`,
    });
  }

  for (const dimension of development) {
    recommendations.push({
      title: `Give ${dimension.label} some deliberate attention`,
      dimensionKey: dimension.key,
      detail: `This scored lowest in your profile at ${pct(dimension.normalizedScore)} (${
        dimension.itemsAnswered
      } of ${dimension.itemsTotal} items answered). ${dimension.description} A single term of regular practice here would do more for your options than any amount of further career research.`,
    });
  }

  /* ---------------- action plan ---------------- */

  const actionPlan: { window: string; items: string[] }[] = [];
  const leadingContent = leading ? streamContent[leading.stream] : undefined;

  actionPlan.push({
    window: 'This week',
    items: [
      `Write down your top two streams from the fit scores above and note one sentence on why each appeals to you. Come back to it in a month.`,
      topAptitude
        ? `Spend two hours this week on ${topAptitude.label.toLowerCase()} outside of school: past papers, a puzzle book, a practical project. Notice whether you enjoy it or only tolerate it.`
        : 'Pick one skill you have avoided and try it once this week.',
      leadingContent
        ? `Read one short piece about what someone in ${leadingContent.label} actually does all day, rather than what the stream is called.`
        : 'Read one short piece about a field you have not considered before.',
    ],
  });

  actionPlan.push({
    window: 'Next 30 days',
    items: [
      leadingContent
        ? `Attempt one small project from ${leadingContent.subjects[0] ?? 'a subject you enjoy'}. The goal is the experience, not the grade.`
        : 'Attempt one small project in a subject you enjoy.',
      `Revisit ${development[0]?.label.toLowerCase() ?? 'your weakest dimension'} deliberately: two focused sessions a week for a month is usually enough to move a score noticeably.`,
      `Talk to one person who studied or works in ${leading?.label ?? 'a field you are considering'} and ask them what they found hardest, not what they found best.`,
    ],
  });

  actionPlan.push({
    window: 'Before choosing a stream',
    items: [
      'Re-take this assessment in about six months and compare the two profiles. Movement over time is far more informative than a single sitting.',
      'Check the actual subject and combination requirements at your school or board, since those constrain the decision more than scores do.',
      'Bring this report to a teacher or counsellor. The discussion matters more than the document.',
    ],
  });

  /* ---------------- questions to discuss ---------------- */

  const discussionQuestions = [
    `Which subject do you most look forward to, and which one do you most want finished? If those two are different, why?`,
    `${topAptitude ? `When you solve a ${topAptitude.label.toLowerCase()} problem, what specifically do you enjoy — the process, the answer, or being right?` : 'What kind of problem makes you lose track of time?'}`,
    `${development[0] ? `What has historically been hardest for you in ${development[0].label.toLowerCase()}, and is that about the topic, the teaching, or how you were taught?` : 'Is there something you have been told you are bad at, and how did you get that idea?'}`,
    `Does anyone in your family have expectations about your stream that you have not talked about openly?`,
    `If you knew you could not fail, what would you study? How does that answer differ from the one you would give safely?`,
    'Which of these results surprised you? Surprises are usually where the useful self-knowledge is.',
  ];

  return {
    interpretation,
    recommendations,
    actionPlan,
    discussionQuestions,
    strongestDimensions: topThree,
    developmentDimensions: development,
  };
}

export const DISCLAIMER =
  'This assessment is an educational guidance tool. It measures how you responded on the day, against the questions in this version. It is not a psychological, medical, or clinical assessment, it is not a validated intelligence test, and it is compared against no population norms. Results should not be used to determine eligibility, admission, or suitability for any programme, and they do not limit what you can study or do in future. Decisions about streams and subjects should be made alongside your school, your parents, and a qualified counsellor, and ideally after you have had some first-hand experience of the subjects involved.';
