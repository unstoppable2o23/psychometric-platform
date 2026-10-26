/**
 * Stream Selector question bank.
 *
 * Format notes
 * ------------
 * Likert items are bare prompts on a shared five-point scale. Choice items are
 * `[prompt, options, correct]`, where `correct` is an index for single_choice or
 * an array of indices for multi_select.
 *
 * Answer keys live here and in the database, and are stripped before a question
 * is ever serialised to the student (see toStudentQuestion in engine-adjacent
 * DAL code). Nothing in this file should be imported by client components.
 *
 * 150 items: 75 measured aptitude, 75 self-reported interest.
 */
import type { QuestionType } from '@/lib/domain/types';

export type ChoiceItem = [prompt: string, options: string[], correct: number | number[]];
export type LikertItem = [prompt: string, helpText?: string];

export interface SeedQuestion {
  key: string;
  dimension: string;
  type: QuestionType;
  prompt: string;
  helpText: string | null;
  reverseScored: boolean;
  options: string[];
  correct: number[];
}

/* ========================================================================== */
/* APTITUDE                                                                   */
/* ========================================================================== */

const VERBAL: ChoiceItem[] = [
  ['Choose the word closest in meaning to "abundant".', ['Scarce', 'Plentiful', 'Fragile', 'Hesitant'], 1],
  ['Complete the pair: "elephant is to herd as sheep is to ___".', ['Pen', 'Flock', 'Cub', 'Stable'], 1],
  ['Which sentence uses "affect" correctly?', ['It will affect the outcome.', 'It will affect the results.', 'The results affect it.', 'It will affect to the outcome.'], 0],
  ['Select the best completion: "Despite the rain, the match went ahead because ___".', ['the ground was flooded', 'the players were determined', 'it was expected to rain', 'the umpire was absent'], 1],
  ['What does the phrase "a blessing in disguise" mean?', ['A hidden problem', 'Something unpleasant turned out well', 'An obvious compliment', 'A reward given publicly'], 1],
  ['Choose the word that is least similar to the others.', ['Cautious', 'Careful', 'Wary', 'Reckless'], 3],
  ['Identify the odd relationship: "author : book :: composer : ___".', ['Song', 'Instrument', 'Stage', 'Audience'], 0],
  ['Read: "The report is provisional pending verification." The report is:', ['Final and official', 'Subject to confirmation', 'Rejected by the committee', 'Confidential'], 1],
  ['Choose the synonym of "mitigate".', ['Aggravate', 'Worsen', 'Reduce', 'Announce'], 2],
  ['In which sentence is the subject clearly doing the verb? "The boy ___ the ball."', ['was kicked by', 'kicked', 'that kicked', 'with kicked'], 1],
  ['What does "he runs a small enterprise" most likely mean?', ['He jogs near a company', 'He owns a small business', 'He works part-time', 'He manages a school'], 1],
  ['Select the correctly ordered sequence: "___ the door, she switched off the light."', ['Having locked', 'Locking', 'Locked', 'Lock'], 0],
  ['The opposite of "meticulous" is:', ['Careful', 'Hasty', 'Thorough', 'Precise'], 1],
  ['"Rani is the most diligent student in the class." Diligent means:', ['Talkative', 'Hardworking', 'Shy', 'Stubborn'], 1],
  ['Choose the best title for a short story about a girl who misplaces her passport on the day of a flight.', ['The Long Road', 'Passport Trouble', 'A Difficult Morning', 'The Airport'], 1],
  ['Which word does not belong: "concise, brief, lengthy, succinct"?', ['Concise', 'Brief', 'Lengthy', 'Succinct'], 2],
];

