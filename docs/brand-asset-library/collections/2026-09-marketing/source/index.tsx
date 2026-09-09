import React, { useEffect, useState } from 'react';
import { AbsoluteFill, Composition, Img, continueRender, delayRender, interpolate, registerRoot, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import content from './content.json';

type Theme = { ground: string; paper: string; ink: string; accent: string; watch: string; line: string; muted: string };
type Props = { theme: 'light' | 'dark'; colors: Theme; kind: string; item?: string; title?: string; subtitle?: string; transparent?: boolean };
const ease = (x: number) => 1 - Math.pow(1 - x, 3);
const reveal = (frame: number, start = 0, span = 18) => interpolate(frame, [start, start + span], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
const fontStyle = `@font-face{font-family:DM;src:url('${staticFile('fonts/dm-sans-latin.woff2')}')}@font-face{font-family:Jakarta;src:url('${staticFile('fonts/plus-jakarta-sans-latin.woff2')}')}@font-face{font-family:Mono;src:url('${staticFile('fonts/jetbrains-mono-latin.woff2')}')}`;

function Mark({ size = 50 }: { size?: number }) {
  return <Img src={staticFile('logo.svg')} style={{ width: size, height: size, objectFit: 'contain' }} />;
}

function Brand({ colors, small = false }: { colors: Theme; small?: boolean }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: small ? 14 : 20, color: colors.ink }}><Mark size={small ? 38 : 52} /><span style={{ fontSize: small ? 22 : 28, letterSpacing: '0.15em', fontWeight: 400 }}>REPWORTH</span></div>;
}

