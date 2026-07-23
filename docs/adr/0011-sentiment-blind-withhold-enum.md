# Sentiment-blind withhold enum: `recent_negative` rejected permanently

The Solicitation restraint policy decides, per candidate, send vs
withhold-with-reason. The obvious product instinct — "don't ask customers who
just had a bad experience" (`recent_negative`) — is permanently excluded from
the withhold-reason enum, in watch-mode and in every future mode. Google's
fake-engagement policy bans merchants who "selectively solicit positive
reviews from customers," and the #531 research locked that this binds the
*selection algorithm* even when nothing is sent: a withhold list that filters
out known-negatives is a sentiment-screened ask queue, and the spoilage
report would literally display "withheld: they were unhappy" as a feature.
FTC 16 CFR § 465.7 (review suppression) is the downstream form of the same
conduct.

The legitimate overlap is covered by the sentiment-blind neighbor
`already_reviewed` (contact already left a review — **any** rating), and its
evidence deliberately carries `review_id` + `review_date` but **never the
star rating**: a rating-annotated withhold list would rebuild the gating
artifact through the display layer.

Consequence: every reason in the closed enum (`no_consent`, `suppressed`,
`already_reviewed`, `stale_visit`, `over_contacted`, `velocity_banked`) must
be justifiable from consent, opt-out, existence-of-review, recency,
frequency, or volume — never from sentiment, predicted or known. A future PM
asking "why don't we skip angry customers?" gets this ADR as the answer.

Spec: `docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md`.