const NUMERICAL: ChoiceItem[] = [
  ['What is 15% of 240?', ['24', '36', '40', '48'], 1],
  ['A shop buys an item for ₹800 and sells it for ₹920. The profit percentage is:', ['13%', '15%', '20%', '23%'], 1],
  ['If 8 workers build a wall in 12 days, how many days would 6 workers take at the same rate?', ['14', '16', '18', '20'], 1],
  ['Find the next number: 3, 6, 11, 18, 27, ___', ['36', '38', '40', '42'], 1],
  ['A train travels 240 km in 3 hours. At the same speed, how far in 5 hours?', ['360 km', '400 km', '420 km', '450 km'], 1],
  ['What is the smallest number that leaves remainder 3 when divided by 5, 7 and 11?', ['33', '38', '43', '48'], 1],
  ['Compute: 2³ × 3² − 5².', ['27', '29', '31', '34'], 0],
  ['A rectangle is 12 cm long and 8 cm wide. What is its perimeter?', ['20 cm', '32 cm', '40 cm', '48 cm'], 2],
  ['If 3 pens cost ₹54, how much do 7 pens cost?', ['₹108', '₹126', '₹132', '₹140'], 1],
  ['The average of five numbers is 18. Four of them are 12, 20, 15 and 23. The fifth is:', ['18', '19', '20', '21'], 2],
  ['What is 3/8 expressed as a percentage?', ['32.5%', '37.5%', '38.5%', '42.5%'], 1],
  ['A quantity increases by 20% and then decreases by 20%. The net change is:', ['No change', '2% decrease', '4% decrease', '4% increase'], 2],
  ['How many minutes are there between 09:47 and 13:12?', ['205', '195', '215', '225'], 1],
  ['Find the area of a triangle with base 14 cm and height 9 cm.', ['46.5 cm²', '63 cm²', '126 cm²', '252 cm²'], 1],
  ['If the probability of rain is 0.3, what is the probability of no rain?', ['0.03', '0.7', '0.77', '3.0'], 1],
  ['A car uses 7 litres per 100 km. How many litres for 350 km?', ['21', '24.5', '25', '28'], 1],
];

const CLERICAL: ChoiceItem[] = [
  ['A bill reads 1,4,0,0. Which of these is the correct amount in words?', ['One thousand four hundred', 'Fourteen hundred', 'One lakh forty', 'Forty thousand'], 0],
  ['Which number is written correctly?', ['5,20,300', '5,20,300 — no, it should be 5,20,300', '520,300', '52,300'], 2],
  [
    'You must file these by 5 pm: Raman 4 Mar, Sana 4 Mar, Leela 4 April, Raju 4 Feb. Who is out of order?',
    ['Raman', 'Sana', 'Leela', 'Raju'],
    2,
  ],
  ['Which set is in correct ascending order?', ['1.2, 0.9, 1.02', '0.9, 1.02, 1.2', '1.02, 1.2, 0.9', '1.2, 1.02, 0.9'], 1],
  [
    'An inventory lists: 12 chairs, 15 desks, 11 chairs, 14 desks. Total chairs?',
    ['22', '23', '26', '29'],
    2,
  ],
  ['You spot one error in a column of figures. Which detail is least likely to be the cause?', ['A digit transposed', 'A missing decimal point', 'A digit read upside down', 'A wrong currency printed'], 3],
  [
    'Codes: P-14, P-15, P-16. Which is the odd one?',
    ['P-14', 'P-15', 'P-16', 'All follow the pattern'],
    3,
  ],
  ['Which pair of quantities is closest?', ['1.09 vs 1.1', '1.09 vs 1.11', '1.09 vs 1.19', '1.09 vs 1.9'], 0],
  [
    'A ledger shows a debit of 4,500 but the bill was 4,050. This is most likely:',
    ['A transposition error', 'A rounding error', 'A missing entry', 'A deliberate change'],
    0,
  ],
  ['Which is the correct time: 13:45 in a 24-hour clock?', ['1:45 am', '1:45 pm', '3:45 am', '3:45 pm'], 1],
  [
    'You must record the readings: 41, 43, 42, 45, 44. Which is missing?',
    ['41', '43', '44', '45'],
    1,
  ],
  ['Which list contains no duplicate?', ['M, A, R, A', 'S, E, E, K', 'P, Q, R, S', 'T, A, T, A'], 2],
  ['If a form asks for the "middle" of three numbers 7, 12 and 19, you should write:', ['7', '12', '19', 'None'], 1],
];

