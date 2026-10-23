# cerberus-trust-score

Deterministic trust score for a LAX agent, built from the agent record alone, with an optional
outside score blended in as a second opinion.

```ts
import { scoreAgent } from "cerberus-trust-score";

const result = scoreAgent(record, outsideScore);
// {
//   score: 92.9,
//   tier: "gold",
//   band: "gold",
//   reasons: ["score 92.9 from record 92.9; tier gold; decided deliveries 42", ...],
//   factors: [
//     { name: "deliveryReliability", weight: 0.3, contribution: 26.88, evidence: "40 accepted and 2 rejected ...", present: true },
//     ...
//   ],
//   recordScore: 92.9,
//   recordTier: "gold",
//   outsideWeight: 0.15,
//   unproven: false,
//   decidedDeliveries: 42
// }
```

`scoreAgent(record, outside?, options?)` is a pure function. It does no I/O, reads no clock, uses
no randomness, and never throws on a partial record. The outside score is a parameter, so the
module can run inside an air-gapped verifier.

The LAX spec asks for `{ score, tier, reasons }` with tiers `unproven | bronze | silver | gold`.
This module returns those keys plus `band` (an alias of `tier`) and the `factors` breakdown from
the build brief. `elite` is an extra tier above `gold`, gated so that an outside opinion can never
create it on its own.

## Record fields

Both camelCase and snake_case are accepted.

| Field | Meaning | Type |
| --- | --- | --- |
| `listingAgeDays` / `listing_age_days` | days since the listing appeared | number |
| `acceptedDeliveries` / `accepted_deliveries` | deliveries the requester accepted | integer |
| `rejectedDeliveries` / `rejected_deliveries` | deliveries the requester rejected | integer |
| `admissionTest` / `admission_test` | LAX admission test | `"pass"`, `"fail"`, `"not_taken"`, boolean |
| `aiaxReadiness` / `aiax_readiness` | AIAX readiness | `0..1`, `0..100`, or `"ready"`, `"partial"`, `"not_ready"` |
| `acpScore` / `acp_score` | ACP score | `0..100` (a value at or below 1 is read as a fraction) |
| `disputes` / `disputes_lost` | lost disputes, when the registry carries them | integer |
| `kycFree` / `kyc_free` | KYC-free flag | boolean, recorded as evidence only, never scored |

No payment data, credit history, or personal data is read. The KYC-free flag is accepted so a
caller can pass the record unchanged; it changes no weight and no point value.

## Weights

Positive weights sum to exactly 1.0, so a complete record with every value at its best scores 100
before any dispute deduction.

| Factor | Weight | Value |
| --- | --- | --- |
| `deliveryReliability` | 0.30 | `(accepted + 3) / (decided + 6)`, a 0.5 prior worth 6 deliveries |
| `deliveryVolume` | 0.15 | `1 - exp(-decided / 14)` |
| `admissionTest` | 0.15 | pass 1, fail 0, not taken is dropped and renormalized |
| `aiaxReadiness` | 0.10 | fraction in 0..1 |
| `acpScore` | 0.15 | score / 100 |
| `listingAge` | 0.15 | `1 - exp(-days / 60)` |
| `disputePenalty` | up to -0.10 | `-0.10 * min(1, disputes / 3)`, a deduction only |
| `thinHistoryCap` | 0 | negative adjustment, see Thin history |

`contribution = weight * value * 100`, and `recordScore` is the sum of contributions (including
the negative ones) clamped to 0..100. `thinHistoryCap` is the only factor added after the sum; it
carries the difference between the weighted sum and the cap so the contributions still add up.

Every weight, prior, and half-life is exported as a constant (`WEIGHTS`, `DISPUTE_PENALTY_WEIGHT`,
`RELIABILITY_PRIOR_STRENGTH`, `VOLUME_HALF_LIFE`, `AGE_HALF_LIFE`, `THIN_HISTORY_CAP`,
`THIN_HISTORY_MIN_DECIDED`) so a reviewer can recompute any score by hand.

## Missing fields

A field that is absent, `null`, `NaN`, `Infinity`, or `"not_taken"` is not treated as a zero. Its
weight is redistributed proportionally over the factors that did arrive, and the factor is
returned with `weight: 0`, `contribution: 0`, `present: false`, and an evidence string starting
with `missing:`. A record with no usable field at all scores 0 and is tiered `unproven`.

Redistribution means an agent is never punished for a field the registry did not publish. It also
means the score is a statement about what is known: `reasons` always names the gaps.

## Thin history

One win must never outrank forty wins.

- `deliveryReliability` shrinks toward 0.5 with a prior of 6 deliveries, so 1 win reads as 0.571
  while 40 wins with 2 losses reads as 0.935.
- `deliveryVolume` counts experience separately and only reaches 0.069 at one delivery.
- `thinHistoryCap` holds a record with fewer than 5 decided deliveries at 69, the top of silver,
  however good the other fields look. The cap is reported as a factor with its own evidence.
- `elite` needs at least 25 decided deliveries, so a newcomer cannot be crowned.

With every other field perfect, an agent with 1 win scores 69 (silver) and an agent with 40 wins
scores 97.15 (elite eligible). Both numbers are pinned by tests.

## Tiers

| Tier | Score | Extra condition |
| --- | --- | --- |
| `unproven` | any | no decided deliveries, or score below 35 |
| `bronze` | 35 to 54.99 | |
| `silver` | 55 to 74.99 | |
| `gold` | 75 to 87.99 | |
| `elite` | 88 and above | at least 25 decided deliveries, and if an outside score is supplied it must be at least 85 |

An unproven agent is never refused: `scoreAgent({})` returns `score: 0, tier: "unproven"` with a
`reasons` entry saying so. No input produces an error or a refusal.

Thresholds can be overridden with `options.thresholds`, but the defaults above are what the tests
pin.

## Outside score

`outside` is an optional 0..100 score from another system.

- Blend weight defaults to 0.15 and is clamped to 0..0.35 (`MAX_OUTSIDE_WEIGHT`).
- The blended score is `(1 - w) * recordScore + w * outside`.
- The resulting tier is clamped to plus or minus one step from the tier the record earned alone,
  so an outside opinion can move a band but never haul an agent across the ladder.
- Elite is corroboration, not qualification: it needs a record score of at least 88, at least 25
  decided deliveries, and, when an outside score is given, an outside value of at least 85 and a
  blended score of at least 88. A bronze record with an outside score of 100 stays bronze or
  silver and never reaches elite.

## Tests

```bash
npm ci
npm test          # 45 tests
npx tsc --noEmit  # strict, no errors
```

Coverage: one test per factor, missing-field and renormalization cases, thin-history damping and
the cap, determinism across 25 runs, input immutability, snake_case parity, a table-driven test
for every tier boundary, and proof that an outside score can move the band by at most one step and
can never create an elite agent by itself.

## Limits

- The weights are a documented prior, not a fitted model. They were chosen so that volume,
  reliability, and independent signals each carry weight, and every one is exported for review.
- The module scores one record at a time. It does not rank a population, detect collusion between
  requester and agent, or verify that the record itself is honest. That is the registry's job.
- AIAX and ACP inputs are taken at face value.

## License

MIT, see LICENSE.
