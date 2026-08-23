import { AgentFlipCard } from 'repworth';
import { INLINED_ASSETS } from '../.cache/assets';

// Card copy is the real thing, lifted from the landing page's own copy modules
// (personas-copy.ts, watchdogs-copy.ts).
//
// Two composition notes:
//  · The card is `.rw-lp-glass` — translucent, with light type. It is only ever
//    rendered on the landing page's dark sections, so a card must supply that
//    ground or the name and tagline disappear.
//  · Avatars come from the inlined poster map. The matching .mp4 clips are far
//    too large to inline, so the still is what paints; that is also the
//    reduced-motion render in production.
const poster = (id: string) => INLINED_ASSETS[`/agents/${id}.jpg`] ?? '';

const Night = ({ children }: { children: React.ReactNode }) => (
  <div style={{ padding: '1.5rem', background: 'var(--rw-ink, #15191a)', borderRadius: '1.25rem', maxWidth: 300 }}>
    {children}
  </div>
);

export const Persona = () => (
  <Night>
    <AgentFlipCard
      name="Reply"
      tagline="Every review gets a response, in your voice."
      duties="The workhorse. It drafts a reply to every new review as it lands, not just the easy ones, and matches how you actually talk. On Autopilot it can post the safe, positive ones by itself, inside the rating band and daily cap you set."
      videoSrc=""
      posterSrc={poster('reply')}
      chip="Publishes inside your bounds"
      chipTone="gold"
    />
  </Night>
);

export const Watchdog = () => (
  <Night>
    <AgentFlipCard
      name="Judge"
      tagline="Reviews the machine’s work, not yours."
      duties="Every reply that posts without you is independently assessed afterwards by a separate AI check that had no hand in writing it. Verdicts are recorded, and a run of poor ones is what the Governor watches for."
      videoSrc=""
      posterSrc={poster('judge')}
      chip="Reviews 100% of auto-posts"
      chipTone="teal"
      tier="watchdog"
    />
  </Night>
);

export const NotYetShipped = () => (
  <Night>
    <AgentFlipCard
      name="Solicitor"
      tagline="Asking your customers, so more reviews arrive."
      duties="Most tools only react to whatever arrives. Solicitor will ask your real customers for reviews in managed batches, so volume and recency keep climbing. Consent is checked first, every opt-out is honoured, and it never posts anything publicly."
      videoSrc=""
      posterSrc={poster('solicitor')}
      chip="Outbound only, never posts"
      chipTone="gold"
      status="next"
      statusTag="Coming next"
    />
  </Night>
);