const SPATIAL: ChoiceItem[] = [
  [
    'You are facing north. You turn 90° to your right, then 180°. Which way do you now face?',
    ['North', 'East', 'South', 'West'],
    2,
  ],
  [
    'A cube is painted on all six faces. One corner is cut off. How many faces does the remaining solid have?',
    ['6', '7', '8', '5'],
    1,
  ],
  [
    'A flat square sheet is folded in half once. How many layers do you now see?',
    ['1', '2', '3', '4'],
    1,
  ],
  [
    'Two identical cubes are placed side by side. How many faces of the combined shape are visible from the front, top and side?',
    ['6', '8', '9', '10'],
    2,
  ],
  [
    'A wire is bent into a cube. How many edges does the cube have?',
    ['8', '10', '12', '14'],
    2,
  ],
  [
    'You unfold a paper cube flat. Which of these CANNOT be the resulting net?',
    ['A cross of six squares', 'A row of four with one above and one below', 'A diagonal staircase of six', 'A row of three with three above'],
    3,
  ],
  [
    'A wheel rotates half a turn. How many degrees is that?',
    ['90°', '180°', '270°', '360°'],
    1,
  ],
  [
    'Looking at a clock face, the hour hand moves from 3 to 9. Through which number does it pass?',
    ['12', '6', '1', '11'],
    1,
  ],
  [
    'A solid cylinder is cut horizontally into two equal cylinders. How many new circular faces appear?',
    ['0', '1', '2', '4'],
    2,
  ],
  [
    'Three mirrors meet at a corner at 90° each. A ray of light hits the corner. How many times is it reflected before escaping?',
    ['1', '2', '3', '4'],
    2,
  ],
  [
    'A cone is placed upside down on a flat table. Which shape does its shadow resemble?',
    ['Circle', 'Triangle', 'Rectangle', 'Star'],
    1,
  ],
  [
    'You view a transparent cube from a corner. How many faces can you see at once?',
    ['1', '2', '3', '4'],
    2,
  ],
  [
    'A staircase climbs 12 steps of equal height. How many vertical faces does it have, counting the sides?',
    ['11', '12', '13', '14'],
    1,
  ],
];

const REASONING: ChoiceItem[] = [
  ['Find the odd one out: 3, 5, 11, 17, 21, 27.', ['21', '27', '17', '3'], 1],
  ['Complete the series: 4, 8, 16, 32, ___', ['48', '64', '60', '96'], 1],
  ['All cats are mammals. All mammals breathe. Therefore cats:', ['Sleep', 'Breathe', 'Have fur', 'Run'], 1],
  [
    'A is taller than B. B is taller than C. Who is shortest?',
    ['A', 'B', 'C', 'Cannot tell'],
    2,
  ],
  [
    'If the pattern is "day : night :: summer : ___", the blank is:',
    ['hot', 'winter', 'rain', 'day'],
    1,
  ],
  ['Which number replaces the question mark: 2, 6, 12, 20, ?', ['26', '28', '30', '32'], 2],
  [
    'Some flowers fade quickly. All roses are flowers. Which must be true?',
    ['All roses fade quickly', 'Some roses fade quickly', 'No roses fade quickly', 'Roses are not flowers'],
    1,
  ],
  [
    'A statement and its conclusion: "Every practice match helps. The team won the final. Therefore practice helped them win." The flaw is:',
    ['The conclusion may be true but does not follow', 'The statement is false', 'The conclusion is circular', 'No flaw'],
    0,
  ],
  ['Complete: 1, 1, 2, 3, 5, ___', ['6', '7', '8', '9'], 2],
  [
    'Assuming all oranges are fruits and no fruits are vegetables, which is impossible?',
    ['An orange is a fruit', 'A fruit is an orange', 'An orange is not a vegetable', 'A vegetable is not a fruit'],
    1,
  ],
  ['Which does not belong: square, rectangle, rhombus, circle?', ['Square', 'Rectangle', 'Rhombus', 'Circle'], 3],
  [
    'If today is Wednesday, what day will it be in 100 days?',
    ['Friday', 'Saturday', 'Thursday', 'Monday'],
    0,
  ],
  [
    'Pattern: the first letter of each word is also the last letter of the previous word: "Sin-ce __". The word is:',
    ['Tiger', 'Even', 'Rain', 'Ocean'],
    1,
  ],
  ['Which is the next logical step? All cats have tails. Some animals have tails.', ['All tails have animals', 'Some cats are animals', 'Some animals have tails', 'No cats are animals'], 2],
  ['Find the pattern: 2, 6, 12, 20, 30, ___', ['36', '40', '42', '44'], 2],
  [
    'A box of 12 pens is shared equally among 4 children. Each gets:',
    ['2 pens', '3 pens', '4 pens', '6 pens'],
    1,
  ],
  [
    'Which conclusion follows: "No cats are dogs. Some animals are cats."',
    ['Some animals are dogs', 'Some cats are not dogs', 'No animals are dogs', 'All animals are cats'],
    1,
  ],
];

