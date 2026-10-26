/**
 * Stream Selector content: dimensions, weighted stream profiles, and the
 * narrative guidance attached to each stream.
 *
 * The weights are the matching model and are deliberately data rather than code.
 * A counsellor can retune them in the database without a deploy, and the
 * generated rationale always names the weights that produced the score.
 *
 * Weighting note: aptitude dimensions carry more total weight than interest
 * dimensions for every stream. That encodes a deliberate view — subject choice
 * is constrained harder by what a student can sustain than by what they enjoy —
 * but it is a policy choice, not a finding, and it is meant to be reviewed.
 */
import type { Dimension } from '@/lib/domain/types';
import type { StreamContent } from '@/lib/scoring/interpret';

export const STREAM_SELECTOR_SLUG = 'stream-selector';

export const DIMENSIONS: Dimension[] = [
  {
    key: 'verbal',
    label: 'Verbal Aptitude',
    kind: 'aptitude',
    description:
      'Working with written information: understanding what you read, following an argument, and choosing the precise word for a precise idea.',
    weight: 1,
  },
  {
    key: 'numerical',
    label: 'Numerical Aptitude',
    kind: 'aptitude',
    description:
      'Working with numbers, quantities and relationships, and staying accurate through a multi-step calculation.',
    weight: 1,
  },
  {
    key: 'clerical',
    label: 'Clerical Accuracy',
    kind: 'aptitude',
    description:
      'Noticing small discrepancies. Comparing records, spotting a transposed digit, catching an entry that does not fit.',
    weight: 1,
  },
  {
    key: 'spatial',
    label: 'Spatial Aptitude',
    kind: 'aptitude',
    description:
      'Understanding how shapes and objects relate when you rotate them, unfold them, or view them from a different angle.',
    weight: 1,
  },
  {
    key: 'reasoning',
    label: 'Logical & Abstract Reasoning',
    kind: 'aptitude',
    description:
      'Finding the rule that governs a sequence or pattern, and applying it to something you have not seen before.',
    weight: 1,
  },
  {
    key: 'riasec_r',
    label: 'Hands-On & Practical',
    kind: 'interest',
    description:
      'Preference for working with tools, materials, machines or plants, and for seeing a physical result.',
    weight: 1,
  },
  {
    key: 'riasec_i',
    label: 'Analytical & Investigative',
    kind: 'interest',
    description:
      'Preference for analysing, researching, and working out why something happens.',
    weight: 1,
  },
  {
    key: 'riasec_a',
    label: 'Creative & Expressive',
    kind: 'interest',
    description:
      'Preference for original work, design, storytelling, music or visual expression.',
    weight: 1,
  },
  {
    key: 'riasec_s',
    label: 'Helping & Supporting',
    kind: 'interest',
    description:
      'Preference for work that involves teaching, caring for, counselling, or serving other people.',
    weight: 1,
  },
  {
    key: 'riasec_e',
    label: 'Leading & Persuading',
    kind: 'interest',
    description:
      'Preference for organising people towards a goal, persuading, negotiating, or persuading others of a plan.',
    weight: 1,
  },
  {
    key: 'riasec_c',
    label: 'Organised & Detail-Focused',
    kind: 'interest',
    description:
      'Preference for clear rules, ordered steps, working to a specification, and tasks that have an objectively correct answer.',
    weight: 1,
  },
];

