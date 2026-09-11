'use client';

import Image from 'next/image';
import { useInView } from 'motion/react';
import { useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { AmbientVideo } from '../ambient-motion';
import { CLOSING_LEAD, CLOSING_TAIL, JOBS, LEAD_IN } from './jobs-copy';

const JOB_SCENES: Record<string, string> = {
  respond: 'A correspondence press composes a reply.',
  protect: 'An inspection gate holds a concern for your attention.',
  request: 'An invitation is folded and prepared for an approved send.',
  brief: 'Observations are gathered into one considered brief.',
  measure: 'An analog ledger keeps a dependable record.',
};

/** A job's film only decodes near the reader. Its still remains available if
 *  playback is declined, a media request fails, or the visitor prefers reduced
 *  motion. */
function JobFilm({ jobId }: { jobId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.05 });
  const reduced = usePrefersReducedMotion();
  const [failed, setFailed] = useState(false);
  const description = JOB_SCENES[jobId];
  if (!description) throw new Error(`Unknown job scene: ${jobId}`);
  const source = `/jobs/${jobId}`;
  return (
    <div ref={ref} className="rw-lp-final-job-film" data-job-film={jobId}>
      <Image src={`${source}.webp`} alt={description} fill sizes="(max-width: 760px) 90vw, 42vw" />
      {inView && !reduced && !failed ? (
        <AmbientVideo src={`${source}.mp4`} poster={`${source}.webp`} preload="none" aria-hidden="true" onError={() => setFailed(true)} />
      ) : null}
    </div>
  );
}

/**
 * Section 5 — the five jobs. The reader has met the acting agents one by one;
 * this regroups them by job — respond, protect, request, brief, measure —
 * before the oversight layer is introduced. Each job has its own film.
 */
export function JobsSection() {
  return (
    <div className="rw-lp-synthesis-loop">
      <section className="rw-lp-syn-l-jobs" aria-labelledby="rw-lp-jobs-heading">
        <div className="rw-lp-syn-l-inner">
          <header className="rw-lp-syn-l-jobs-heading">
            <div>
              <p className="rw-lp-syn-l-eyebrow">One system, five jobs</p>
              <h2 id="rw-lp-jobs-heading">
                A whole reputation
                <br />
                <em>department.</em>
              </h2>
            </div>
            <p>{LEAD_IN}</p>
          </header>
          {JOBS.map((job) => (
            <article className="rw-lp-syn-l-job" key={job.id}>
              <div className="rw-lp-syn-l-job-title">
                <p className="rw-lp-syn-l-eyebrow">
                  {job.index} / {job.agents}
                </p>
                <h3>{job.verb}.</h3>
              </div>
              <div className="rw-lp-syn-l-job-detail">
                <JobFilm jobId={job.id} />
                <h4>{job.claim}</h4>
                <p>{job.body}</p>
                <p className="rw-lp-syn-l-job-surface">{job.surface}</p>
              </div>
            </article>
          ))}
          <p className="rw-lp-syn-l-job-closing">
            <strong>{CLOSING_LEAD}</strong> {CLOSING_TAIL}
          </p>
        </div>
      </section>
    </div>
  );
}