const APTITUDE_BY_DIMENSION: Record<string, ChoiceItem[]> = {
  verbal: VERBAL,
  numerical: NUMERICAL,
  clerical: CLERICAL,
  spatial: SPATIAL,
  reasoning: REASONING,
};

/* ========================================================================== */
/* INTEREST (5-point self-report)                                             */
/* ========================================================================== */

const RIASEC_R: LikertItem[] = [
  ['I would rather build or repair something than talk about it.'],
  ['Using tools or equipment makes me lose track of time.'],
  ['I enjoy activities where I can see a physical result at the end.'],
  ['I would choose a practical apprenticeship over a desk-based course.', 'For example, an ITI, workshop, or on-the-job training route.'],
  ['I like puzzles that involve assembling or taking things apart.'],
  ['Instructions that tell me exactly how to do something step by step appeal to me.'],
  ['I would enjoy learning to work with machinery or electronics.'],
  ['I prefer jobs where I am outdoors or working with my hands.'],
  ['I like the idea of training for a specific trade and then being paid for it.'],
  ['I enjoy making something physical rather than writing about it.'],
  ['Fixing something that has stopped working gives me more satisfaction than explaining it.'],
  ['I would rather study how something works on paper than put it together myself.', 'Disagreeing here points towards practical, hands-on work.'],
];

const RIASEC_I: LikertItem[] = [
  ['I want to know why something happens, not just that it does.'],
  ['I enjoy experiments where the result is not what I expected.'],
  ['I like reading about how things work, even when it is difficult.'],
  ['I would rather investigate a problem for a week than accept an easy explanation.'],
  ['Comparing two theories and deciding which is better supported appeals to me.'],
  ['I enjoy questions that have no obvious answer.'],
  ['I find data and statistics genuinely interesting.'],
  ['I like to check whether a claim can be verified.'],
  ['Researching a topic for hours appeals to me more than summarising it in ten minutes.'],
  ['I ask "what would happen if" more often than most people.'],
  ['I would like to work somewhere that values evidence over opinion.'],
  ['I lose interest as soon as a problem turns out to have no clear answer.', 'Disagreeing here points towards investigative, open-ended work.'],
];

const RIASEC_A: LikertItem[] = [
  ['Writing or telling a story is one of the things I enjoy most.'],
  ['I notice design and presentation details that others miss.'],
  ['I would rather express an idea in an original way than follow a template.'],
  ['Music, art or performance plays a real part in my life.', 'A second instrument, singing, drawing, theatre, or writing of any kind counts.'],
  ['I enjoy tasks with no single correct answer.'],
  ['I have made things for the sake of making them, with no grade attached.'],
  ['I like imagining how something could be different or better.'],
  ['I would choose a creative subject as an elective if it were available.'],
  ['I am drawn to work that involves visual or dramatic presentation.'],
  ['I keep notes, journals or sketches of my own ideas.'],
  ['Art and music at school are among the subjects I look forward to.'],
  ['I prefer a project where I decide what it should look like.'],
  ['Being given strict rules for what to make feels restrictive rather than helpful.', 'Disagreeing here points towards creative, self-directed work.'],
];

