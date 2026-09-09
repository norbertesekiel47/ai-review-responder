# Content generation

Use this workflow with an assistant, a designer, or a production tool. Start a project from the [creative brief](../templates/creative-brief.md), then load only the context needed for that deliverable.

| Deliverable | Context pack |
|---|---|
| Copy, social, email, or deck | [Brand kit](../brand-kit/BRAND-KIT.md), [story and voice](../brand-guidelines/brand-story.md), [claim evidence](../brand-guidelines/positioning.md), completed brief |
| Still image or graphic | Copy pack plus the actual logo/media, chosen [Style Reference](../design-systems/README.md), dimensions and placement |
| Product UI | [System router](../design-systems/README.md), matching Style Reference and tokens; Landing also requires measurements |
| Video | Copy/visual pack, script and shot list, asset references, actual product journey evidence for demonstrations, caption/audio requirements |

For an external project, upload the actual documents and assets. Repository links alone do not provide context. Record the source revision/date, and replace stale uploads after brand changes. The archived Claude setup is historical; this workflow does not depend on one vendor or subscription.

## Reusable instruction

> Create the deliverable in the attached brief for RepWorth. Use the attached current brand kit, positioning, and story. For visuals, follow the single selected Style Reference and reuse the supplied real assets. Use the brief's evidence to distinguish implemented behavior, verified availability, and future concepts. Do not invent customer proof or missing product UI. Identify unresolved claims and missing inputs in your handoff. Return the deliverable with the source assets, claims, and revisions used.

## From brief to reusable asset

1. State the audience, channel, one message, CTA, dimensions/duration, format, and success criterion. Link references by catalog ID or durable path.
2. Select one visual system. Campaign media has no automatic system assignment: choose intentionally in the brief. A depiction of product UI follows that UI's actual system.
3. Gather evidence for product claims. When evidence is missing, omit the claim or label the concept; do not fill the gap with plausible numbers or remembered availability.
4. Draft, review against the brief, and keep text editable. For images/video, reuse existing paid/source assets where appropriate; preserve prompts, inputs, edits, and generation settings when known.
5. Check voice, visual consistency, legibility, contrast, crops, captions, and claim accuracy at the intended size. Product demonstrations need the actual current journey and correctly labeled data/environment.
6. Save the reviewed final and its editable source to the production project. Register reusable outputs and derivatives in the [catalog](../digital-asset-management/README.md), with their review status and provenance.

The library is reference and production context. Publishing or distributing a deliverable is a separate action from drafting and cataloging it.
