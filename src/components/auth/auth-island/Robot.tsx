// src/components/auth/auth-island/Robot.tsx
export function Robot() {
  return (
    <div className="rw-robot-track" aria-hidden="true">
      <div className="rw-robot">
        <div className="rw-robot-shadow" />
        <svg viewBox="0 0 80 90" xmlns="http://www.w3.org/2000/svg">
          <line x1="40" y1="6" x2="40" y2="14" stroke="#6a6a6a" strokeWidth="2" strokeLinecap="round" />
          <circle cx="40" cy="5" r="3" fill="#F2C3B9" />
          <rect x="18" y="14" width="44" height="34" rx="10" fill="#fff" stroke="#97B3AE" strokeWidth="2" />
          <rect x="24" y="20" width="32" height="20" rx="6" fill="#F0EEEA" />
          <g className="rw-robot-eyes">
            <circle cx="33" cy="30" r="2.6" fill="#2a2a2a" />
            <circle cx="47" cy="30" r="2.6" fill="#2a2a2a" />
          </g>
          <path d="M33 35 Q40 39 47 35" stroke="#97B3AE" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <rect x="22" y="48" width="36" height="26" rx="8" fill="#97B3AE" />
          <rect x="28" y="54" width="24" height="3" rx="1.5" fill="rgba(255,255,255,0.5)" />
          <circle cx="32" cy="64" r="2" fill="#F2C3B9" />
          <circle cx="40" cy="64" r="2" fill="#F0DDD6" />
          <circle cx="48" cy="64" r="2" fill="#fff" />
          <g className="rw-robot-arm-l"><rect x="12" y="50" width="6" height="16" rx="3" fill="#97B3AE" /></g>
          <g className="rw-robot-arm-r"><rect x="62" y="50" width="6" height="16" rx="3" fill="#97B3AE" /></g>
          <g className="rw-robot-leg-l"><rect x="28" y="74" width="8" height="10" rx="2" fill="#6a6a6a" /></g>
          <g className="rw-robot-leg-r"><rect x="44" y="74" width="8" height="10" rx="2" fill="#6a6a6a" /></g>
        </svg>
        <div className="rw-robot-bubble">★★★★★ replied!</div>
      </div>
    </div>
  );
}
