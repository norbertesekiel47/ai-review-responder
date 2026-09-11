'use client';

import Image from 'next/image';
import { useId, useState, type CSSProperties } from 'react';
import {
  STOPS,
  EYEBROW,
  HEADING_LEAD,
  HEADING_ACCENT,
  LEAD_IN,
  CLOSING_LEAD,
  CLOSING_ACCENT,
  CLOSING_TAIL,
  type RoadmapStop,
} from './future-copy';

const CHAPTERS = [
  { state: 'shipped', number: '01', title: 'Here today', status: 'Shipped', note: 'The foundation is in place.', range: '01 — 05' },
  { state: 'planned', number: '02', title: 'The next stretch', status: 'Planned', note: 'Five phases, in this order.', range: '06 — 10' },
  { state: 'horizon', number: '03', title: 'Further ahead', status: 'Horizon', note: 'Sequenced later. The order may change.', range: '11 — 15' },
] as const;

type Chapter = (typeof CHAPTERS)[number];
interface RoadmapSelection {
  selected: RoadmapStop;
  chapter: Chapter;
  stops: readonly RoadmapStop[];
  select: (stop: RoadmapStop) => void;
  selectChapter: (chapter: Chapter) => void;
  panelId: string;
}

/** Map positions of a chapter's five stops, as % of the map's width/height. */
const ATLAS_POSITIONS = [
  { x: 12, y: 63 }, { x: 30, y: 39 }, { x: 50, y: 60 }, { x: 70, y: 30 }, { x: 88, y: 52 },
] as const;

function stopNumber(stop: RoadmapStop) {
  return String(STOPS.findIndex((item) => item.id === stop.id) + 1).padStart(2, '0');
}

function stopStatus(stop: RoadmapStop) {
  if (stop.state === 'shipped') return 'Shipped';
  if (stop.state === 'planned') return `Planned · ${stop.marker}`;
  return 'Horizon · Later';
}

function MapGround() {
  return (
    <div className="rw-lp-final-map-ground" aria-hidden="true">
      {/* The enlarged ground needs the original 3840px asset, not a viewport-sized thumbnail. */}
      <Image src="/future/roadmap-ground.jpg" alt="" fill sizes="(max-width: 760px) 100vw, 90vw" unoptimized />
    </div>
  );
}

function Compass() {
  return (
    <svg className="rw-lp-final-compass" viewBox="0 0 96 96" aria-hidden="true" fill="none">
      <circle cx="48" cy="48" r="35" />
      <circle cx="48" cy="48" r="28" strokeDasharray="1 7" />
      <path d="M48 3v17m0 56v17M3 48h17m56 0h17M48 27l8 21-8 21-8-21Z" />
      <path d="M48 27v42M27 48h42" />
    </svg>
  );
}

function Landmark({ stop }: { stop: RoadmapStop }) {
  return (
    <span className="rw-lp-final-landmark" data-state={stop.state} aria-hidden="true">
      {stop.landmark ? (
        <Image
          src={stop.landmark}
          alt=""
          width={Math.round(300 * (stop.landmarkAspect ?? 1))}
          height={300}
          sizes="(max-width: 760px) 220px, 360px"
        />
      ) : (
        <svg className="rw-lp-final-beacon" viewBox="0 0 120 120" fill="none">
          <ellipse cx="60" cy="93" rx="45" ry="12" />
          <ellipse cx="60" cy="93" rx="31" ry="8" strokeDasharray="3 5" />
          <path d="M60 88V39M53 88h14M60 12l17 18-17 18-17-18Z" />
          <path d="M31 65 20 76m69-11 11 11M60 4v5" />
          <circle cx="60" cy="30" r="4" />
        </svg>
      )}
    </span>
  );
}

function ChapterTabs({ selection }: { selection: RoadmapSelection }) {
  return (
    <nav className="rw-lp-final-chapters" aria-label="Explore roadmap chapters">
      {CHAPTERS.map((chapter) => (
        <button
          type="button"
          key={chapter.state}
          data-state={chapter.state}
          aria-pressed={chapter.state === selection.chapter.state}
          aria-controls={selection.panelId}
          onClick={() => selection.selectChapter(chapter)}
        >
          <span className="rw-lp-final-chapter-number">{chapter.number}</span>
          <span><strong>{chapter.status}</strong><small>{chapter.title}</small></span>
          <span className="rw-lp-final-chapter-arrow" aria-hidden="true">↗</span>
        </button>
      ))}
    </nav>
  );
}

function SelectedDetail({ stop, id }: { stop: RoadmapStop; id: string }) {
  return (
    <div className="rw-lp-final-stop-detail" id={id} aria-live="polite" aria-atomic="true" data-state={stop.state}>
      <p className="rw-lp-final-stop-status">{stopStatus(stop)}</p>
      <h3>{stop.name}</h3>
      <p className="rw-lp-final-stop-body">{stop.body}</p>
      <span className="rw-lp-final-availability">{stop.state === 'shipped' ? 'Available today' : 'Not available yet'}</span>
    </div>
  );
}

