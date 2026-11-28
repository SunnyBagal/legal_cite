/** Binary classification metrics. Positive class = "fake" (the checker flags the citation). */
export interface Confusion {
  tp: number;
  fn: number;
  fp: number;
  tn: number;
}

export interface ClassScores {
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);
const f1 = (p: number | null, r: number | null): number | null => (p === null || r === null || p + r === 0 ? null : (2 * p * r) / (p + r));

export function confusion(cases: { actual: boolean; predicted: boolean }[]): Confusion {
  const c: Confusion = { tp: 0, fn: 0, fp: 0, tn: 0 };
  for (const { actual, predicted } of cases) {
    if (actual && predicted) c.tp++;
    else if (actual) c.fn++;
    else if (predicted) c.fp++;
    else c.tn++;
  }
  return c;
}

export function perClass(c: Confusion) {
  const fakeP = ratio(c.tp, c.tp + c.fp);
  const fakeR = ratio(c.tp, c.tp + c.fn);
  const realP = ratio(c.tn, c.tn + c.fn);
  const realR = ratio(c.tn, c.tn + c.fp);
  const n = c.tp + c.fn + c.fp + c.tn;
  return {
    n,
    fake: { precision: fakeP, recall: fakeR, f1: f1(fakeP, fakeR) } satisfies ClassScores,
    real: { precision: realP, recall: realR, f1: f1(realP, realR) } satisfies ClassScores,
    /** Real citations wrongly flagged, over all real citations. */
    falsePositiveRate: ratio(c.fp, c.fp + c.tn),
    accuracy: ratio(c.tp + c.tn, n),
  };
}

/** Precision the same detector would have if fakes made up `prevalence` of the citations. */
export function precisionAtPrevalence(c: Confusion, prevalence: number): number | null {
  const tpr = ratio(c.tp, c.tp + c.fn);
  const fpr = ratio(c.fp, c.fp + c.tn);
  if (tpr === null || fpr === null) return null;
  return ratio(tpr * prevalence, tpr * prevalence + fpr * (1 - prevalence));
}

/** Format a score rounded down (never in our favour). */
export function floorTo(x: number | null, digits: number): string {
  if (x === null) return "n/a";
  const k = 10 ** digits;
  return (Math.floor(x * k + 1e-9) / k).toFixed(digits);
}

/** Format an error rate rounded up (never in our favour). */
export function ceilTo(x: number | null, digits: number): string {
  if (x === null) return "n/a";
  const k = 10 ** digits;
  return (Math.ceil(x * k - 1e-9) / k).toFixed(digits);
}