function Arrow({ colors, size = 56 }: { colors: Theme; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 60 60" fill="none"><circle cx="30" cy="30" r="29" stroke={colors.accent} /><path d="M18 30h24M32 20l10 10-10 10" stroke={colors.accent} strokeWidth="2" /></svg>;
}

function Eyebrow({ children, colors }: { children: React.ReactNode; colors: Theme }) {
  return <div style={{ fontFamily: 'inherit', fontSize: 18, color: colors.muted, display: 'flex', gap: 14, alignItems: 'center' }}><span style={{ width: 28, height: 3, background: colors.accent }} />{children}</div>;
}

function Fonts() {
  const [handle] = useState(() => delayRender('Loading brand fonts'));
  useEffect(() => { Promise.all(['DM', 'Jakarta', 'Mono'].map((family) => document.fonts.load(`400 32px ${family}`))).then(() => continueRender(handle)); }, [handle]);
  return <style>{fontStyle}</style>;
}

function Backdrop({ theme, colors }: Pick<Props, 'theme' | 'colors'>) {
  return <><AbsoluteFill style={{ background: colors.ground }} /><Img src={staticFile(theme === 'light' ? 'backgrounds/light-01-architecture.png' : 'backgrounds/dark-01-folded-paper.png')} style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', opacity: theme === 'light' ? 0.32 : 0.5 }} /></>;
}

function Footer({ colors, label, compact = false }: { colors: Theme; label: string; compact?: boolean }) {
  return <div style={{ position: 'absolute', bottom: compact ? 65 : 72, left: 72, right: 72, borderTop: `1px solid ${colors.line}`, paddingTop: 23, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 24, fontSize: 18, color: colors.muted }}><span>{label}</span><span>{content.site}</span></div>;
}

function Social(props: Props) {
  const { width, height } = useVideoConfig();
  const { colors, theme } = props;
  const item = content.social.find((s) => s.id === props.item) ?? content.social[0];
  if (!item) throw new Error('The marketing collection needs at least one social layout.');
  const tall = height > width * 1.5;
  const square = width === height;
  const frame = useCurrentFrame();
  const enter = reveal(frame);
  const isFeature = item.id === 'feature';
  const top = tall ? 170 : 76;
  return <AbsoluteFill style={{ fontFamily: theme === 'light' ? 'DM' : 'Jakarta', color: colors.ink, fontWeight: theme === 'light' ? 400 : 300 }}>
    <Fonts /><Backdrop {...props} />
    <div style={{ position: 'absolute', left: 72, right: 72, top }}><Brand colors={colors} /><div style={{ height: tall ? 145 : square ? 85 : 125 }} /><Eyebrow colors={colors}>{item.kicker}</Eyebrow>
      <div style={{ opacity: enter, transform: `translateY(${(1 - enter) * 24}px)` }}><h1 style={{ margin: '32px 0 28px', fontSize: item.id === 'principle' ? 86 : 88, fontWeight: 'inherit', lineHeight: 1.08, whiteSpace: 'pre-line', maxWidth: 925 }}>{props.title ?? item.headline}</h1><p style={{ margin: 0, fontSize: 29, lineHeight: 1.5, color: colors.muted, whiteSpace: 'pre-line', maxWidth: isFeature ? 475 : 805 }}>{props.subtitle ?? item.body}</p></div>
    </div>
    {isFeature && <div style={{ position: 'absolute', right: 68, bottom: tall ? 350 : square ? 165 : 180, width: square ? 300 : 420, height: square ? 300 : 420, borderRadius: 28, overflow: 'hidden', border: `1px solid ${colors.line}` }}><Img src={staticFile('agents/reply.jpg')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>}
    {item.id === 'workflow' && <div style={{ position: 'absolute', left: 72, right: 72, bottom: tall ? 345 : 165, display: 'flex', flexDirection: tall ? 'column' : 'row', gap: 12 }}>{content.workflow.map((step, i) => <div key={step} style={{ flex: 1, background: colors.paper, padding: tall ? '24px 30px' : '25px 18px', border: `1px solid ${colors.line}`, borderRadius: 14, display: tall ? 'flex' : 'block', gap: 24, alignItems: 'center' }}><span style={{ fontFamily: theme === 'light' ? 'DM' : 'Mono', fontSize: 17, color: colors.accent }}>0{i + 1}</span><div style={{ fontSize: 22, marginTop: tall ? 0 : 26 }}>{step}</div></div>)}</div>}
    {['statement', 'principle', 'update'].includes(item.id) && <div style={{ position: 'absolute', left: 72, bottom: tall ? 330 : 185 }}><Arrow colors={colors} size={72} /></div>}
    <Footer colors={colors} label={item.footer} compact={tall} />
  </AbsoluteFill>;
}

function Agent(props: Props) {
  const { colors, theme } = props;
  const { width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  const a = content.agents.find((v) => v.id === props.item) ?? content.agents[0];
  if (!a) throw new Error('The marketing collection needs at least one agent.');
  const landscape = width > height;
  const ink = a.kind === 'watchdog' ? colors.watch : colors.accent;
  const visualSize = landscape ? 630 : 530;
  const enter = reveal(frame, 4, 22);
  return <AbsoluteFill style={{ background: colors.ground, color: colors.ink, fontFamily: theme === 'light' ? 'DM' : 'Jakarta', fontWeight: theme === 'light' ? 400 : 300 }}><Fonts /><Backdrop {...props} />
    <div style={{ position: 'absolute', top: 70, left: 72 }}><Brand colors={colors} /></div>
    <div style={{ position: 'absolute', width: visualSize, height: visualSize, right: landscape ? 100 : 72, top: landscape ? 170 : 180, overflow: 'hidden', borderRadius: 32, border: `1px solid ${colors.line}`, opacity: enter, transform: `translateY(${(1 - enter) * 25}px)` }}><Img src={staticFile(`agents/${a.id}.jpg`)} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${1.025 - 0.025 * enter})` }} /></div>
    <div style={{ position: 'absolute', left: 72, top: landscape ? 285 : 780, maxWidth: landscape ? 850 : 925, opacity: reveal(frame, 15) }}><Eyebrow colors={{ ...colors, accent: ink }}>{a.role}</Eyebrow><h1 style={{ fontSize: landscape ? 142 : 105, margin: '28px 0 28px', lineHeight: 1, fontWeight: 'inherit' }}>{a.name}.</h1><div style={{ fontSize: landscape ? 40 : 32, lineHeight: 1.35, maxWidth: 780 }}>{a.line}</div><div style={{ fontSize: 23, lineHeight: 1.5, marginTop: 24, color: colors.muted, maxWidth: 770 }}>{a.detail}</div></div><Footer colors={colors} label={a.kind === 'watchdog' ? 'Independent supervision' : 'One agent. One clear job.'} />
  </AbsoluteFill>;
}

function Motion(props: Props) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const { colors, kind, theme } = props;
  const end = interpolate(frame, [durationInFrames - 15, durationInFrames - 1], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const generic = <><div style={{ position: 'absolute', top: 64, left: 80 }}><Brand colors={colors} /></div><Footer colors={colors} label={['workflow', 'escalation', 'report', 'map-route'].includes(kind) ? 'Illustrative concept · Not a product recording' : 'Reputation work, within your rules'} /></>;
  return <AbsoluteFill style={{ fontFamily: theme === 'light' ? 'DM' : 'Jakarta', color: colors.ink, fontWeight: theme === 'light' ? 400 : 300, background: props.transparent ? 'transparent' : colors.ground }}><Fonts />{!props.transparent && <Backdrop {...props} />}
    <AbsoluteFill style={{ opacity: end }}>
      {kind === 'logo-intro' || kind === 'logo-outro' ? <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 35, opacity: reveal(frame, 0, 24), transform: `scale(${0.96 + 0.04 * reveal(frame, 0, 24)})` }}><Mark size={150} /><span style={{ fontSize: 76, letterSpacing: '0.15em', marginLeft: '0.15em' }}>REPWORTH</span><div style={{ fontSize: 34, opacity: reveal(frame, 30), color: colors.muted }}>{kind === 'logo-outro' ? 'See how RepWorth works.' : 'The work. The rules. The record.'}</div>{kind === 'logo-outro' && <div style={{ fontFamily: theme === 'light' ? 'DM' : 'Mono', fontSize: 24, opacity: reveal(frame, 44) }}>{content.site}</div>}</AbsoluteFill> : generic}
      {kind === 'typography' && <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'flex-start', paddingLeft: 160 }}>{content.typography.map((line, i) => { const active = frame >= i * 48 && frame < (i + 1) * 48; return active && <div key={line} style={{ fontSize: 175, opacity: reveal(frame, i * 48, 12), transform: `translateY(${(1 - reveal(frame, i * 48, 12)) * 28}px)` }}>{line}</div>; })}</AbsoluteFill>}
      {kind === 'workflow' && <><div style={{ position: 'absolute', top: 230, left: 90, fontSize: 68 }}>A clear path from review to reply.</div><div style={{ position: 'absolute', left: 90, right: 90, top: 430, display: 'flex', gap: 24 }}>{content.workflow.map((step, i) => { const a = reveal(frame, 12 + i * 28); return <div key={step} style={{ flex: 1, height: 235, background: colors.paper, borderRadius: 22, padding: 30, border: `1px solid ${colors.line}`, opacity: a, transform: `translateY(${(1 - a) * 22}px)` }}><span style={{ color: colors.accent, fontFamily: theme === 'light' ? 'DM' : 'Mono', fontSize: 22 }}>0{i + 1}</span><div style={{ fontSize: 35, marginTop: 55 }}>{step}</div></div>; })}</div></>}
      {kind === 'escalation' && <><div style={{ position: 'absolute', left: 100, top: 240, width: 760, fontSize: 85, lineHeight: 1.15 }}>Some things<br />need your attention.</div><div style={{ position: 'absolute', top: 310, right: 110, width: 690, border: `1px solid ${colors.line}`, borderRadius: 24, background: colors.paper, padding: 42, opacity: reveal(frame, 20) }}><Eyebrow colors={colors}>Guardian / exception surfaced</Eyebrow><div style={{ fontSize: 45, margin: '35px 0' }}>Owner review needed</div><div style={{ color: colors.muted, fontSize: 28 }}>An exception reaches a person.<br />Guardian never acts publicly.</div></div></>}
      {kind === 'report' && <><div style={{ position: 'absolute', top: 215, left: 95, fontSize: 83, lineHeight: 1.12 }}>What was handled.<br />What needs you.</div><div style={{ position: 'absolute', right: 105, top: 220, width: 690, padding: 40, borderRadius: 22, border: `1px solid ${colors.line}`, background: colors.paper }}><Eyebrow colors={colors}>The weekly perspective</Eyebrow>{['Drafts prepared', 'Awaiting your approval', 'Exceptions surfaced'].map((s, i) => <div key={s} style={{ padding: '35px 0', borderBottom: `1px solid ${colors.line}`, fontSize: 31, opacity: reveal(frame, 16 + i * 25), transform: `translateX(${(1 - reveal(frame, 16 + i * 25)) * 20}px)` }}>{s}</div>)}</div></>}
      {kind === 'map-route' && <><div style={{ position: 'absolute', top: 210, left: 100, fontSize: 65 }}>One connected journey.</div><svg style={{ position: 'absolute', left: 90, top: 410, width: 1740, height: 300 }} viewBox="0 0 1740 300"><path d="M70 210C350 210 260 40 580 90S1010 290 1230 100 1500 50 1660 80" fill="none" stroke={colors.accent} strokeWidth="4" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - reveal(frame, 15, 100)} />{([[70,210],[580,90],[1120,167],[1660,80]] as const).map(([x,y],i)=><g key={i} opacity={reveal(frame,20+i*30)}><circle cx={x} cy={y} r="12" fill={colors.accent}/><text x={x} y={y+50} textAnchor={i===3?'end':i===0?'start':'middle'} fill={colors.ink} fontSize="26" fontFamily="DM">{['Replies','Requests','Weekly brief','Future concept'][i]}</text></g>)}</svg></>}
    </AbsoluteFill>
  </AbsoluteFill>;
}

const fallback: Theme = { ground: '#14201c', paper: '#1b2c25', ink: '#f4f2ec', accent: '#dcc489', watch: '#a9c6c0', line: '#3b4a43', muted: '#b8c0b8' };
const defaults: Props = { theme: 'dark', colors: fallback, kind: 'statement' };
function Root() {
  return <><Composition id="SocialSquare" component={Social} width={1080} height={1080} fps={24} durationInFrames={144} defaultProps={defaults} /><Composition id="SocialPortrait" component={Social} width={1080} height={1350} fps={24} durationInFrames={144} defaultProps={defaults} /><Composition id="SocialStory" component={Social} width={1080} height={1920} fps={24} durationInFrames={144} defaultProps={defaults} /><Composition id="AgentStill" component={Agent} width={1080} height={1350} fps={24} durationInFrames={144} defaultProps={defaults} /><Composition id="AgentMotion" component={Agent} width={1920} height={1080} fps={24} durationInFrames={144} defaultProps={defaults} /><Composition id="BrandMotion" component={Motion} width={1920} height={1080} fps={24} durationInFrames={144} defaultProps={defaults} /></>;
}
registerRoot(Root);
