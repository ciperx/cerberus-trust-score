import {
  TIERS,
  type AdmissionTestResult,
  type AgentRecord,
  type AiaxReadiness,
  type FactorName,
  type ScoreFactor,
  type ScoreOptions,
  type ScoreResult,
  type Tier,
} from "./types.js";

/** Prior weight for the delivery success rate: 6 pseudo-deliveries at 0.5. */
export const RELIABILITY_PRIOR_STRENGTH = 6;
/** Decided deliveries at which the volume factor reaches about 63 percent. */
export const VOLUME_HALF_LIFE = 14;
/** Listing age in days at which the age factor reaches about 63 percent. */
export const AGE_HALF_LIFE = 60;
/** Score at which the elite tier becomes reachable. */
export const ELITE_SCORE = 88;
/** Deliveries needed before elite can be awarded. */
export const ELITE_MIN_DECIDED = 25;
/** Outside score needed before elite can be awarded when one is supplied. */
export const ELITE_MIN_OUTSIDE = 85;
/** Decided deliveries below which the thin-history cap applies. */
export const THIN_HISTORY_MIN_DECIDED = 5;
/** Highest record score a thin history may earn, which is the top of silver. */
export const THIN_HISTORY_CAP = 69;
/** Hard ceiling on how much an outside opinion may weigh. */
export const MAX_OUTSIDE_WEIGHT = 0.35;

export const DEFAULT_OUTSIDE_WEIGHT = 0.15;

export const DEFAULT_THRESHOLDS: Record<"bronze" | "silver" | "gold", number> = {
  bronze: 35,
  silver: 55,
  gold: 75,
};

/**
 * Positive factor weights. They sum to 1.0, so a record with every field
 * present and every value at its best yields 100 before the dispute penalty.
 */
export const WEIGHTS: Record<
  Exclude<FactorName, "disputePenalty" | "thinHistoryCap">,
  number
> = {
  deliveryReliability: 0.3,
  deliveryVolume: 0.15,
  admissionTest: 0.15,
  aiaxReadiness: 0.1,
  acpScore: 0.15,
  listingAge: 0.15,
};

/** Maximum deduction from lost disputes, applied after the weighted sum. */
export const DISPUTE_PENALTY_WEIGHT = 0.1;

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = num(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value.toLowerCase();
  }
  return undefined;
}

function admissionValue(raw: unknown): number | undefined {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw !== "string") return undefined;
  const value = raw.toLowerCase().trim();
  if (value === "pass" || value === "passed") return 1;
  if (value === "fail" || value === "failed") return 0;
  if (value === "not_taken" || value === "not taken" || value === "pending") {
    return undefined;
  }
  return undefined;
}

function aiaxValue(raw: AiaxReadiness | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return undefined;
    // Accept both a 0..1 fraction and a 0..100 percentage.
    const scaled = raw > 1 ? raw / 100 : raw;
    return clamp(scaled, 0, 1);
  }
  switch (raw) {
    case "ready":
      return 1;
    case "partial":
      return 0.5;
    case "not_ready":
      return 0;
    default:
      return undefined;
  }
}

function acpValue(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  // A value at or below 1 is read as a fraction, anything else as 0..100.
  const scaled = raw > 0 && raw <= 1 ? raw * 100 : raw;
  return clamp(scaled, 0, 100) / 100;
}

interface Draft {
  name: FactorName;
  weight: number;
  value: number | undefined;
  evidence: string;
  penalty?: boolean;
}

/**
 * Score a LAX agent record. Deterministic and network-free: the outside score
 * is a parameter, never a lookup.
 *
 * The outside opinion can move the tier by at most one step, and it can never
 * promote an agent to elite on its own: elite needs a gold record tier plus at
 * least 25 decided deliveries plus an outside score of 85 or more.
 */