export const STREAM_PROFILES = [
  {
    key: 'science',
    label: 'Science (PCMB)',
    dimensionWeights: {
      numerical: 1.0,
      reasoning: 0.9,
      spatial: 0.65,
      verbal: 0.5,
      riasec_i: 0.6,
      riasec_r: 0.35,
      riasec_c: 0.3,
      riasec_e: 0.15,
      riasec_a: 0.15,
      riasec_s: 0.2,
      clerical: 0.15,
    },
  },
  {
    key: 'commerce',
    label: 'Commerce',
    dimensionWeights: {
      clerical: 0.95,
      riasec_c: 0.9,
      numerical: 0.8,
      riasec_e: 0.7,
      reasoning: 0.6,
      verbal: 0.6,
      riasec_i: 0.3,
      riasec_s: 0.5,
      spatial: 0.3,
      riasec_r: 0.2,
      riasec_a: 0.2,
    },
  },
  {
    key: 'arts',
    label: 'Arts and Humanities',
    dimensionWeights: {
      verbal: 1.0,
      riasec_a: 0.95,
      riasec_s: 0.65,
      reasoning: 0.45,
      riasec_i: 0.45,
      spatial: 0.4,
      riasec_e: 0.35,
      riasec_c: 0.3,
      numerical: 0.2,
      riasec_r: 0.3,
      clerical: 0.2,
    },
  },
  {
    key: 'vocational',
    label: 'Vocational and Skill-Based',
    dimensionWeights: {
      riasec_r: 1.0,
      spatial: 0.85,
      clerical: 0.65,
      reasoning: 0.55,
      riasec_c: 0.5,
      numerical: 0.45,
      riasec_e: 0.4,
      riasec_s: 0.4,
      verbal: 0.4,
      riasec_i: 0.3,
      riasec_a: 0.3,
    },
  },
] as const;