function StopIndex({ selection }: { selection: RoadmapSelection }) {
  return (
    <ol className="rw-lp-final-stop-index" aria-label={`${selection.chapter.status} stops, in order`}>
      {selection.stops.map((stop) => (
        <li key={stop.id}>
          <button type="button" aria-pressed={selection.selected.id === stop.id} aria-controls={selection.panelId} onClick={() => selection.select(stop)} data-state={stop.state}>
            <span className="rw-lp-final-index-number">{stopNumber(stop)}</span>
            <span className="rw-lp-final-index-copy"><small>{stopStatus(stop)}</small><strong>{stop.name}</strong></span>
            <span className="rw-lp-final-index-arrow" aria-hidden="true">↗</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** The chapter changes only the ground's framing: Shipped = bright left,
 *  Planned = darker centre, Horizon = right under cloud plates. */
function AtlasMap({ selection }: { selection: RoadmapSelection }) {
  return (
    <div className="rw-lp-final-atlas-map" data-state={selection.chapter.state}>
      <MapGround />
      <div className="rw-lp-final-map-caption"><span>RepWorth / Route {selection.chapter.number}</span><span>{selection.chapter.title}</span></div>
      <Compass />
      <svg className="rw-lp-final-atlas-route" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true" fill="none">
        <path d="M-10 453C65 453 63 378 120 378S232 234 300 234 401 360 500 360 604 180 700 180 814 312 880 312 947 230 1010 230" />
      </svg>
      {selection.stops.map((stop, index) => {
        const position = ATLAS_POSITIONS[index];
        if (!position) return null;
        return (
          <button
            type="button"
            key={stop.id}
            className="rw-lp-final-atlas-stop"
            data-state={stop.state}
            aria-label={`${stopNumber(stop)}. ${stop.name}. ${stopStatus(stop)}`}
            aria-pressed={selection.selected.id === stop.id}
            aria-controls={selection.panelId}
            onClick={() => selection.select(stop)}
            style={{ '--rw-lp-map-x': `${position.x}%`, '--rw-lp-map-y': `${position.y}%` } as CSSProperties}
          >
            <Landmark stop={stop} />
            <span className="rw-lp-final-map-pin">{stopNumber(stop)}</span>
            <span className="rw-lp-final-map-stop-label"><small>{stopStatus(stop)}</small><strong>{stop.name}</strong></span>
          </button>
        );
      })}
      <p className="rw-lp-final-map-footnote">{selection.chapter.note}</p>
    </div>
  );
}

/**
 * Section 8 — where this is going: the Working Atlas. Three chapter controls,
 * a map of the chapter's five illustrated stops, and a detail ledger. All 15
 * canonical stops stay reachable, each with its availability label.
 */
export function FutureSection() {
  const [selected, setSelected] = useState<RoadmapStop>(() => {
    const first = STOPS[0];
    if (!first) throw new Error('The roadmap needs a starting point.');
    return first;
  });
  const panelId = useId();
  const chapter = CHAPTERS.find((item) => item.state === selected.state) ?? CHAPTERS[0];
  const selection: RoadmapSelection = {
    selected,
    chapter,
    stops: STOPS.filter((stop) => stop.state === selected.state),
    select: setSelected,
    selectChapter: (nextChapter) => {
      if (nextChapter.state === selected.state) return;
      const first = STOPS.find((stop) => stop.state === nextChapter.state);
      if (first) setSelected(first);
    },
    panelId,
  };

  return (
    <section className="rw-lp-final-roadmap" aria-labelledby="rw-lp-future-heading">
      <div className="rw-lp-final-roadmap-inner">
        <header className="rw-lp-final-roadmap-intro">
          <div>
            <p className="rw-lp-final-roadmap-eyebrow">{EYEBROW}</p>
            <h2 id="rw-lp-future-heading">{HEADING_LEAD}<em>{HEADING_ACCENT}</em></h2>
          </div>
          <p className="rw-lp-final-roadmap-lead">{LEAD_IN}</p>
        </header>
        <div className="rw-lp-final-atlas">
          <ChapterTabs selection={selection} />
          <div className="rw-lp-final-atlas-spread">
            <AtlasMap selection={selection} />
            <aside className="rw-lp-final-atlas-ledger" aria-label="Roadmap detail ledger">
              <p className="rw-lp-final-ledger-heading">The route / {selection.chapter.range}</p>
              <StopIndex selection={selection} />
              <SelectedDetail stop={selection.selected} id={selection.panelId} />
            </aside>
          </div>
        </div>
        <footer className="rw-lp-final-roadmap-footer">
          <p><strong>{CLOSING_LEAD} {CLOSING_ACCENT}</strong> {CLOSING_TAIL}</p>
          <span>Shipped is available today.<br />Planned and Horizon are not available yet.</span>
        </footer>
      </div>
    </section>
  );
}
