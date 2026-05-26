/**
 * Dynamic favicon + document title for unread-message badging when the tab
 * is unfocused. Mirrors Slack/Gmail/Linear behavior:
 *   - Title becomes "(3) cc-map — <scope>" when unread > 0
 *   - Favicon is regenerated with a red bubble + count in the corner
 *   - Both reset when the tab returns to focus
 *
 * Implementation note: we draw the favicon on an offscreen canvas and set
 * <link rel="icon"> to the data URL. No external icon library needed.
 */

const DEFAULT_TITLE = "cc-map";

let originalFaviconHref: string | null = null;

function getOrCreateFaviconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  if (originalFaviconHref === null) originalFaviconHref = link.href;
  return link;
}

/**
 * Render a 32×32 favicon: emerald background, white "cc" mark, and a red
 * count bubble in the top-right when count > 0. Returns the data URL.
 */
function renderFavicon(count: number): string {
  const size = 32;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  // Rounded background
  ctx.fillStyle = "#059669"; // emerald-600
  roundRect(ctx, 0, 0, size, size, 6);
  ctx.fill();
  // "cc" mark
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 18px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("cc", size / 2, size / 2 + 1);
  // Unread bubble
  if (count > 0) {
    const label = count > 99 ? "99+" : String(count);
    const isWide = label.length > 1;
    const bubbleR = isWide ? 8 : 7;
    const bubbleX = size - bubbleR - 1;
    const bubbleY = bubbleR + 1;
    ctx.fillStyle = "#dc2626"; // red-600
    ctx.beginPath();
    ctx.arc(bubbleX, bubbleY, bubbleR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${isWide ? 8 : 10}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, bubbleX, bubbleY + 0.5);
  }
  return c.toDataURL("image/png");
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Set the unread badge to `count` and update the title with `scope`.
 * Pass count = 0 to clear back to defaults.
 */
export function setUnreadBadge(count: number, scope: string | null = null): void {
  const titleScope = scope ? ` — ${scope}` : "";
  document.title = count > 0
    ? `(${count > 99 ? "99+" : count}) ${DEFAULT_TITLE}${titleScope}`
    : `${DEFAULT_TITLE}${titleScope}`;
  try {
    const link = getOrCreateFaviconLink();
    link.href = renderFavicon(count);
  } catch {
    // Best-effort — some environments don't allow data URL favicons.
  }
}
