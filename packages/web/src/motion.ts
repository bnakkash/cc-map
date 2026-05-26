/**
 * Motion vocabulary for cc-map. One small set of durations + easing curves
 * used app-wide so transitions feel coordinated, not random.
 *
 * Pick a tier based on what's moving:
 *   - micro    (150ms): single UI bits — hover, button-press, fade-in toast
 *   - standard (250ms): camera pans, search-step, recenter, modal open
 *   - spatial  (400ms): layout direction morphs, "feels heavy" position changes
 *
 * Easing:
 *   - ease  — default cubic for almost everything; gentle accel + decel
 *   - exit  — slightly faster decel; for things leaving the screen
 *   - spring — overshooting for delightful "lands into place" moments (toasts, dialogs)
 */
export const MOTION = {
  duration: {
    micro: 150,
    standard: 250,
    spatial: 400,
  },
  ease: {
    // cubic-bezier(0.4, 0, 0.2, 1) — material standard easing, good default
    standard: (t: number) => {
      const c1 = 0.4;
      const c2 = 0.2;
      return bezierY(t, c1, 0, c2, 1);
    },
    // cubic-bezier(0.0, 0, 0.2, 1) — exit/decelerate
    exit: (t: number) => bezierY(t, 0, 0, 0.2, 1),
    // Slight overshoot at end
    spring: (t: number) => {
      const c4 = (2 * Math.PI) / 3;
      return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    },
  },
  /** Tailwind-ready easing strings for CSS transitions. */
  cssEase: {
    standard: "cubic-bezier(0.4, 0, 0.2, 1)",
    exit: "cubic-bezier(0.0, 0, 0.2, 1)",
    spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  },
} as const;

/** Solve a 1D cubic Bezier (P0=0, P3=1) for Y at parameter t. */
function bezierY(t: number, _x1: number, y1: number, _x2: number, y2: number): number {
  // For animation purposes we treat the bezier as a function of t directly
  // (not solving for t given x). Good enough for the precision needed here.
  const mt = 1 - t;
  return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t;
}

/** Convenience: classic ease-out-cubic, kept for back-compat with existing code. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
