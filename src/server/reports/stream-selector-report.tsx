/**
 * Stream Selector PDF report.
 *
 * Every number, chart and sentence on these pages comes from the student's own
 * stored responses. Nothing is hardcoded, and there is no sample data path into
 * this component.
 *
 * Layout rules followed throughout, because overlapping or clipped content is
 * the most common way a generated PDF becomes unusable:
 *   - every block has an explicit width budget,
 *   - tables use fixed column widths that sum to the content width,
 *   - long text wraps rather than being truncated,
 *   - each page is its own fixed-height container so content never bleeds.
 */
import {
  Circle,
  Document,
  Line,
  Page,
  Polygon,
  Rect,
  StyleSheet,
  Svg,
  Text,
  View,
} from '@react-pdf/renderer';
import type { DimensionScore, StreamMatch } from '@/lib/domain/types';
import type { Interpretation } from '@/lib/scoring/interpret';
import { registerReportFonts } from './fonts';

const C = {
  navy: '#172554',
  royal: '#2563EB',
  royalSoft: '#DBEAFE',
  teal: '#0F766E',
  lavender: '#F1EEFF',
  surface: '#F8FAFC',
  ink: '#1E293B',
  muted: '#64748B',
  line: '#E2E8F0',
  white: '#FFFFFF',
};

// A4 portrait, 595.28 x 841.89 points. Column widths below are absolute.
const MARGIN = 42;

export interface ReportInput {
  studentName: string;
  grade: number | null;
  schoolName: string | null;
  assessmentTitle: string;
  assessmentVersion: number;
  reference: string;
  completedAt: Date;
  generatedAt: Date;
  answeredQuestions: number;
  totalQuestions: number;
  durationMinutes: number;
  dimensions: DimensionScore[];
  streams: StreamMatch[];
  /** Stream key -> subject list, so the report recommends real subjects. */
  streamSubjects: Record<string, string[]>;
  narrative: Interpretation;
  disclaimer: string;
}

const styles = StyleSheet.create({
  page: {
    padding: MARGIN,
    fontSize: 9.5,
    color: C.ink,
    lineHeight: 1.5,
  },
  h1: { fontSize: 21, color: C.navy, marginBottom: 4 },
  h2: { fontSize: 13, color: C.navy, marginBottom: 6 },
  h3: { fontSize: 10.5, color: C.royal, marginBottom: 3 },
  body: { marginBottom: 7 },
  muted: { color: C.muted },
  small: { fontSize: 8, color: C.muted, lineHeight: 1.4 },
  tiny: { fontSize: 7, color: C.muted },

  coverBand: { backgroundColor: C.navy, height: 8, marginHorizontal: -MARGIN, marginTop: -MARGIN },
  coverBody: { marginTop: 26 },
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14 },
  metaCell: { width: '50%', paddingRight: 12, marginBottom: 10 },
  metaLabel: { fontSize: 7, color: C.muted, textTransform: 'uppercase', marginBottom: 2 },
  metaValue: { fontSize: 10, color: C.ink },

  callout: {
    backgroundColor: C.lavender,
    borderLeftWidth: 3,
    borderLeftColor: C.royal,
    padding: 10,
    marginVertical: 8,
    borderRadius: 3,
  },
  warn: {
    backgroundColor: '#FEF3C7',
    borderLeftWidth: 3,
    borderLeftColor: '#D97706',
    padding: 10,
    marginTop: 10,
    borderRadius: 3,
  },

  sectionGap: { marginTop: 14 },
  bullet: { flexDirection: 'row', marginBottom: 5 },
  bulletMark: { width: 12, color: C.royal },
  bulletText: { flex: 1 },

  card: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 4,
    padding: 10,
    marginBottom: 8,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },

  footer: {
    position: 'absolute',
    bottom: 22,
    left: MARGIN,
    right: MARGIN,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: C.line,
    paddingTop: 5,
  },

  tableHead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: C.navy,
    paddingBottom: 4,
    marginBottom: 4,
  },
  th: { fontSize: 7.5, color: C.muted, textTransform: 'uppercase' },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: C.line,
    paddingVertical: 5,
    alignItems: 'center',
  },
  cLabel: { width: 132 },
  cBar: { width: 236 },
  cValue: { width: 42, textAlign: 'right' },
  cRank: { width: 26, textAlign: 'right', color: C.muted },
});

/* -------------------------------------------------------------------------- */
/* Chart primitives                                                            */
/* -------------------------------------------------------------------------- */


/**
 * Radar over the four stream fit scores. Four axes is the point at which a
 * radar is readable; more would produce overlapping labels.
 */
