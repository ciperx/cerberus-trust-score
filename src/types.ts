/**
 * Public types for the Cerberus trust score.
 *
 * The record follows the fields named in the LAX specification. Every field is
 * optional on purpose: a real record can be partial, and the scorer must say
 * what it did with the gap instead of throwing or inventing data.
 */

export type AdmissionTestResult = "pass" | "fail" | "not_taken";

/** AIAX readiness can arrive as a 0..1 number or as a label. */
export type AiaxReadiness = number | "ready" | "partial" | "not_ready";

export type Tier = "unproven" | "bronze" | "silver" | "gold" | "elite";

/** Ordered weakest to strongest. Index arithmetic uses this order. */
export const TIERS: readonly Tier[] = [
  "unproven",
  "bronze",
  "silver",
  "gold",
  "elite",
] as const;

/**
 * A LAX agent record. camelCase and snake_case are both accepted so callers can
 * pass the registry payload or a local object without a mapping layer.
 */
export interface AgentRecord {
  /** Age of the listing in days. */
  listingAgeDays?: number;
  listing_age_days?: number;

  /** Deliveries the requester accepted. */
  acceptedDeliveries?: number;
  accepted_deliveries?: number;

  /** Deliveries the requester rejected. */
  rejectedDeliveries?: number;
  rejected_deliveries?: number;

  /** Outcome of the LAX admission test. */
  admissionTest?: AdmissionTestResult | boolean;
  admission_test?: AdmissionTestResult | boolean;

  /** AIAX readiness, 0..1 or a label. */
  aiaxReadiness?: AiaxReadiness;
  aiax_readiness?: AiaxReadiness;

  /** ACP score on the usual 0..100 scale. */
  acpScore?: number;
  acp_score?: number;

  /** Disputes opened against the agent and lost, if the record carries them. */
  disputes?: number;
  disputes_lost?: number;

  /**
   * KYC-free flag. Recorded as evidence only: it never changes the score,
   * because privacy posture is not a quality signal.
   */
  kycFree?: boolean;
  kyc_free?: boolean;
}

export interface ScoreFactor {
  /** Stable machine key. */
  name: FactorName;
  /** Weight actually used after missing-field renormalization, 0..1. */
  weight: number;
  /** Points added to (or, for penalties, removed from) the raw score. */
  contribution: number;
  /** Human-readable justification with the numbers that produced it. */
  evidence: string;
  /** False when the source field was absent and its weight was redistributed. */
  present: boolean;
}

export type FactorName =
  | "deliveryReliability"
  | "deliveryVolume"
  | "admissionTest"
  | "aiaxReadiness"
  | "acpScore"
  | "listingAge"
  | "disputePenalty"
  | "thinHistoryCap";

export interface ScoreResult {
  /** 0..100, rounded to 2 decimals. */
  score: number;
  /** Primary tier label required by the LAX spec. */
  tier: Tier;
  /** Alias of tier, for consumers that speak in bands. */
  band: Tier;
  /** One line per factor decision plus the tier and outside-score decisions. */
  reasons: string[];
  /** Structured breakdown. Contributions sum to the raw score before blending. */
  factors: ScoreFactor[];
  /** The weighted score from the record alone, before any outside opinion. */
  recordScore: number;
  /** Tier the record alone would earn. */
  recordTier: Tier;
  /** Share of the final score that came from the outside opinion, 0..1. */
  outsideWeight: number;
  /** True when no delivery outcome exists yet. */
  unproven: boolean;
  /** Number of decided deliveries used. */
  decidedDeliveries: number;
}

export interface ScoreOptions {
  /** Weight of the outside opinion, 0..0.35. Default 0.15. */
  outsideWeight?: number;
  /** Tier cut points for the blended score. Defaults are documented in README. */
  thresholds?: Partial<Record<Exclude<Tier, "unproven" | "elite">, number>>;
}
