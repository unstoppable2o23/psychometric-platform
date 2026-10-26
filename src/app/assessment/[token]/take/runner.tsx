'use client';

/**
 * Assessment runner.
 *
 * The countdown displayed here is cosmetic. Authority lives on the server:
 * `expiresAtMs` arrives from the server, the local clock is corrected against
 * `serverNowMs` to absorb drift, and the server rejects any save or submit that
 * arrives after its own deadline. Manipulating this timer changes nothing.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { saveAnswersAction, submitAttemptAction } from '@/app/actions/attempts';
import { LIKERT_LABELS, type ActiveSession, type SavedAnswer } from '@/lib/domain/types';

type AnswerMap = Record<string, string>;

export function AssessmentRunner({ initial }: { initial: ActiveSession }) {
  const router = useRouter();

  const [answers, setAnswers] = useState<AnswerMap>(() => {
    // Restored from the server so a refresh does not look like lost work.
    const map: AnswerMap = {};
    for (const a of initial.answers) map[a.questionId] = a.value;
    return map;
  });
  const [flagged, setFlagged] = useState<Set<string>>(new Set(initial.flaggedIds));
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(initial.clock.remainingSeconds);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Offset between the server clock and this browser's clock. Measured inside an
  // effect rather than during render: Date.now() is impure, and reading it while
  // rendering would differ between the server pass and hydration.
  const driftRef = useRef(0);
  const expiresAt = initial.clock.expiresAtMs;

  const questions = initial.questions;
  const total = questions.length;
  const answeredCount = Object.keys(answers).length;

  /* ------------------------------ timer ------------------------------ */
  useEffect(() => {
    driftRef.current = initial.clock.serverNowMs - Date.now();

    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - (Date.now() + driftRef.current)) / 1000));
      setRemaining(left);
      if (left === 0) {
        void submitAttemptAction(initial.sessionId).then((res) => {
          const data = res.data;
          if (res.ok && data) router.replace(`/results/${data.sessionId}`);
        });
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, initial.clock.serverNowMs, initial.sessionId, router]);

  /* ---------------------------- autosave ----------------------------- */
  const pendingRef = useRef<SavedAnswer[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (pendingRef.current.length === 0) return;
    const batch = pendingRef.current;
    pendingRef.current = [];

    setSaveState('saving');
    const result = await saveAnswersAction(initial.sessionId, batch);
    if (!result.ok) {
      // Put the batch back so the next flush retries it rather than dropping it.
      pendingRef.current = [...batch, ...pendingRef.current];
      setSaveState('error');
      setError(result.error ?? 'Could not save your answers.');
      return;
    }
    setSaveState('saved');
    setError(null);
  }, [initial.sessionId]);

  const queueAnswer = useCallback(
    (questionId: string, value: string) => {
      setAnswers((prev) => {
        const next = { ...prev };
        if (value === '') delete next[questionId];
        else next[questionId] = value;
        return next;
      });
      pendingRef.current.push({ questionId, value });
      if (flushTimer.current) clearTimeout(flushTimer.current);
      // Debounced so a fast click-through does not produce one request per key.
      flushTimer.current = setTimeout(() => void flush(), 900);
    },
    [flush],
  );

  // Last-chance flush if the tab is closed or backgrounded.
  useEffect(() => {
    const onHide = () => {
      if (pendingRef.current.length > 0) void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [flush]);

  /* ----------------------------- submit ------------------------------ */
  const doSubmit = async () => {
    setSubmitting(true);
    await flush();
    const result = await submitAttemptAction(initial.sessionId);
    const data = result.data;
    if (!result.ok || !data) {
      setError(result.error ?? 'Could not submit.');
      setSubmitting(false);
      return;
    }
    router.replace(`/results/${data.sessionId}`);
  };

  /* ------------------------------ render ----------------------------- */
  const current = questions[index];
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const urgent = remaining <= 300;
  const required = Math.ceil(total * initial.minCompletionRatio);
  const canSubmit = answeredCount >= required;

  if (!current) {
    return (
      <main className="p-8 text-center text-sm text-slate-600">
        This attempt has no questions available. Contact your school.
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-surface">
      {/* Header: title, progress, timer */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-navy">{initial.assessment.title}</h1>
            <p className="text-xs text-slate-500">
              Question {index + 1} of {total} &middot; {answeredCount} answered
              {saveState === 'saving' ? ' \u00b7 saving…' : saveState === 'saved' ? ' \u00b7 saved' : ''}
            </p>
          </div>
          <div
            role="timer"
            aria-live={urgent ? 'assertive' : 'off'}
            className={`rounded-md px-3 py-1.5 font-mono text-lg tabular-nums ${
              urgent ? 'bg-red-50 text-red-700' : 'bg-lavender text-navy'
            }`}
          >
            {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
          </div>
        </div>
        <div className="h-1 w-full bg-slate-100">
          <div
            className="h-1 bg-royal transition-all"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>
      </header>

      <div className="mx-auto grid max-w-4xl gap-6 px-5 py-6 lg:grid-cols-[1fr_230px]">
        {/* Question */}
        <section aria-live="polite" className="rounded-lg border border-slate-200 bg-white p-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-royal">
            Question {index + 1} of {total}
          </p>
          <h2 className="mt-2 text-lg leading-relaxed text-navy">{current.prompt}</h2>
          {current.helpText ? (
            <p className="mt-2 text-sm text-slate-500">{current.helpText}</p>
          ) : null}

          <fieldset className="mt-5">
            <legend className="sr-only">Your answer</legend>
            <div className="space-y-2">
              {current.options.map((option, i) => {
                const checked = answers[current.id] === option.id;
                return (
                  <label
                    key={option.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition ${
                      checked
                        ? 'border-royal bg-lavender text-navy'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name={current.id}
                      value={option.id}
                      checked={checked}
                      onChange={() => queueAnswer(current.id, option.id)}
                      className="mt-0.5 accent-[#2563EB]"
                    />
                    <span>
                      {current.type === 'likert' ? (
                        <>
                          <span className="block font-medium">
                            {i + 1}. {option.label}
                          </span>
                        </>
                      ) : (
                        option.label
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {current.type === 'likert' ? (
            <div className="mt-3 flex items-start gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-600">Scale:</span>
              <span>
                {LIKERT_LABELS[0]} (1) &rarr; {LIKERT_LABELS[LIKERT_LABELS.length - 1]} (5)
              </span>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          {/* Navigation */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-40"
            >
              Previous
            </button>

            <button
              type="button"
              onClick={() =>
                setFlagged((prev) => {
                  const next = new Set(prev);
                  if (next.has(current.id)) next.delete(current.id);
                  else next.add(current.id);
                  return next;
                })
              }
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
            >
              {flagged.has(current.id) ? 'Unflag' : 'Flag for review'}
            </button>

            {index === total - 1 ? (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-md bg-royal px-5 py-2 text-sm font-semibold text-white hover:bg-royal-600"
              >
                Review and submit
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
                className="rounded-md bg-royal px-5 py-2 text-sm font-semibold text-white hover:bg-royal-600"
              >
                Next
              </button>
            )}
          </div>
        </section>

        {/* Question map */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Questions
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              {answeredCount} of {required} required answered
            </p>
            <div className="mt-3 grid grid-cols-8 gap-1 lg:grid-cols-6">
              {questions.map((q, i) => {
                const state = answers[q.id] ? 'answered' : flagged.has(q.id) ? 'flagged' : 'empty';
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-current={i === index}
                    aria-label={`Question ${i + 1}, ${state}`}
                    className={`h-8 rounded text-xs font-medium transition ${
                      i === index
                        ? 'bg-navy text-white'
                        : state === 'answered'
                          ? 'bg-lavender text-navy'
                          : state === 'flagged'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
      </div>

      {/* Submit confirmation */}
      {confirming ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-30 flex items-center justify-center bg-navy/40 p-5"
        >
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-navy">Submit your assessment?</h2>
            <p className="mt-2 text-sm text-slate-600">
              You have answered <strong>{answeredCount}</strong> of {total} questions.
              {canSubmit
                ? ' You can still go back and change answers after submitting, but the report is generated from what you submit now.'
                : ` You need at least ${required} answers to submit.`}
            </p>
            {!canSubmit ? (
              <p className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-800">
                {required - answeredCount} more answers are needed. The server enforces this, so
                submitting now will be refused. If time runs out the paper is submitted
                automatically with whatever you have answered.
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
              >
                Keep working
              </button>
              <button
                type="button"
                disabled={submitting || !canSubmit}
                onClick={() => void doSubmit()}
                className="rounded-md bg-royal px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Submitting…' : 'Submit now'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