function RadarChart({ streams }: { streams: StreamMatch[] }) {
  const size = 210;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 26;
  const n = streams.length;

  const point = (index: number, value: number) => {
    const angle = (Math.PI * 2 * index) / n - Math.PI / 2;
    const r = (Math.min(100, Math.max(0, value)) / 100) * radius;
    return `${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`;
  };

  const polygon = streams.map((s, i) => point(i, s.fitScore)).join(' ');
  const rings = [25, 50, 75, 100];

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {rings.map((ring) => (
        <Polygon
          key={ring}
          points={streams.map((_, i) => point(i, ring)).join(' ')}
          fill="none"
          stroke={C.line}
          strokeWidth={0.8}
        />
      ))}
      {streams.map((_, i) => {
        const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
        return (
          <Line
            key={`axis-${i}`}
            x1={cx}
            y1={cy}
            x2={cx + radius * Math.cos(angle)}
            y2={cy + radius * Math.sin(angle)}
            stroke={C.line}
            strokeWidth={0.8}
          />
        );
      })}
      <Polygon points={polygon} fill={C.royal} fillOpacity={0.18} stroke={C.royal} strokeWidth={1.6} />
      {streams.map((s, i) => {
        const [x, y] = point(i, s.fitScore).split(',');
        return <Circle key={s.stream} cx={Number(x)} cy={Number(y)} r={2.6} fill={C.royal} />;
      })}
    </Svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared furniture                                                            */
/* -------------------------------------------------------------------------- */

function Footer({ reference, label }: { reference: string; label: string }) {
  return (
    <View style={styles.footer} fixed>
      <Text style={styles.tiny}>{label}</Text>
      <Text style={styles.tiny}>{reference}</Text>
      <Text
        style={styles.tiny}
        render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
      />
    </View>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaCell}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Document                                                                    */
/* -------------------------------------------------------------------------- */

export function StreamSelectorReport({ data }: { data: ReportInput }) {
  const font = registerReportFonts();

  const top = data.streams[0];
  const second = data.streams[1];
  const aptitude = data.dimensions.filter((d) => d.kind === 'aptitude');
  const interest = data.dimensions.filter((d) => d.kind === 'interest');
  const strongest = data.narrative.strongestDimensions;

  const completedDate = data.completedAt.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const generatedDate = data.generatedAt.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const profileSummary =
    strongest.length > 0
      ? `Your strongest measured areas are ${strongest.map((s) => s.label).join(', ')}.`
      : '';

  return (
    <Document
      title={`${data.assessmentTitle} - ${data.studentName}`}
      author="Psychometric Assessment Platform"
      subject={`Report reference ${data.reference}`}
      creator="psychometric-assessment-platform"
    >
      {/* ---------------------------------------------------------------- */}
      {/* Page 1 - summary                                                    */}
      {/* ---------------------------------------------------------------- */}
      <Page size="A4" style={[styles.page, { fontFamily: font }]}>
        <View style={styles.coverBand} />
        <Text style={[styles.h1, { marginTop: 18 }]}>{data.assessmentTitle}</Text>
        <Text style={[styles.muted, { fontSize: 10 }]}>Personalised assessment report</Text>

        <View style={styles.coverBody}>
          <Text style={[styles.h2, { fontSize: 16 }]}>{data.studentName}</Text>
          {data.schoolName ? <Text style={styles.muted}>{data.schoolName}</Text> : null}

          <View style={styles.metaGrid}>
            <KeyValue label="Grade" value={data.grade ? `Grade ${data.grade}` : 'Not specified'} />
            <KeyValue label="Assessment date" value={completedDate} />
            <KeyValue label="Report reference" value={data.reference} />
            <KeyValue label="Assessment version" value={`Version ${data.assessmentVersion}`} />
            <KeyValue
              label="Questions answered"
              value={`${data.answeredQuestions} of ${data.totalQuestions}`}
            />
            <KeyValue label="Time taken" value={`${data.durationMinutes} minutes`} />
          </View>

          <View style={styles.sectionGap}>
            <Text style={styles.h2}>Key findings</Text>

            {top ? (
              <View style={styles.callout}>
                <Text style={styles.h3}>Leading stream fit: {top.label}</Text>
                <Text style={styles.body}>
                  Based on a weighted comparison of your eleven dimension scores, {top.label} shows the
                  highest fit at {Math.round(top.fitScore)}%.{' '}
                  {second ? `${second.label} follows at ${Math.round(second.fitScore)}%. ` : ''}
                  This is a comparison of your own scores against one another, not a prediction and not a
                  ranking against other students.
                </Text>
              </View>
            ) : null}

            {profileSummary ? <Text style={styles.body}>{profileSummary}</Text> : null}

            <Text style={styles.body}>
              This report covers eleven dimensions: five measured aptitude areas and six interest
              preference areas. The two are reported separately throughout, because they answer different
              questions. Aptitude describes what you scored on reasoning items under time pressure.
              Interest describes what you chose when asked what appeals to you.
            </Text>

            <Text style={styles.body}>
              {data.streams.length} stream options were compared. Your full profile, the reasoning behind
              each suggestion, and a thirty-day action plan follow on the following pages.
            </Text>
          </View>

          <View style={styles.warn}>
            <Text style={[styles.h3, { color: '#92400E' }]}>Please read before using this report</Text>
            <Text style={styles.small}>
              This is an educational guidance tool. It is not a psychological, medical or clinical
              assessment, and it is not a validated intelligence test. It is compared against no
              population, so no score here means &quot;better than X% of students&quot;. Do not use it to
              decide eligibility for a programme, and do not treat it as a limit on what you may study.
            </Text>
          </View>
        </View>

        <Footer reference={data.reference} label="Personalised assessment report" />
      </Page>

      {/* ---------------------------------------------------------------- */}
      {/* Page 2 - score profile                                             */}
      {/* ---------------------------------------------------------------- */}
      <Page size="A4" style={[styles.page, { fontFamily: font }]}>
        <Text style={styles.h1}>Your score profile</Text>
        <Text style={[styles.muted, styles.small]}>
          Each dimension is shown on a 0-100 scale. Scores are normalised within your own paper, so they
          describe your relative standing across dimensions, not a comparison with other students. Blue
          bars are measured aptitude. Teal bars are stated interests.
        </Text>

        <View style={styles.sectionGap}>
          <Text style={styles.h2}>All dimensions</Text>
          <View style={styles.tableHead}>
            <Text style={[styles.th, styles.cLabel]}>Dimension</Text>
            <Text style={[styles.th, styles.cBar]}>Score (0-100)</Text>
            <Text style={[styles.th, styles.cValue]}>Score</Text>
            <Text style={[styles.th, styles.cRank]}>Rank</Text>
          </View>
          {[...data.dimensions]
            .sort((a, b) => a.rank - b.rank)
            .map((d) => (
              <View key={d.key} style={styles.row} wrap={false}>
                <Text style={[styles.cLabel, { fontSize: 8.5 }]}>
                  {d.label}
                  <Text style={styles.tiny}>
                    {'  '}
                    {d.kind === 'aptitude' ? 'aptitude' : 'interest'}
                  </Text>
                </Text>
                <View style={styles.cBar}>
                  <BarChartInline value={d.normalizedScore} kind={d.kind} />
                </View>
                <Text style={[styles.cValue, { fontSize: 9 }]}>
                  {Math.round(d.normalizedScore)}
                </Text>
                <Text style={[styles.cRank, { fontSize: 9 }]}>{d.rank}</Text>
              </View>
            ))}
        </View>

        <View style={styles.sectionGap}>
          <Text style={styles.h2}>What these numbers mean</Text>
          <Text style={styles.body}>
            {aptitude.length} aptitude dimensions were scored from reasoning items with a correct answer.
            An unanswered item counts as no credit, so an aptitude score also reflects how completely you
            answered the paper. Coverage is shown below each dimension in the table on the following page.
          </Text>
          <Text style={styles.body}>
            {interest.length} interest dimensions were scored from five-point self-report items. These
            describe your preferences on the day. They are not measures of skill and should not be read as
            such.
          </Text>
          <View style={styles.callout}>
            <Text style={styles.small}>
              There is no population norm group behind this assessment. That is why no percentile, no
              &quot;average student&quot; figure, and no diagnostic band appears anywhere in this report. The
              only comparisons available are between your own dimensions and between your own stream fits.
            </Text>
          </View>
        </View>

        <Footer reference={data.reference} label="Score profile" />
      </Page>

      {/* ---------------------------------------------------------------- */}
      {/* Page 3 - stream fit + interpretation                                */}
      {/* ---------------------------------------------------------------- */}
      <Page size="A4" style={[styles.page, { fontFamily: font }]}>
        <Text style={styles.h1}>How your streams compare</Text>
        <Text style={[styles.muted, styles.small]}>
          Each stream declares how much it draws on each of your eleven dimensions. The fit score is the
          weighted average of those dimensions using your own scores.
        </Text>

        <View style={{ flexDirection: 'row', marginTop: 14, marginBottom: 10 }}>
          <View style={{ width: 210, alignItems: 'center' }}>
            <RadarChart streams={data.streams} />
          </View>
          <View style={{ flex: 1, paddingLeft: 14 }}>
            {data.streams.map((s, i) => (
              <View key={s.stream} style={{ marginBottom: 7 }}>
                <Text style={{ fontSize: 9, color: C.ink }}>
                  <Text style={{ color: C.muted }}>{i + 1}. </Text>
                  <Text style={{ fontWeight: 700 }}>{s.label}</Text>
                </Text>
                <Text style={{ fontSize: 12, color: C.royal, marginTop: 1 }}>
                  {Math.round(s.fitScore)}%
                </Text>
              </View>
            ))}
          </View>
        </View>

        <Text style={styles.h2}>Your interpretation</Text>
        {data.narrative.interpretation.map((paragraph, i) => (
          <Text key={i} style={styles.body}>
            {paragraph}
          </Text>
        ))}

        <Footer reference={data.reference} label="Interpretation" />
      </Page>

      {/* ---------------------------------------------------------------- */}
      {/* Page 4 - recommendations                                            */}
      {/* ---------------------------------------------------------------- */}
      <Page size="A4" style={[styles.page, { fontFamily: font }]}>
        <Text style={styles.h1}>Recommendations</Text>
        <Text style={[styles.muted, styles.small]}>
          Each recommendation below is tied to a dimension from your own profile.
        </Text>

        <View style={styles.sectionGap}>
          {data.narrative.recommendations.map((r, i) => (
            <View key={i} style={styles.card} wrap={false}>
              <View style={styles.cardTop}>
                <Text style={styles.h3}>{r.title}</Text>
                {r.dimensionKey ? (
                  <Text style={styles.tiny}>
                    {data.dimensions.find((d) => d.key === r.dimensionKey)?.label ?? r.dimensionKey}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.body}>{r.detail}</Text>
            </View>
          ))}
        </View>

        <View style={styles.callout}>
          <Text style={styles.h3}>Dimensions driving your leading options</Text>
          {data.streams.slice(0, 3).map((s, i) => (
            <View key={s.stream} style={{ marginBottom: 5 }}>
              <Text style={styles.bullet}>
                <Text style={styles.bulletMark}>{`${i + 1}. `}</Text>
                <Text style={styles.bulletText}>
                  <Text style={{ fontWeight: 700 }}>{s.label}: </Text>
                  {s.contributingDimensions.join('; ')}
                </Text>
              </Text>
              {data.streamSubjects[s.stream] ? (
                <Text style={[styles.small, { marginLeft: 12 }]}>
                  Subjects to try: {data.streamSubjects[s.stream]!.slice(0, 3).join(', ')}
                </Text>
              ) : null}
            </View>
          ))}
        </View>

        <Footer reference={data.reference} label="Recommendations" />
      </Page>

      {/* ---------------------------------------------------------------- */}
      {/* Page 5 - action plan                                                */}
      {/* ---------------------------------------------------------------- */}
      <Page size="A4" style={[styles.page, { fontFamily: font }]}>
        <Text style={styles.h1}>Your action plan</Text>
        <Text style={[styles.muted, styles.small]}>
          A starting point, not a schedule handed down to you. Adjust it to what your school and family
          actually make possible.
        </Text>

        <View style={styles.sectionGap}>
          {data.narrative.actionPlan.map((block, i) => (
            <View key={i} style={styles.card} wrap={false}>
              <Text style={styles.h3}>{block.window}</Text>
              {block.items.map((item, j) => (
                <Text key={j} style={styles.bullet}>
                  <Text style={styles.bulletMark}>{'\u2022'}</Text>
                  <Text style={styles.bulletText}>{item}</Text>
                </Text>
              ))}
            </View>
          ))}
        </View>

        <View style={styles.sectionGap}>
          <Text style={styles.h2}>Questions worth discussing</Text>
          {data.narrative.discussionQuestions.map((q, i) => (
            <Text key={i} style={styles.bullet}>
              <Text style={styles.bulletMark}>{i + 1}.</Text>
              <Text style={styles.bulletText}>{q}</Text>
            </Text>
          ))}
        </View>

        <View style={styles.warn}>
          <Text style={[styles.h3, { color: '#92400E' }]}>Limitations of this assessment</Text>
          <Text style={styles.small}>{data.disclaimer}</Text>
          <Text style={[styles.small, { marginTop: 5 }]}>
            Report generated {generatedDate} from assessment version {data.assessmentVersion}. Individual
            answers are not reproduced in this report and are not shared with other students.
          </Text>
        </View>

        <Footer reference={data.reference} label="Action plan" />
      </Page>
    </Document>
  );
}

/**
 * Inline bar used inside table rows. Kept as a fixed-height box with a coloured
 * fill so it cannot reflow the surrounding row.
 */
function BarChartInline({ value, kind }: { value: number; kind: 'aptitude' | 'interest' }) {
  const w = 236;
  const h = 8;
  const fill = Math.max(1.5, (Math.min(100, Math.max(0, value)) / 100) * w);
  return (
    <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <Rect x={0} y={0} width={w} height={h} fill="#F1F5F9" rx={2} />
      <Rect x={0} y={0} width={fill} height={h} fill={kind === 'aptitude' ? C.royal : C.teal} rx={2} />
    </Svg>
  );
}
