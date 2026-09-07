/**
 * Route geometry for the roadmap chart — pure functions, no DOM.
 *
 * A Catmull-Rom spline through the stops in travel order, emitted as cubic
 * beziers so a single `<path d>` can be drawn in with motion `pathLength`.
 * Catmull-Rom, not a hand-tuned bezier per leg: the stops are copy data, and
 * moving one must move the road with it.
 */

export interface RoutePoint {
  x: number;
  y: number;
}

/** Tension 0.5 is the classic Catmull-Rom; lower is straighter. */
const TENSION = 0.5;

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * The `d` attribute of a smooth open curve through `points`, in order.
 * Fewer than two points yields an empty string (nothing to draw).
 */
export function routePath(points: readonly RoutePoint[]): string {
  if (points.length < 2) return '';
  const first = points[0];
  if (!first) return '';
  let d = `M ${fmt(first.x)} ${fmt(first.y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? points[i + 1];
    if (!p0 || !p1 || !p2 || !p3) break;
    const c1x = p1.x + ((p2.x - p0.x) / 6) * (TENSION * 2);
    const c1y = p1.y + ((p2.y - p0.y) / 6) * (TENSION * 2);
    const c2x = p2.x - ((p3.x - p1.x) / 6) * (TENSION * 2);
    const c2y = p2.y - ((p3.y - p1.y) / 6) * (TENSION * 2);
    d += ` C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  return d;
}
