import React from 'react';
import { AbsoluteFill, Composition, Img, interpolate, registerRoot, staticFile, useCurrentFrame } from 'remotion';
import content from './content.json';

const landmarks = [
  { file: 'cottage', x: 260, y: 455, size: 285, start: 15 },
  { file: 'watchtower', x: 575, y: 225, size: 285, start: 55 },
  { file: 'mailbox', x: 850, y: 485, size: 255, start: 95 },
  { file: 'newsstand', x: 1130, y: 390, size: 270, start: 135 },
  { file: 'lighthouse', x: 1440, y: 220, size: 290, start: 175 },
];
const progress = (frame: number, start: number, duration = 24) => interpolate(frame, [start, start + duration], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: (t: number) => 1 - (1 - t) ** 3 });
function MapAssembly({ night = false }: { night?: boolean }) {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ background: '#14201c', fontFamily: 'Georgia, serif' }}>
    <AbsoluteFill style={{ transform: `scale(${1 + frame / 288 * .018})` }}>
      <Img src={staticFile(`maps/map-${night ? 'night' : 'day'}-blank.png`)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      <svg viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}><path d="M405 700C540 700 530 495 720 480S820 730 980 705 1040 640 1265 625 1460 540 1585 475" stroke="#b48943" strokeWidth="12" opacity=".35" fill="none" /><path d="M405 700C540 700 530 495 720 480S820 730 980 705 1040 640 1265 625 1460 540 1585 475" stroke="#ffe1a2" strokeWidth="6" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - progress(frame, 25, 185)} /></svg>
      {landmarks.map((p, i) => { const visible = progress(frame, p.start); return <div key={p.file} style={{ position: 'absolute', left: p.x, top: p.y, width: p.size, opacity: visible, transform: `translateY(${(1 - visible) * 24}px) scale(${.94 + .06 * visible})`, transformOrigin: 'bottom center' }}>
        <Img src={staticFile(`maps/props/${p.file}.png`)} style={{ width: p.size, height: p.size, objectFit: 'contain', filter: 'drop-shadow(9px 13px 9px rgba(43,30,13,.22))' }} />
        <div style={{ fontSize: 29, color: '#302b20', background: 'rgba(243,226,192,.94)', padding: '8px 10px', border: '1px solid rgba(73,55,29,.25)', textAlign: 'center', marginTop: -9 }}>{content.mapLabels[i]}</div>
      </div>; })}
      <Img src={staticFile('maps/props/cloud.png')} style={{ position: 'absolute', left: 990 + frame * .07, top: 125, width: 245, opacity: .62 }} />
      <Img src={staticFile('maps/props/airship.png')} style={{ position: 'absolute', left: 380 + frame * .22, top: 155 + Math.sin(frame / 48) * 4, width: 170, opacity: progress(frame, 0, 35) }} />
    </AbsoluteFill>
    <div style={{ position: 'absolute', left: 265, bottom: 119, color: '#3d3224', fontSize: 22, opacity: progress(frame, 205) }}>RepWorth · An illustrative reputation journey</div>
  </AbsoluteFill>;
}
registerRoot(() => <Composition id="MapAssembly" component={MapAssembly} width={1920} height={1080} fps={24} durationInFrames={288} defaultProps={{ night: false }} />);