const RIASEC_S: LikertItem[] = [
  ['I notice when someone in my group is upset, before they say anything.'],
  ['Helping a classmate understand something difficult feels rewarding.'],
  ['I am comfortable talking to people I have just met.'],
  ['I would enjoy work where the main purpose is to support other people.'],
  ['I like explaining things to younger students.'],
  ['I feel comfortable listening to someone who is upset without interrupting.'],
  ['Working in a team comes more naturally to me than working alone on a task.'],
  ['I would consider teaching, counselling, nursing or social work as a direction.'],
  ['I enjoy the moment when a shy person starts talking because of something I did.'],
  ['I am the one friends usually come to with a problem.'],
  ['Volunteering or helping at a community event appeals to me.'],
  ['I find it easy to put myself in someone else’s position.'],
  ['Working closely with other people all day drains me rather than energises me.', 'Disagreeing here points towards work that involves helping and supporting people.'],
];

const RIASEC_E: LikertItem[] = [
  ['I am comfortable speaking in front of a group.'],
  ['When a task has no clear leader, I usually end up organising it.'],
  ['I enjoy convincing someone to see a different point of view.'],
  ['I like being responsible for a decision that others depend on.'],
  ['I would like to run a small business, event or project one day.'],
  ['I stay calm when plans go wrong and others are panicking.'],
  ['I enjoy debating, even when I do not win.'],
  ['I like introducing two people who would work well together.'],
  ['I would rather lead a project than be assigned a section of it.'],
  ['Selling or presenting an idea to a new audience is something I would enjoy.'],
  ['I notice quickly when a group is drifting and nobody has taken charge.'],
  ['I enjoy negotiating for something I believe in.'],
  ['I am comfortable taking responsibility if something goes wrong.'],
  ['Leading a team activity appeals to me more than following one.'],
  ['I would rather stay in the background than be the one people turn to.', 'Disagreeing here points towards work involving leadership and persuasion.'],
];

const RIASEC_C: LikertItem[] = [
  ['I keep my desk, notes and belongings neatly organised.'],
  ['I prefer instructions that are clear and in a fixed order.'],
  ['I check my work twice even when I am fairly confident.'],
  ['I enjoy tasks where there is a clearly correct answer.'],
  ['Finishing a checklist completely gives me satisfaction.'],
  ['I dislike work that constantly changes from one minute to the next.'],
  ['I keep records of things, even when nobody asks me to.'],
  ['I am comfortable repeating a procedure accurately many times.'],
  ['I plan my week at the start rather than reacting to it.'],
  ['I would rather follow a proven method than invent my own.'],
  ['I notice when figures in a list do not follow the expected pattern.'],
  ['I prefer to submit work early rather than at the deadline.'],
  ['I enjoy filing, sorting or categorising things.'],
  ['I am more comfortable with a set procedure than with improvising.'],
  ['I re-read instructions twice to make sure I have not missed a step.'],
  ['A predictable, repetitive routine quickly becomes unbearable to me.', 'Disagreeing here points towards work that suits organised and detail-focused people.'],
];

const INTEREST_BY_DIMENSION: Record<string, LikertItem[]> = {
  riasec_r: RIASEC_R,
  riasec_i: RIASEC_I,
  riasec_a: RIASEC_A,
  riasec_s: RIASEC_S,
  riasec_e: RIASEC_E,
  riasec_c: RIASEC_C,
};

/* ========================================================================== */
/* Reverse-scored items                                                       */
/* ========================================================================== */
/*
 * Only items that are worded in the OPPOSITE direction to their dimension may be
 * listed here. An earlier version of this file marked three positively-worded
 * statements, which meant a student who agreed with "I am comfortable repeating
 * a procedure accurately many times" had their Conventional score reduced. That
 * is worse than useless: it rewards disagreeing with something plainly true.
 *
 * Each entry below is phrased so that strong agreement means a LOW score on its
 * dimension, and the integrity check at the bottom of this file enforces that a
 * reverse key refers to a real likert item.
 */

const REVERSE_KEYS = new Set([
  'riasec_c:16', // dislikes routine and repetition
  'riasec_e:15', // avoids taking the lead
  'riasec_a:13', // prefers strict rules to self-expression
  'riasec_s:13', // avoids close cooperation
  'riasec_r:12', // prefers theory to practice
  'riasec_i:12', // avoids questions without an answer
]);

/* ========================================================================== */