export const STREAM_CONTENT: Record<string, StreamContent> = {
  science: {
    key: 'science',
    label: 'Science (PCMB)',
    subjects: [
      'Physics (movement, forces, electricity)',
      'Chemistry (reactions, bonding, quantitative analysis)',
      'Mathematics or Applied Mathematics (functions, algebra, probability)',
      'Biology (systems, genetics, ecology)',
    ],
    activities: [
      'Run the numbers on a science problem without a calculator first, then check whether you were right or merely lucky.',
      'Build something small that demonstrates a physical principle — a simple circuit, a bridge from ice-cream sticks, a working model of a planetary orbit.',
      'Set up a fair test at home: change one variable, measure carefully, and write down what went wrong as well as what worked.',
    ],
    pathways: [
      'Engineering, medicine, or pure and applied sciences after the 12th standard or its equivalent.',
      'Allied health and technology degrees where biology and chemistry carry the entry criteria.',
      'Data, computing, and quantitative roles that build on mathematics and physics rather than on laboratory work.',
    ],
    rationale: {
      numerical:
        'Physics, chemistry and applied mathematics all run on sustained quantitative work. A strong numerical profile is the single most reliable predictor that the demanding parts of this stream will feel manageable to you.',
      reasoning:
        'Almost every problem in physics and chemistry asks you to infer the rule before you can apply it. Reasoning is the skill doing the work even when the arithmetic is easy.',
      spatial:
        'Structural and electronics problems are largely visual, and exam questions in all three sciences assume you can hold a three-dimensional situation in your head.',
      verbal:
        'Science writing is a real and heavily marked component: reading a question precisely, stating assumptions, and explaining your reasoning without over-claiming.',
    },
  },
  commerce: {
    key: 'commerce',
    label: 'Commerce',
    subjects: [
      'Accountancy (double entry, balance sheets, the interpretation of accounts)',
      'Business Studies (organisation, marketing, finance, operations)',
      'Economics (markets, national income, monetary policy)',
      'Applied Mathematics or Mathematics, and often a computer-science elective',
    ],
    activities: [
      'Keep a real budget for one month of your own spending and compare it with what you thought it would be. The gap is the lesson.',
      'Take a small company’s annual results — available from any listed Indian firm — and work out what changed and why.',
      'Build a simple spreadsheet model where changing one input changes an outcome. Watch for the point where it stops making sense.',
    ],
    pathways: [
      'BCom or BCom (Hons), usually with a practical accounting or finance specialisation.',
      'Chartered accountancy or cost accountancy, which build directly on accountancy and require substantial additional exam work.',
      'BBA, management degrees, or a commerce foundation for economics, banking, and business analytics roles.',
    ],
    rationale: {
      clerical:
        'Accountancy is a profession of exact reconciliation. Ledger work, stock reconciliation and tax filing all depend on noticing a discrepancy that others walked past.',
      'conventional':
        'Commerce is full of defined rules, prescribed formats and procedures. Working comfortably inside a specification is the job, not a limitation in it.',
      numerical:
        'Interest calculations, ratios, compounding and statistical interpretation make up a large share of the syllabus and of entry-level work.',
      riasec_e:
        'Sales, trading, management and entrepreneurship sit inside commerce, not beside it. This dimension tells us whether the commercial side appeals to you.',
    },
  },
  arts: {
    key: 'arts',
    label: 'Arts and Humanities',
    subjects: [
      'English Literature and/or a second language literature',
      'History and Political Science or Sociology',
      'Psychology, Philosophy or Economics depending on the combination you choose',
      'A creative or practical subject: fine art, music, design, theatre, or a media elective',
    ],
    activities: [
      'Write a piece of non-fiction arguing something you actually think, with three sources, in under eight hundred words.',
      'Interview an older relative about something that happened before you were born and write it up as a reported piece.',
      'Take a subject you are not good at and find one question inside it that genuinely interests you. Then follow that question.',
    ],
    pathways: [
      'BA degrees in English, History, Psychology, Sociology, Economics, or Political Science.',
      'LLB, or a BA with an accompanying law qualification, for legal practice.',
      'Journalism, mass communication, design, and liberal-arts professional programmes.',
    ],
    rationale: {
      verbal:
        'The humanities run on reading closely, arguing a position, and expressing it in writing under length limits. This is a working skill in this stream, not a soft extra.',
      'riasec_a':
        'A substantial part of what makes humanities worth studying is original work: an essay, an analysis, a design, a performance. A strong creative disposition predicts how you will engage with it.',
      'riasec_s':
        'Teaching, law, social work, journalism and counselling all sit inside this stream and are built around working with other people.',
      reasoning:
        'Historical and social reasoning — weighing competing explanations for the same event — is the analytical core of the subject, and it is a skill rather than a topic.',
    },
  },
  vocational: {
    key: 'vocational',
    label: 'Vocational and Skill-Based',
    subjects: [
      'Mathematics and a science, at the level your chosen trade requires',
      'A trade-specific theory paper (workshop technology, IT fundamentals, electrical principles, design, or equivalent)',
      'Practical or workshop sessions, which carry substantial weight',
      'English and one other language, usually to a lower weighting than in academic streams',
    ],
    activities: [
      'Commit to one practical skill for a full term — a trade, a code language, a repair discipline, a design tool — and finish something you can show someone.',
      'Measure something real to a tenth of a millimetre, twice, and write down where the two attempts disagreed.',
      'Find out what the qualification you are considering actually certifies you to do, and who is legally allowed to hire on the strength of it.',
    ],
    pathways: [
      'ITI and diploma programmes in technical trades, followed by apprenticeship or direct industry entry.',
      'Polytechnic diplomas in engineering technology, with lateral entry to engineering degrees where available.',
      'Certification tracks in IT, design software, automotive, electrical, or skilled services, often built alongside a diploma.',
    ],
    rationale: {
      riasec_r:
        'Skilled trades reward sustained practical interest. If you find the workshop, the bench, or the screen satisfying before anyone grades you, that is a meaningful signal here.',
      spatial:
        'Technical work involves reading drawings, understanding assemblies, and picturing how components fit — often under time pressure, where visualisation is the shortcut.',
      clerical:
        'Precision work is unforgiving of small errors. Measurement, tolerance, and correct procedure matter as much as creativity.',
      reasoning:
        'Diagnosis is the core technical skill: working out why a device is not behaving as expected from the evidence available.',
    },
  },
};

/** Human-readable labels for the report's score table. */
export const DIMENSION_LABEL_BY_KEY = new Map(DIMENSIONS.map((d) => [d.key, d.label]));
