import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  TIERS,
  scoreAgent,
  tierFromScore,
  type AgentRecord,
  type ScoreFactor,
} from "../src/index.js";

/** A strong, fully reported record. Individual tests override one field. */
const strong: AgentRecord = {
  listingAgeDays: 120,
  acceptedDeliveries: 40,
  rejectedDeliveries: 2,
  admissionTest: "pass",
  aiaxReadiness: "ready",
  acpScore: 92,
  disputes: 0,
  kycFree: true,
};

const factor = (factors: ScoreFactor[], name: string): ScoreFactor => {
  const found = factors.find((f) => f.name === name);
  if (!found) throw new Error(`missing factor ${name}`);
  return found;
};

const perfect = (accepted: number): AgentRecord => ({
  listingAgeDays: 365,
  acceptedDeliveries: accepted,
  rejectedDeliveries: 0,
  admissionTest: "pass",
  aiaxReadiness: 1,
  acpScore: 100,
  disputes: 0,
});

describe("scoreAgent shape", () => {
  it("returns score, tier, band, reasons and factors", () => {
    const result = scoreAgent(strong);
    expect(typeof result.score).toBe("number");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(TIERS).toContain(result.tier);
    expect(result.band).toBe(result.tier);
    expect(Array.isArray(result.reasons)).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.factors.length).toBe(7);
  });

  it("keeps every factor contribution finite and every weight inside 0..1", () => {
    for (const record of [strong, {}, perfect(12)]) {
      for (const f of scoreAgent(record).factors) {
        expect(Number.isFinite(f.contribution)).toBe(true);
        expect(f.weight).toBeGreaterThanOrEqual(0);
        expect(f.weight).toBeLessThanOrEqual(1);
        expect(f.evidence.length).toBeGreaterThan(10);
      }
    }
  });

  it("sums factor contributions to the record score before blending", () => {
    const result = scoreAgent(strong);
    const sum = result.factors.reduce((acc, f) => acc + f.contribution, 0);
    expect(result.recordScore).toBeCloseTo(sum, 1);
  });
});