export function scoreAgent(
  record: AgentRecord,
  outside?: number,
  options: ScoreOptions = {},
): ScoreResult {
  const accepted = Math.max(
    0,
    Math.floor(pickNumber(record.acceptedDeliveries, record.accepted_deliveries) ?? 0),
  );
  const rejected = Math.max(
    0,
    Math.floor(pickNumber(record.rejectedDeliveries, record.rejected_deliveries) ?? 0),
  );
  const decided = accepted + rejected;
  const unproven = decided === 0;

  const drafts: Draft[] = [];

  // 1. Delivery reliability, shrunk toward 0.5 so a single win proves little.
  let reliability: number | undefined;
  if (decided > 0) {
    reliability =
      (accepted + RELIABILITY_PRIOR_STRENGTH * 0.5) /
      (decided + RELIABILITY_PRIOR_STRENGTH);
    drafts.push({
      name: "deliveryReliability",
      weight: WEIGHTS.deliveryReliability,
      value: reliability,
      evidence:
        `${accepted} accepted and ${rejected} rejected of ${decided} decided deliveries; ` +
        `shrunk toward 0.5 with a prior of ${RELIABILITY_PRIOR_STRENGTH} deliveries, ` +
        `rate ${reliability.toFixed(3)}`,
    });
  } else {
    drafts.push({
      name: "deliveryReliability",
      weight: WEIGHTS.deliveryReliability,
      value: undefined,
      evidence: "missing: no decided deliveries, weight redistributed",
    });
  }

  // 2. Volume, so one lucky win cannot match forty wins.
  if (decided > 0) {
    const volume = 1 - Math.exp(-decided / VOLUME_HALF_LIFE);
    drafts.push({
      name: "deliveryVolume",
      weight: WEIGHTS.deliveryVolume,
      value: volume,
      evidence:
        `${decided} decided deliveries; volume curve 1 - exp(-n / ${VOLUME_HALF_LIFE}) ` +
        `gives ${volume.toFixed(3)}`,
    });
  } else {
    drafts.push({
      name: "deliveryVolume",
      weight: WEIGHTS.deliveryVolume,
      value: undefined,
      evidence: "missing: no decided deliveries, weight redistributed",
    });
  }

  // 3. Admission test.
  const admission = admissionValue(
    record.admissionTest !== undefined ? record.admissionTest : record.admission_test,
  );
  drafts.push({
    name: "admissionTest",
    weight: WEIGHTS.admissionTest,
    value: admission,
    evidence:
      admission === undefined
        ? "missing: admission test not taken or not reported, weight redistributed"
        : `admission test ${admission === 1 ? "passed" : "failed"}`,
  });

  // 4. AIAX readiness.
  const aiax = aiaxValue(
    record.aiaxReadiness !== undefined ? record.aiaxReadiness : record.aiax_readiness,
  );
  drafts.push({
    name: "aiaxReadiness",
    weight: WEIGHTS.aiaxReadiness,
    value: aiax,
    evidence:
      aiax === undefined
        ? "missing: AIAX readiness not reported, weight redistributed"
        : `AIAX readiness ${aiax.toFixed(2)}`,
  });

  // 5. ACP score.
  const acp = acpValue(pickNumber(record.acpScore, record.acp_score));
  drafts.push({
    name: "acpScore",
    weight: WEIGHTS.acpScore,
    value: acp,
    evidence:
      acp === undefined
        ? "missing: ACP score not reported, weight redistributed"
        : `ACP score ${(acp * 100).toFixed(1)} of 100`,
  });

  // 6. Listing age, a weak proxy for having stayed alive.
  const ageDays = pickNumber(record.listingAgeDays, record.listing_age_days);
  const age =
    ageDays === undefined
      ? undefined
      : 1 - Math.exp(-Math.max(0, ageDays) / AGE_HALF_LIFE);
  drafts.push({
    name: "listingAge",
    weight: WEIGHTS.listingAge,
    value: age,
    evidence:
      age === undefined || ageDays === undefined
        ? "missing: listing age not reported, weight redistributed"
        : `listing age ${Math.max(0, ageDays)} days; age curve 1 - exp(-d / ${AGE_HALF_LIFE}) ` +
          `gives ${age.toFixed(3)}`,
  });

  // Positive weights are renormalized over the fields that actually arrived.
  const presentPositive = drafts.filter((d) => d.value !== undefined);
  const positiveWeight = presentPositive.reduce((sum, d) => sum + d.weight, 0);
  const scale = positiveWeight > 0 ? 1 / positiveWeight : 0;

  const factors: ScoreFactor[] = drafts.map((draft) => {
    const present = draft.value !== undefined;
    const weight = present ? round2(draft.weight * scale * 100) / 100 : 0;
    const contribution = present ? draft.weight * scale * (draft.value as number) * 100 : 0;
    return {
      name: draft.name,
      weight,
      contribution: round2(contribution),
      evidence: draft.evidence,
      present,
    };
  });

  // 7. Disputes are a deduction, never a source of points.
  const disputes = pickNumber(record.disputes, record.disputes_lost);
  if (disputes !== undefined) {
    const value = clamp(Math.max(0, disputes) / 3, 0, 1);
    const contribution = -DISPUTE_PENALTY_WEIGHT * value * 100;
    factors.push({
      name: "disputePenalty",
      weight: DISPUTE_PENALTY_WEIGHT,
      contribution: round2(contribution),
      evidence:
        `${Math.max(0, disputes)} lost disputes; penalty is ` +
        `${DISPUTE_PENALTY_WEIGHT} weight times min(1, disputes / 3)`,
      present: true,
    });
  } else {
    factors.push({
      name: "disputePenalty",
      weight: 0,
      contribution: 0,
      evidence: "missing: dispute history not reported, no penalty applied",
      present: false,
    });
  }

  let rawScore = clamp(factors.reduce((sum, f) => sum + f.contribution, 0), 0, 100);

  // Thin-history cap: the weighted sum is honest, but a record with fewer than
  // 5 decisions may not reach gold on the strength of other fields alone.
  if (!unproven && decided < THIN_HISTORY_MIN_DECIDED && rawScore > THIN_HISTORY_CAP) {
    const excess = rawScore - THIN_HISTORY_CAP;
    factors.push({
      name: "thinHistoryCap",
      weight: 0,
      contribution: round2(-excess),
      evidence:
        `only ${decided} decided deliveries; record score capped at ` +
        `${THIN_HISTORY_CAP} until ${THIN_HISTORY_MIN_DECIDED} decisions are on file`,
      present: true,
    });
    rawScore = THIN_HISTORY_CAP;
  }

  const recordScore = round2(rawScore);

  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const recordTier = unproven ? "unproven" : tierFromScore(recordScore, thresholds);

  const reasons: string[] = factors
    .filter((f) => f.present)
    .map(
      (f) =>
        `${f.name}: ${f.contribution > 0 ? "+" : ""}${f.contribution} (${f.evidence})`,
    );

  let score = recordScore;
  let tier: Tier = recordTier;
  let outsideWeight = 0;

  if (outside !== undefined && Number.isFinite(outside)) {
    const requested = options.outsideWeight ?? DEFAULT_OUTSIDE_WEIGHT;
    outsideWeight = clamp(requested, 0, MAX_OUTSIDE_WEIGHT);
    const outsideScore = clamp(outside, 0, 100);
    score = round2((1 - outsideWeight) * recordScore + outsideWeight * outsideScore);

    const recordIndex = TIERS.indexOf(recordTier);
    const proposed = TIERS.indexOf(tierFromScore(score, thresholds));
    const capped = clamp(proposed, Math.max(0, recordIndex - 1), Math.min(4, recordIndex + 1));
    tier = TIERS[capped] as Tier;

    reasons.push(
      `outsideScore: blended at weight ${outsideWeight} with value ${outsideScore}, ` +
        `score ${recordScore} becomes ${score}; tier ${recordTier} becomes ${tier} ` +
        `and may move at most one step`,
    );
  }

  // Elite gate. The outside opinion is corroboration, never the qualification.
  const baseEliteEligible = decided >= ELITE_MIN_DECIDED && recordScore >= ELITE_SCORE;
  const eliteAllowed =
    baseEliteEligible &&
    (outside === undefined || !Number.isFinite(outside)
      ? true
      : outside >= ELITE_MIN_OUTSIDE && score >= ELITE_SCORE);

  if (tier === "elite" && !eliteAllowed) {
    tier = "gold";
    reasons.push(
      "elite withheld: elite needs a gold record tier, at least " +
        `${ELITE_MIN_DECIDED} decided deliveries and an outside score of at least ` +
        `${ELITE_MIN_OUTSIDE} when one is supplied`,
    );
  } else if (eliteAllowed && tier !== "elite") {
    // A gold record with strong corroboration is allowed the one step up.
    tier = "elite";
    reasons.push("elite granted: gold record tier with corroborating evidence");
  }

  if (unproven) {
    tier = "unproven";
    reasons.push("unproven: no decided deliveries, so the lowest tier applies and no refusal is issued");
  }

  reasons.unshift(
    `score ${score} from record ${recordScore}; tier ${tier}; decided deliveries ${decided}`,
  );

  return {
    score,
    tier,
    band: tier,
    reasons,
    factors,
    recordScore,
    recordTier,
    outsideWeight,
    unproven,
    decidedDeliveries: decided,
  };
}

/** Map a 0..100 score to a tier, ignoring the elite gate and the unproven rule. */
export function tierFromScore(
  score: number,
  thresholds: Record<"bronze" | "silver" | "gold", number> = DEFAULT_THRESHOLDS,
): Tier {
  if (score >= ELITE_SCORE) return "elite";
  if (score >= thresholds.gold) return "gold";
  if (score >= thresholds.silver) return "silver";
  if (score >= thresholds.bronze) return "bronze";
  return "unproven";
}
