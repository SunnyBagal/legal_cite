import { describe, expect, it } from "vitest";
import { confusion, floorTo, perClass, precisionAtPrevalence, ceilTo } from "./metrics.js";

// Positive class = "fake". Hand-worked: 10 cases.
//   actual fake, flagged:     4  (TP)
//   actual fake, not flagged: 1  (FN)
//   actual real, flagged:     2  (FP)
//   actual real, not flagged: 3  (TN)
const cases = [
  ...Array(4).fill({ actual: true, predicted: true }),
  ...Array(1).fill({ actual: true, predicted: false }),
  ...Array(2).fill({ actual: false, predicted: true }),
  ...Array(3).fill({ actual: false, predicted: false }),
];

describe("metrics", () => {
  it("counts the confusion matrix", () => {
    expect(confusion(cases)).toEqual({ tp: 4, fn: 1, fp: 2, tn: 3 });
  });

  it("gives precision, recall, F1 for both classes and the false-positive rate on real ones", () => {
    const m = perClass(confusion(cases));
    // fake: P = 4/6, R = 4/5, F1 = 2PR/(P+R) = 8/11
    expect(m.fake.precision).toBeCloseTo(4 / 6, 10);
    expect(m.fake.recall).toBeCloseTo(4 / 5, 10);
    expect(m.fake.f1).toBeCloseTo(8 / 11, 10);
    // real: P = 3/4, R = 3/5, F1 = 2/3
    expect(m.real.precision).toBeCloseTo(3 / 4, 10);
    expect(m.real.recall).toBeCloseTo(3 / 5, 10);
    expect(m.real.f1).toBeCloseTo(2 / 3, 10);
    expect(m.falsePositiveRate).toBeCloseTo(2 / 5, 10);
    expect(m.accuracy).toBeCloseTo(7 / 10, 10);
    expect(m.n).toBe(10);
  });

  it("returns null, not NaN, when a ratio is undefined", () => {
    const m = perClass({ tp: 0, fn: 0, fp: 0, tn: 5 });
    expect(m.fake.precision).toBeNull();
    expect(m.fake.recall).toBeNull();
    expect(m.fake.f1).toBeNull();
    expect(m.falsePositiveRate).toBe(0);
  });

  it("re-weights precision to the dataset's prevalence (sample was balanced)", () => {
    // TPR 0.8, FPR 0.4, prevalence 0.25 → 0.2 / (0.2 + 0.3) = 0.4
    expect(precisionAtPrevalence({ tp: 4, fn: 1, fp: 2, tn: 3 }, 0.25)).toBeCloseTo(0.4, 10);
  });

  it("rounds against us: scores down, error rates up", () => {
    expect(floorTo(0.66666, 3)).toBe("0.666");
    expect(ceilTo(0.40001, 3)).toBe("0.401");
    expect(floorTo(null, 3)).toBe("n/a");
    expect(floorTo(1, 3)).toBe("1.000");
  });
});
