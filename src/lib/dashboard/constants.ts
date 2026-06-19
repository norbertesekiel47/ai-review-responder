/**
 * Minutes saved for each AI-drafted response an owner approves. A product
 * heuristic powering the "time saved" value metric.
 *
 * Single source of truth: the lifetime figure (service-mappers `buildValueSummary`)
 * and the windowed 30-day figure (reputation summary, PLAN.md PR2) must derive
 * from this one constant so they can never drift.
 */
export const MINUTES_SAVED_PER_RESPONSE = 7;