describe("one test per factor", () => {
  it("deliveryReliability rewards accepted deliveries and penalizes rejections", () => {
    const good = scoreAgent({ ...strong, rejectedDeliveries: 0 });
    const bad = scoreAgent({ ...strong, rejectedDeliveries: 40 });
    expect(factor(good.factors, "deliveryReliability").contribution).toBeGreaterThan(
      factor(bad.factors, "deliveryReliability").contribution,
    );
    expect(factor(good.factors, "deliveryReliability").evidence).toContain("accepted");
    expect(good.score).toBeGreaterThan(bad.score);
  });

  it("deliveryVolume pays for experience, not for one lucky delivery", () => {
    const one = factor(scoreAgent(perfect(1)).factors, "deliveryVolume");
    const forty = factor(scoreAgent(perfect(40)).factors, "deliveryVolume");
    expect(forty.contribution).toBeGreaterThan(one.contribution);
    expect(forty.contribution).toBeGreaterThan(10);
    expect(one.contribution).toBeLessThan(2);
    expect(forty.evidence).toContain("40 decided deliveries");
  });

  it("admissionTest scores a pass above a fail and is dropped when not taken", () => {
    const pass = factor(scoreAgent({ ...strong, admissionTest: "pass" }).factors, "admissionTest");
    const fail = factor(scoreAgent({ ...strong, admissionTest: "fail" }).factors, "admissionTest");
    const notTaken = factor(
      scoreAgent({ ...strong, admissionTest: "not_taken" }).factors,
      "admissionTest",
    );
    expect(pass.contribution).toBeGreaterThan(fail.contribution);
    expect(fail.contribution).toBe(0);
    expect(notTaken.present).toBe(false);
    expect(notTaken.evidence).toContain("missing");
  });

  it("aiaxReadiness maps labels and fractions onto the same scale", () => {
    const ready = scoreAgent({ ...strong, aiaxReadiness: "ready" });
    const partial = scoreAgent({ ...strong, aiaxReadiness: 0.5 });
    const none = scoreAgent({ ...strong, aiaxReadiness: "not_ready" });
    expect(factor(ready.factors, "aiaxReadiness").contribution).toBeCloseTo(
      factor(partial.factors, "aiaxReadiness").contribution * 2,
      1,
    );
    expect(factor(none.factors, "aiaxReadiness").contribution).toBe(0);
  });

  it("acpScore maps 0..100 onto the factor and accepts a fraction", () => {
    const high = scoreAgent({ ...strong, acpScore: 100 });
    const low = scoreAgent({ ...strong, acpScore: 20 });
    const fraction = scoreAgent({ ...strong, acpScore: 0.5 });
    expect(factor(high.factors, "acpScore").contribution).toBeGreaterThan(
      factor(low.factors, "acpScore").contribution,
    );
    expect(factor(fraction.factors, "acpScore").contribution).toBeCloseTo(
      factor(scoreAgent({ ...strong, acpScore: 50 }).factors, "acpScore").contribution,
      1,
    );
  });

  it("listingAge grows with days listed and saturates", () => {
    const young = scoreAgent({ ...strong, listingAgeDays: 1 });
    const old = scoreAgent({ ...strong, listingAgeDays: 200 });
    const ancient = scoreAgent({ ...strong, listingAgeDays: 4000 });
    expect(factor(old.factors, "listingAge").contribution).toBeGreaterThan(
      factor(young.factors, "listingAge").contribution,
    );
    expect(factor(ancient.factors, "listingAge").contribution).toBeLessThanOrEqual(15);
  });

  it("disputePenalty deducts points and never adds any", () => {
    const clean = scoreAgent({ ...strong, disputes: 0 });
    const dirty = scoreAgent({ ...strong, disputes: 3 });
    const penalty = factor(dirty.factors, "disputePenalty");
    expect(penalty.contribution).toBeLessThanOrEqual(0);
    expect(penalty.contribution).toBeCloseTo(-10, 1);
    expect(dirty.score).toBeLessThan(clean.score);
  });
});

