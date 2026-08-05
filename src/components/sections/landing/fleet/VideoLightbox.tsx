'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Click-to-open video player for the fleet centre.
 *
 * Built on the native `<dialog>` element rather than a hand-rolled overlay,
 * because `showModal()` gives four things for free that are laborious and
 * commonly got wrong by hand: a real focus trap, Escape-to-close, inertness of
 * the page behind it, and a `::backdrop` that is not part of the layout.
 *
 * ── The video is mounted only while open ──────────────────────────────────
 * The file is 25 MB. Rendering the `<video>` unconditionally — even with
 * `preload="none"` — leaves a live media element on a page that already ships
 * four looping avatars and two full-bleed background clips. Mounting on open
 * and unmounting on close means a visitor who never clicks pays nothing at
 * all, and the element cannot keep audio playing after it is dismissed.
 *
 * That also removes the usual bug in this pattern: a hidden-but-mounted video
 * that carries on narrating over the page because `close()` was wired without
 * a `pause()`.
 */

interface VideoLightboxProps {
  open: boolean;
  onClose: () => void;
  src: string;
  poster: string;
  /** Announced as the dialog's accessible name. */
  title: string;
}

export function VideoLightbox({ open, onClose, src, poster, title }: VideoLightboxProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // `open` is React state; the dialog's modal-ness is imperative DOM state.
  // Driving it from an effect keeps the two in step — setting the `open`
  // ATTRIBUTE instead would render a non-modal dialog with no backdrop, no
  // focus trap and no Escape handling, which is the usual way this goes wrong.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Escape closes the dialog natively, which fires `cancel`/`close` WITHOUT
  // going through our button — so React state has to be told, or the next
  // click cannot reopen it.
  const handleClose = useCallback(() => onClose(), [onClose]);

  // Clicking the backdrop closes. The dialog's own box is the only child, so
  // any click landing on the <dialog> element itself is a backdrop click.
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDialogElement>) => {
      if (event.target === dialogRef.current) onClose();
    },
    [onClose],
  );

  return (
    <dialog
      ref={dialogRef}
      className="rw-lp-lightbox"
      aria-label={title}
      onClose={handleClose}
      onClick={handleClick}
    >
      {open ? (
        <div className="rw-lp-lightbox-frame">
          <button type="button" className="rw-lp-lightbox-close" onClick={onClose}>
            <span className="sr-only">Close video</span>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* Not muted and not looping — this one is meant to be watched and
              listened to, unlike every other clip on the page. `autoPlay` is
              safe here precisely BECAUSE it is behind a click: a user gesture
              opened the dialog, so sound is permitted. */}
          {/* NO CAPTIONS YET. This is narrated, so it is inaccessible to deaf
              and hard-of-hearing visitors until a WebVTT track exists. Ship one
              as `<track kind="captions" src="…" srcLang="en" default />` when
              the cut is final — an empty <track> would be worse than none,
              because it claims captions the file does not have. */}
          <video
            className="rw-lp-lightbox-video"
            src={src}
            poster={poster}
            controls
            autoPlay
            playsInline
            preload="auto"
          />
        </div>
      ) : null}
    </dialog>
  );
}