function buildChoice(
  key: string,
  dimension: string,
  item: ChoiceItem,
): SeedQuestion {
  const [prompt, options, correct] = item;
  const correctIndexes = Array.isArray(correct) ? correct : [correct];
  return {
    key,
    dimension,
    type: correctIndexes.length > 1 ? 'multi_select' : 'single_choice',
    prompt,
    helpText: null,
    reverseScored: false,
    options,
    correct: correctIndexes,
  };
}

function buildLikert(key: string, dimension: string, item: LikertItem): SeedQuestion {
  const [prompt, helpText] = item;
  return {
    key,
    dimension,
    type: 'likert',
    prompt,
    helpText: helpText ?? null,
    reverseScored: REVERSE_KEYS.has(key),
    options: [],
    correct: [],
  };
}

export function buildStreamSelectorQuestions(): SeedQuestion[] {
  const out: SeedQuestion[] = [];

  for (const [dimension, items] of Object.entries(APTITUDE_BY_DIMENSION)) {
    items.forEach((item, i) => out.push(buildChoice(`${dimension}:${i + 1}`, dimension, item)));
  }
  for (const [dimension, items] of Object.entries(INTEREST_BY_DIMENSION)) {
    items.forEach((item, i) => out.push(buildLikert(`${dimension}:${i + 1}`, dimension, item)));
  }

  return out;
}

/**
 * 150 is the required floor for this assessment. The bank carries six extra
 * items because the reverse-scored block needs genuinely negatively-worded
 * questions, and padding with positive items marked as reversed would corrupt
 * the affected dimensions.
 */
export const EXPECTED_QUESTION_COUNT = 156;

/** Fails loudly if the bank drifts from the published question count. */
export function assertBankIntegrity(): void {
  const questions = buildStreamSelectorQuestions();

  if (questions.length !== EXPECTED_QUESTION_COUNT) {
    throw new Error(
      `Stream Selector bank has ${questions.length} questions, expected ${EXPECTED_QUESTION_COUNT}`,
    );
  }

  const keys = new Set<string>();
  const prompts = new Map<string, string>();
  for (const q of questions) {
    if (keys.has(q.key)) throw new Error(`Duplicate question key: ${q.key}`);
    keys.add(q.key);

    const normalised = q.prompt.trim().toLowerCase().replace(/\s+/g, ' ');
    const existing = prompts.get(normalised);
    if (existing) {
      throw new Error(`Duplicate prompt "${q.prompt}" (${existing} and ${q.key})`);
    }
    prompts.set(normalised, q.key);

    if (q.options.length > 0) {
      if (q.correct.length === 0) throw new Error(`Item ${q.key} has no answer key`);
      for (const c of q.correct) {
        if (c < 0 || c >= q.options.length) throw new Error(`Item ${q.key} has an out-of-range answer key`);
      }
      const labels = new Set(q.options.map((o) => o.trim().toLowerCase()));
      if (labels.size !== q.options.length) throw new Error(`Item ${q.key} has duplicate options`);
    }

    if (q.type === 'likert' && q.options.length > 0) {
      throw new Error(`Likert item ${q.key} must not define its own options`);
    }
  }

  // A reverse key that points at nothing (or at a choice item) would silently
  // leave an item unreversed, so it is treated as an authoring error.
  for (const key of REVERSE_KEYS) {
    const question = questions.find((q) => q.key === key);
    if (!question) throw new Error(`REVERSE_KEYS references unknown item: ${key}`);
    if (question.type !== 'likert') {
      throw new Error(`REVERSE_KEYS item ${key} is a ${question.type}; only likert items can be reversed`);
    }
  }

  // And a reverse item must actually be worded against its own dimension.
  // These markers are what make that checkable rather than a matter of opinion.
  const NEGATIVE_MARKERS =
    /\b(dislike|drains me|unbearable|rather stay in the background|rather study|lose(s)? interest|feels restrictive)\b/i;
  for (const question of questions) {
    if (question.reverseScored && !NEGATIVE_MARKERS.test(question.prompt)) {
      throw new Error(
        `Item ${question.key} is marked reverse-scored but is not worded against its dimension. ` +
          `Reversing a positively-worded item makes agreeing lower the score.`,
      );
    }
  }
}