describe("missing fields", () => {
  it("scores an empty record as unproven and never throws", () => {
    const result = scoreAgent({});
    expect(result.score).toBe(0);
    expect(result.tier).toBe("unproven");
    expect(result.unproven).toBe(true);
    expect(result.decidedDeliveries).toBe(0);
  });

  it("redistributes the weight of absent factors instead of punishing them", () => {
    const onlyAcp = scoreAgent({ acpScore: 100 });
    const acp = factor(onlyAcp.factors, "acpScore");
    // acp is the only present positive factor, so it carries the full weight.
    expect(acp.weight).toBe(1);
    expect(acp.contribution).toBeCloseTo(100, 1);
    expect(onlyAcp.score).toBe(100);
    // No deliveries still means unproven, whatever the other fields say.
    expect(onlyAcp.tier).toBe("unproven");
  });

  it("treats absent and not_taken admission tests the same way", () => {
    const absentRecord: AgentRecord = { ...strong };
    delete absentRecord.admissionTest;
    const absent = scoreAgent(absentRecord);
    const notTaken = scoreAgent({ ...strong, admissionTest: "not_taken" });
    expect(absent.score).toBe(notTaken.score);
    expect(absent.factors.filter((f) => !f.present).map((f) => f.name)).toContain("admissionTest");
  });

  it("marks absent disputes as no penalty and says so", () => {
    const noDisputes: AgentRecord = { ...strong };
    delete noDisputes.disputes;
    const result = scoreAgent(noDisputes);
    const penalty = factor(result.factors, "disputePenalty");
    expect(penalty.present).toBe(false);
    expect(penalty.contribution).toBe(0);
    expect(penalty.evidence).toContain("no penalty");
  });

  it("ignores NaN and negative counts rather than producing a broken score", () => {
    const result = scoreAgent({
      acceptedDeliveries: Number.NaN,
      rejectedDeliveries: -5,
      acpScore: Number.POSITIVE_INFINITY,
      listingAgeDays: -10,
    });
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("accepts snake_case registry payloads identically to camelCase", () => {
    const camel = scoreAgent(strong);
    const snake = scoreAgent({
      listing_age_days: 120,
      accepted_deliveries: 40,
      rejected_deliveries: 2,
      admission_test: "pass",
      aiax_readiness: "ready",
      acp_score: 92,
      disputes: 0,
      kyc_free: true,
    });
    expect(snake.score).toBe(camel.score);
    expect(snake.tier).toBe(camel.tier);
  });

  it("does not score on the KYC-free flag", () => {
    const withFlag = scoreAgent({ ...strong, kycFree: true });
    const withoutFlag = scoreAgent({ ...strong, kycFree: false });
    expect(withFlag.score).toBe(withoutFlag.score);
  });
});

describe("thin history", () => {
  it("one win never outranks forty wins with the same rate", () => {
    const one = scoreAgent(perfect(1));
    const forty = scoreAgent(perfect(40));
    expect(one.score).toBeLessThan(forty.score);
    expect(forty.score - one.score).toBeGreaterThan(8);
  });

  it("does not let one win reach gold even with every other field perfect", () => {
    expect(scoreAgent(perfect(1)).tier).not.toBe("gold");
    expect(scoreAgent(perfect(1)).tier).not.toBe("elite");
  });

  it("caps a thin record below gold and says why", () => {
    const one = scoreAgent(perfect(1));
    expect(one.recordScore).toBe(69);
    expect(one.tier).toBe("silver");
    const cap = factor(one.factors, "thinHistoryCap");
    expect(cap.contribution).toBeLessThan(0);
    expect(cap.evidence).toContain("capped at 69");
    // At five decisions the cap no longer applies.
    const five = scoreAgent(perfect(5));
    expect(five.recordScore).toBeGreaterThan(69);
    expect(five.factors.some((f) => f.name === "thinHistoryCap")).toBe(false);
  });

  it("one win is still counted, just damped", () => {
    const one = scoreAgent(perfect(1));
    expect(one.unproven).toBe(false);
    expect(one.decidedDeliveries).toBe(1);
    expect(one.score).toBeGreaterThan(50);
  });

  it("a single rejection cannot sink an experienced agent to unproven", () => {
    const veteran = scoreAgent({ ...perfect(40), rejectedDeliveries: 1 });
    expect(veteran.score).toBeGreaterThan(70);
  });

  it("grants elite only with a long record", () => {
    const shortStrong = scoreAgent(perfect(10), 100);
    const longStrong = scoreAgent(perfect(40), 100);
    expect(shortStrong.tier).not.toBe("elite");
    expect(longStrong.tier).toBe("elite");
  });
});

describe("tier boundaries are table driven", () => {
  const cases: Array<[number, string]> = [
    [0, "unproven"],
    [34.99, "unproven"],
    [35, "bronze"],
    [54.99, "bronze"],
    [55, "silver"],
    [74.99, "silver"],
    [75, "gold"],
    [87.99, "gold"],
    [88, "elite"],
    [100, "elite"],
  ];

  it.each(cases)("tierFromScore(%s) is %s", (score, expected) => {
    expect(tierFromScore(score)).toBe(expected);
  });

  it("uses the documented default thresholds", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ bronze: 35, silver: 55, gold: 75 });
  });

  it("honours caller supplied thresholds", () => {
    expect(tierFromScore(60, { bronze: 20, silver: 50, gold: 90 })).toBe("silver");
  });

  it("walks a full record up the tiers as deliveries accumulate", () => {
    const weak = scoreAgent({
      listingAgeDays: 5,
      acceptedDeliveries: 1,
      rejectedDeliveries: 1,
      admissionTest: "fail",
      aiaxReadiness: "not_ready",
      acpScore: 10,
    });
    const middle = scoreAgent({
      listingAgeDays: 30,
      acceptedDeliveries: 12,
      rejectedDeliveries: 3,
      admissionTest: "pass",
      aiaxReadiness: "partial",
      acpScore: 55,
    });
    const good = scoreAgent({
      listingAgeDays: 90,
      acceptedDeliveries: 25,
      rejectedDeliveries: 2,
      admissionTest: "pass",
      aiaxReadiness: "ready",
      acpScore: 80,
    });
    expect(TIERS.indexOf(weak.tier)).toBeLessThan(TIERS.indexOf(middle.tier));
    expect(TIERS.indexOf(middle.tier)).toBeLessThan(TIERS.indexOf(good.tier));
  });
});

