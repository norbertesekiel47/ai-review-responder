# Deviations — refactor-channel-route-unification

Notes on things the locked plan did not anticipate. No deviation from the plan's
instructions was taken; each entry records an observation for the plan owner.

## Task 1 — spec §4.5 residual contradiction (observation, not a deviation)

Step 3 replaced only the **first** §4.5 bullet, exactly as the plan quotes. The
replacement's third new bullet says:

> There are no existing owner `cancel`/`disable` tests for the `no_account`
> condition, so §4.3's change is covered by **new** tests, not updated ones.

The section's pre-existing **last** bullet was left untouched by the plan and now
reads against it:

> Update the owner `cancel`/`disable` tests for the 404 change (§4.3).

Both are now in §4.5. If the intent was for the new bullet to supersede the old
one, the trailing bullet should be dropped in a later task (T7 or T8's doc sweep)
— but that is outside Task 1's `allowed_edit_surface`, so it was left as-is.

**VERDICT: ACCEPT** (orchestrator, immediately after T1). The catch is correct and
the contradiction was real — the plan's Task 1 Step 3 quoted only the first bullet
for replacement and did not notice the trailing one said the opposite. Resolved in
place rather than deferred to T8, because a spec that contradicts itself is
precisely the defect class this whole PR exists to fix, and leaving it live risks a
later task following the stale bullet.

The stale `Update the owner cancel/disable tests for the 404 change (§4.3)` bullet
is replaced by two bullets naming the coverage the round-1/2 plan reviews added and
the spec had never mentioned: the runner **transaction protocol** (unpinned by
anything in the repo today) and the admin **binding** posture (§4.2), including the
fact that admin Telegram `start` has no inactive-subscription test today while
WhatsApp `start` does. §4.5 now matches the plan's Task 2 + Task 2b.

No intake field changed; `allowed_edit_surface` already covers the spec file, so
this is a deviations entry and not an amendment.
