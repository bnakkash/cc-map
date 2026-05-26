import { useEffect, useMemo, useState } from "react";

interface TourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector for the element to point at, or "center" for a centered card. */
  target: string | "center";
  /** Where the callout sits relative to the target. */
  placement?: "top" | "right" | "bottom" | "left";
}

const STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to cc-map",
    body: "A 2D map of every Claude Code session. This quick tour shows the 4 things you'll use most.",
    target: "center",
  },
  {
    id: "sidebar",
    title: "Sidebar",
    body: "Six collapsible groups: Scope, Display, Live, Filter, Saved, Activity. Use the chevron to fold sections you don't need — collapsed groups still show their current setting.",
    target: "[data-tour-id='sidebar']",
    placement: "right",
  },
  {
    id: "minimap",
    title: "Minimap",
    body: "Thumbnail of the whole forest. Click or drag the viewport rectangle to jump anywhere.",
    target: "[data-tour-id='minimap']",
    placement: "left",
  },
  {
    id: "status-bar",
    title: "Status bar",
    body: "Always-visible bar showing zoom, scope, mode, selection and live status. Watch for the green dot — that's a session typing right now.",
    target: "[data-tour-id='status-bar']",
    placement: "top",
  },
  {
    id: "palette",
    title: "Command palette",
    body: "Press Cmd/Ctrl+K from anywhere to jump to a session, switch modes, or run actions. The fastest way to navigate once you have a few sessions.",
    target: "center",
  },
];

interface OnboardingTourProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Guided callout tour replacing the static welcome modal. Walks 5 steps,
 * positioning a small card next to each highlighted UI element (or centered
 * for intro/outro steps). Skips a step gracefully if its target isn't in the
 * DOM (e.g., minimap collapsed). Sets cc-map-seen-welcome so it doesn't fire
 * twice; revisit via the help overlay's "show intro" link.
 */
export function OnboardingTour({ open, onClose }: OnboardingTourProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; arrow: "top" | "right" | "bottom" | "left" | null } | null>(null);
  const [highlight, setHighlight] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  // Reset to step 0 on open
  useEffect(() => { if (open) setStepIdx(0); }, [open]);

  const step = STEPS[stepIdx];

  // Recompute callout + highlight rect when step changes or window resizes
  useEffect(() => {
    if (!open || !step) return;
    const update = () => {
      if (step.target === "center") {
        setPos({ left: window.innerWidth / 2 - 200, top: window.innerHeight / 2 - 100, arrow: null });
        setHighlight(null);
        return;
      }
      const el = document.querySelector(step.target);
      if (!el) {
        // Target not in DOM — show as centered fallback
        setPos({ left: window.innerWidth / 2 - 200, top: window.innerHeight / 2 - 100, arrow: null });
        setHighlight(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setHighlight({ left: r.left, top: r.top, width: r.width, height: r.height });
      const CW = 320;
      const CH = 160;
      const gap = 14;
      const placement = step.placement ?? "right";
      let left = 0;
      let top = 0;
      let arrow: "top" | "right" | "bottom" | "left" | null = null;
      switch (placement) {
        case "right":
          left = r.right + gap;
          top = r.top + r.height / 2 - CH / 2;
          arrow = "left";
          break;
        case "left":
          left = r.left - CW - gap;
          top = r.top + r.height / 2 - CH / 2;
          arrow = "right";
          break;
        case "top":
          left = r.left + r.width / 2 - CW / 2;
          top = r.top - CH - gap;
          arrow = "bottom";
          break;
        case "bottom":
          left = r.left + r.width / 2 - CW / 2;
          top = r.bottom + gap;
          arrow = "top";
          break;
      }
      // Clamp into viewport
      left = Math.max(12, Math.min(left, window.innerWidth - CW - 12));
      top = Math.max(12, Math.min(top, window.innerHeight - CH - 12));
      setPos({ left, top, arrow });
    };
    update();
    window.addEventListener("resize", update);
    const raf = window.setInterval(update, 250); // re-poll for layout shifts during tour
    return () => { window.removeEventListener("resize", update); window.clearInterval(raf); };
  }, [open, step]);

  // Esc dismisses
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); advance(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stepIdx]);

  const advance = () => {
    if (stepIdx >= STEPS.length - 1) finish();
    else setStepIdx((i) => i + 1);
  };
  const back = () => setStepIdx((i) => Math.max(0, i - 1));
  const finish = () => {
    try { localStorage.setItem("cc-map-seen-welcome", "1"); } catch {}
    onClose();
  };

  const isLast = useMemo(() => stepIdx === STEPS.length - 1, [stepIdx]);

  if (!open || !step) return null;

  return (
    <div className="absolute inset-0 z-50 pointer-events-none">
      {/* Dim overlay with cutout around the highlighted element */}
      <div className="absolute inset-0 bg-zinc-950/60 backdrop-blur-[2px] pointer-events-auto" onClick={advance} />
      {/* Highlight ring */}
      {highlight && (
        <div
          className="absolute pointer-events-none rounded-md ring-2 ring-emerald-400 ring-offset-2 ring-offset-transparent shadow-[0_0_0_9999px_rgba(9,9,11,0.6)] transition-all"
          style={{
            left: highlight.left - 4,
            top: highlight.top - 4,
            width: highlight.width + 8,
            height: highlight.height + 8,
          }}
        />
      )}
      {/* Callout card */}
      {pos && (
        <div
          className="absolute pointer-events-auto w-80 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 space-y-2"
          style={{ left: pos.left, top: pos.top }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <div className="text-emerald-400 text-[10px] uppercase tracking-wider font-mono">
              {stepIdx + 1} of {STEPS.length}
            </div>
            <button
              onClick={finish}
              className="text-zinc-500 hover:text-zinc-200 text-xs"
              title="Skip the tour"
            >
              skip
            </button>
          </div>
          <div className="text-zinc-100 font-semibold text-base">{step.title}</div>
          <div className="text-sm text-zinc-300 leading-snug">{step.body}</div>
          <div className="flex items-center justify-between pt-1">
            <button
              onClick={back}
              disabled={stepIdx === 0}
              className={`text-xs px-2 py-1 rounded ${stepIdx === 0 ? "text-zinc-700 cursor-not-allowed" : "text-zinc-400 hover:bg-zinc-800"}`}
            >
              ← back
            </button>
            <button
              onClick={advance}
              className="text-xs px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white font-medium"
            >
              {isLast ? "Got it" : "Next →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