describe("outside score as a second opinion", () => {
  const bronzeish: AgentRecord = {
    listingAgeDays: 20,
    acceptedDeliveries: 6,
    rejectedDeliveries: 3,
    admissionTest: "pass",
    aiaxReadiness: "partial",
    acpScore: 35,
  };

  it("records how much weight the outside opinion received", () => {
    const without = scoreAgent(bronzeish);
    const withOutside = scoreAgent(bronzeish, 90);
    expect(without.outsideWeight).toBe(0);
    expect(withOutside.outsideWeight).toBeCloseTo(0.15, 5);
    expect(withOutside.score).toBeGreaterThan(without.score);
    expect(withOutside.recordScore).toBe(without.recordScore);
  });

  it("moves the tier by at most one step upward", () => {
    const base = scoreAgent(bronzeish);
    const boosted = scoreAgent(bronzeish, 100);
    const baseIndex = TIERS.indexOf(base.tier);
    const boostIndex = TIERS.indexOf(boosted.tier);
    expect(boostIndex).toBeGreaterThanOrEqual(baseIndex);
    expect(boostIndex - baseIndex).toBeLessThanOrEqual(1);
  });

  it("moves the tier by at most one step downward", () => {
    const base = scoreAgent(perfect(40));
    const dragged = scoreAgent(perfect(40), 0);
    const baseIndex = TIERS.indexOf(base.tier);
    const dragIndex = TIERS.indexOf(dragged.tier);
    expect(baseIndex - dragIndex).toBeLessThanOrEqual(1);
    expect(dragged.score).toBeLessThan(base.score);
  });

  it("can never make an agent elite on its own", () => {
    const weak: AgentRecord = {
      listingAgeDays: 10,
      acceptedDeliveries: 3,
      rejectedDeliveries: 2,
      admissionTest: "fail",
      aiaxReadiness: "not_ready",
      acpScore: 20,
    };
    for (const outside of [90, 95, 100]) {
      const result = scoreAgent(weak, outside);
      expect(result.tier).not.toBe("elite");
      expect(result.score).toBeLessThan(75);
    }
  });

  it("withholds elite from a proven but merely good record", () => {
    const merelyGood: AgentRecord = {
      listingAgeDays: 90,
      acceptedDeliveries: 30,
      rejectedDeliveries: 4,
      admissionTest: "pass",
      aiaxReadiness: 0.5,
      acpScore: 60,
      disputes: 0,
    };
    const good = scoreAgent(merelyGood, 70);
    expect(good.recordTier).toBe("gold");
    expect(good.tier).toBe("gold");
  });

  it("clamps an absurd outside weight to the documented ceiling", () => {
    const result = scoreAgent(bronzeish, 100, { outsideWeight: 0.9 });
    expect(result.outsideWeight).toBe(0.35);
    expect(TIERS.indexOf(result.tier) - TIERS.indexOf(scoreAgent(bronzeish).tier)).toBeLessThanOrEqual(1);
  });

  it("ignores a non-finite outside score", () => {
    const result = scoreAgent(strong, Number.NaN);
    expect(result.outsideWeight).toBe(0);
    expect(result.score).toBe(result.recordScore);
  });
});

describe("determinism", () => {
  it("returns identical results for identical inputs across many runs", () => {
    const runs = Array.from({ length: 25 }, () => scoreAgent(strong, 77));
    for (const run of runs) {
      expect(run).toEqual(runs[0]);
    }
  });

  it("does not mutate the input record", () => {
    const record: AgentRecord = { ...strong };
    const snapshot = JSON.stringify(record);
    scoreAgent(record, 50);
    expect(JSON.stringify(record)).toBe(snapshot);
  });
});
