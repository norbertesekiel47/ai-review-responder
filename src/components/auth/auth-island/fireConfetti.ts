const COLORS = ['#97B3AE', '#F2C3B9', '#F0DDD6', '#D6CBBF', '#EAB308'];

export function fireConfetti(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const layer = document.createElement('div');
  layer.className = 'rw-confetti';
  document.body.appendChild(layer);

  for (let i = 0; i < 60; i++) {
    const s = document.createElement('span');
    const angle = (Math.random() - 0.5) * Math.PI;
    const dist = 220 + Math.random() * 220;
    const dx = Math.sin(angle) * dist + (Math.random() - 0.5) * 120;
    const dy = -Math.cos(angle) * dist - 80 + Math.random() * 80;
    s.style.setProperty('--end', `translate3d(${dx}px, ${dy}px, 0)`);
    s.style.left = `${50 + (Math.random() - 0.5) * 8}%`;
    s.style.top = '60%';
    s.style.background = COLORS[i % COLORS.length] ?? COLORS[0]!;
    s.style.borderRadius = i % 3 === 0 ? '9999px' : '2px';
    s.style.animationDelay = `${Math.random() * 0.15}s`;
    layer.appendChild(s);
  }
  setTimeout(() => layer.remove(), 2200);
}
