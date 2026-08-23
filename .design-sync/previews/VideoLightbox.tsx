import { VideoLightbox } from 'repworth';

// A native <dialog> opened with showModal(): it renders in the browser's top
// layer with a ::backdrop, a real focus trap and Escape-to-close. `open` is the
// only state worth a card — closed, it renders nothing. The <video> is mounted
// only while open, so this preview is also the only state that has one.
export const Open = () => (
  <VideoLightbox
    open
    onClose={() => {}}
    src="https://repworth.net/video/heroVideo-960.mp4"
    poster="https://repworth.net/video/heroVideo-poster.jpg"
    title="RepWorth film"
  />
);
