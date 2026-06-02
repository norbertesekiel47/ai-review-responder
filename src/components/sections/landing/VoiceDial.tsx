'use client';

import { Fragment, useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';

const LABELS = ['Warm', 'Friendly', 'Balanced', 'Polished', 'Crisp'] as const;
const SAMPLES = [
  `Hey Rachel! Ohhh this message made our whole day. So so glad the cake made your little one smile — honestly that's the whole reason we do this. Tell her we said happy birthday from all of us, and come say hi anytime.\n\n— Claire`,
  `Rachel, thank you so much. We were thrilled to pull that one together on short notice — and knowing your 7-year-old loved it is the best possible feedback. Happy belated birthday to her from all of us at the bakery.\n\n— Claire, owner`,
  `Rachel, thank you — you made our week. So glad the cake landed and that your 7-year-old loved it. Tell her happy belated birthday from the team, and come by anytime.\n\n— Claire, owner`,
  `Thank you for sharing this, Rachel. We always aim to make last-minute orders feel considered, and we're delighted the cake met the moment. Please pass along our belated birthday wishes to your daughter.\n\n— Claire, owner, Rose & Rye Bakery`,
  `Thank you for the kind note, Rachel. We appreciate you choosing us for your daughter's birthday and are pleased the cake met your expectations. We look forward to welcoming you back.\n\n— Rose & Rye Bakery`,
];

const SOURCE_TEXT =
  'Came in for a last-minute birthday cake and they completely pulled through. The cake was beautiful, tasted amazing, and my 7-year-old still talks about it. Thank you!';

export function VoiceDial() {
  const [value, setValue] = useState(2);
  const [dragging, setDragging] = useState(false);
  const dialRef = useRef<HTMLDivElement>(null);

  const onPointer = useCallback((e: { clientX: number; clientY: number }) => {
    const el = dialRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    let ang = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (ang < -135) ang = -135;
    if (ang > 135) ang = 135;
    const t = (ang + 135) / 270;
    setValue(Math.round(t * 4));
  }, []);

  const onMove = useEffectEvent((e: PointerEvent) => onPointer(e));

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => onMove(e);
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging]);

  const angle = -135 + (value / 4) * 270;

  return (
    <section className="rw-voice-section" id="rw-voice">
      <div className="rw-sec-inner" style={{ maxWidth: 1000 }}>
        <div className="rw-voice-grid">
          <div className="rw-voice-dial-wrap">
            <div
              ref={dialRef}
              className={`rw-voice-dial ${dragging ? 'dragging' : ''}`}
              onPointerDown={(e) => {
                setDragging(true);
                onPointer(e);
              }}
              aria-hidden="true"
            >
              <div className="rw-voice-ticks">
                {Array.from({ length: 5 }).map((_, i) => {
                  const a = -135 + (i / 4) * 270;
                  return (
                    <div
                      key={i}
                      className="rw-tick"
                      style={{
                        transform: `translateX(-50%) rotate(${a}deg)`,
                        background: value === i ? '#2a2a2a' : 'rgba(42,42,42,0.3)',
                      }}
                    />
                  );
                })}
              </div>
              <div
                className="rw-voice-dial-indicator"
                style={{ transform: `translateX(-50%) rotate(${angle}deg)` }}
              />
              <div className="rw-voice-dial-inner">
                <div className="rw-voice-dial-value">{LABELS[value] ?? 'Balanced'}</div>
                <div className="rw-voice-dial-value-label">Tone</div>
              </div>
            </div>
            <input
              className="sr-only"
              type="range"
              min={0}
              max={4}
              value={value}
              aria-label="Voice dial — adjust tone"
              onChange={(e) => setValue(Number(e.target.value))}
            />
            <div className="rw-voice-labels">
              {LABELS.map((l, i) => (
                <Fragment key={l}>
                  <span className={value === i ? 'active' : ''}>{l}</span>
                  {i < LABELS.length - 1 && <span className="sep">·</span>}
                </Fragment>
              ))}
            </div>
          </div>

          <div>
            <div className="rw-eyebrow">Your voice, automated</div>
            <h2 style={{ fontSize: 44, fontWeight: 600, lineHeight: 1.05, marginBottom: 16, color: 'var(--rw-ink)' }}>
              Drag to feel your brand voice.
            </h2>
            <p style={{ font: '400 17px/1.6 var(--rw-font-body)', color: 'var(--rw-ink-soft)', margin: '0 0 24px', maxWidth: 460 }}>
              RepWorth learns from the replies you approve. Most owners find their voice
              sits somewhere between warm and polished, and it stays there, on every
              review, forever. Try a few settings.
            </p>
            <div className="rw-voice-preview">
              <div className="rw-src">
                <div className="rw-src-name">Rachel K. · ★★★★★</div>
                {SOURCE_TEXT}
              </div>
              <div className="rw-reply-label">Reply · {(LABELS[value] ?? 'Balanced').toLowerCase()}</div>
              <div className="rw-reply">{SAMPLES[value] ?? ''}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
