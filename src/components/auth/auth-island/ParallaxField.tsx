// src/components/auth/auth-island/ParallaxField.tsx
export function ParallaxField() {
  return (
    <div className="rw-field" aria-hidden="true">
      <div className="rw-field-wash" />
      <div className="rw-blob b1" />
      <div className="rw-blob b2" />
      <div className="rw-blob b3" />
      <div className="rw-blob b4" />

      <div className="rw-pcard p1">
        <div className="rw-pcard-stars">★★★★★</div>
        <div className="rw-pcard-bar" />
        <div className="rw-pcard-bar short" />
        <div className="rw-pcard-reply">
          <div className="rw-pcard-bar tealish" />
          <div className="rw-pcard-bar tealish short" />
        </div>
      </div>
      <div className="rw-pcard p2">
        <div className="rw-pcard-stars">★★★★☆</div>
        <div className="rw-pcard-bar" />
        <div className="rw-pcard-bar" />
        <div className="rw-pcard-bar short" />
      </div>
      <div className="rw-pcard p3">
        <div className="rw-pcard-stars">★★★★★</div>
        <div className="rw-pcard-bar" />
        <div className="rw-pcard-bar short" />
      </div>
      <div className="rw-pcard p4">
        <div className="rw-pcard-stars">★★★★★</div>
        <div className="rw-pcard-bar" />
        <div className="rw-pcard-bar short" />
        <div className="rw-pcard-reply">
          <div className="rw-pcard-bar tealish" />
        </div>
      </div>

      <div className="rw-chip c1"><span className="dot" /> New 5★ from Marisol B.</div>
      <div className="rw-chip c2"><span className="dot" /> Reply posted to Google</div>
    </div>
  );
}
