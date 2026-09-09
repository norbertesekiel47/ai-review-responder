import React from 'react';
import { AbsoluteFill, Composition, registerRoot, useCurrentFrame, useVideoConfig } from 'remotion';
type Props = { dark: boolean; kind: string };
// All motion uses a complete six-second phase; repeat without a fade or camera cut.
function Abstract({ dark, kind }: Props) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const phase = frame / durationInFrames * Math.PI * 2;
  const ground = dark ? '#14201c' : '#f6f6f2';
  const ink = dark ? '#dcc489' : '#2e5b4f';
  const paper = dark ? '#263b32' : '#ffffff';
  return <AbsoluteFill style={{ background: ground }}><svg viewBox="0 0 1920 1080" width="1920" height="1080">
    {kind === 'orbit' && <g transform="translate(1430 620)">{[0, 1, 2].map((i) => <g key={i} transform={`rotate(${i * 57 + Math.sin(phase) * 7})`}><ellipse rx={245 + i * 42} ry={125 + i * 12} fill="none" stroke={ink} strokeWidth={2} opacity={.32 + i * .18} /><circle cx={(245 + i * 42) * Math.cos(phase + i * 2)} cy={(125 + i * 12) * Math.sin(phase + i * 2)} r={7 - i} fill={ink} /></g>)}</g>}
    {kind === 'paper-flow' && [0, 1, 2, 3].map((i) => <path key={i} d={`M-100 ${920 + i * 50}C400 ${720 + i * 60 + Math.sin(phase + i) * 24} 940 ${1100 - i * 60} 1390 ${700 + i * 60}S1910 ${430 + Math.cos(phase + i) * 32} 2050 ${660 + i * 60}V1200H-100Z`} fill={i % 2 ? ground : paper} stroke={ink} strokeWidth="1" strokeOpacity=".24" />)}
    {kind === 'signal' && <g transform="translate(1440 570)">{[0, 1, 2].map((i) => { const p = (frame / durationInFrames + i / 3) % 1; return <circle key={i} r={50 + p * 295} stroke={ink} strokeWidth="2" fill="none" opacity={Math.sin(p * Math.PI) * .55} />; })}<circle r="15" fill={ink} opacity={.8 + Math.sin(phase) * .2} /></g>}
  </svg></AbsoluteFill>;
}
registerRoot(() => <Composition id="Abstract" component={Abstract} width={1920} height={1080} fps={24} durationInFrames={144} defaultProps={{ dark: false, kind: 'orbit' }} />);
