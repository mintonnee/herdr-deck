// Key images rendered as 144x144 SVG data URLs.

const FONT = "'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Helvetica Neue', Arial, sans-serif";

export const PALETTE = {
  blocked: { bg: "#C2410C", fg: "#FFFFFF", label: "BLOCKED" },
  done: { bg: "#15803D", fg: "#FFFFFF", label: "DONE" },
  working: { bg: "#1D4ED8", fg: "#FFFFFF", label: "WORKING" },
  idle: { bg: "#27272A", fg: "#E4E4E7", label: "IDLE" },
  unknown: { bg: "#18181B", fg: "#A1A1AA", label: "—" },
  empty: { bg: "#0B0B0D", fg: "#52525B", label: "" },
  offline: { bg: "#0B0B0D", fg: "#71717A", label: "OFFLINE" },
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rough display width: wide (CJK etc.) chars count double. */
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  )
    return 2;
  return 1;
}

export function fit(text, maxUnits) {
  const chars = [...String(text ?? "")];
  let units = 0;
  let out = "";
  for (const ch of chars) {
    const w = charWidth(ch);
    if (units + w > maxUnits) return out.replace(/\s+$/, "") + "…";
    units += w;
    out += ch;
  }
  return out;
}

function units(text) {
  return [...String(text ?? "")].reduce((n, ch) => n + charWidth(ch), 0);
}

/** Pick a font size so `text` fits ~124px wide. */
function sizeFor(text, max, min) {
  const u = Math.max(1, units(text));
  // ~0.56em average advance per unit for Segoe UI semibold
  return Math.max(min, Math.min(max, Math.floor(124 / (u * 0.56))));
}

function svgUrl(body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${body}</svg>`;
  return "data:image/svg+xml;charset=utf8," + encodeURIComponent(svg);
}

function text(x, y, s, size, fill, weight = 600, opacity = 1) {
  return `<text x="${x}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" fill-opacity="${opacity}">${esc(s)}</text>`;
}

function frame(bg, focused) {
  let out = `<rect x="0" y="0" width="144" height="144" fill="${bg}"/>`;
  if (focused) out += `<rect x="4" y="4" width="136" height="136" rx="10" fill="none" stroke="#FFFFFF" stroke-width="6"/>`;
  return out;
}

export function renderOffline(caption = "herdr") {
  const p = PALETTE.offline;
  return svgUrl(
    frame(p.bg) +
      `<circle cx="72" cy="56" r="20" fill="none" stroke="${p.fg}" stroke-width="5" stroke-dasharray="6 7"/>` +
      text(72, 108, caption, 20, p.fg, 600) +
      text(72, 130, "offline", 16, p.fg, 400, 0.8),
  );
}

export function renderEmpty(caption) {
  const p = PALETTE.empty;
  return svgUrl(frame(p.bg) + text(72, 80, caption, 20, p.fg, 500));
}

/** Agent key: status band on top, agent name in the middle, workspace at the bottom. */
export function renderAgent({ status, name, sub, focused, slotLabel }) {
  const p = PALETTE[status] ?? PALETTE.unknown;
  const n = fit(name || "agent", 9);
  const s = fit(sub || "", 13);
  return svgUrl(
    frame(p.bg, focused) +
      `<rect x="0" y="0" width="144" height="34" fill="#000000" fill-opacity="0.22"/>` +
      text(72, 24, p.label, 17, p.fg, 700) +
      (slotLabel ? `<text x="134" y="24" text-anchor="end" font-family="${FONT}" font-size="13" fill="${p.fg}" fill-opacity="0.65">${esc(slotLabel)}</text>` : "") +
      text(72, 84, n, sizeFor(n, 34, 18), p.fg, 700) +
      text(72, 122, s, 17, p.fg, 400, 0.85),
  );
}

/** Next-attention key: big count + caption. */
export function renderAttention({ blocked, done, total }) {
  if (blocked > 0) {
    const p = PALETTE.blocked;
    return svgUrl(
      frame(p.bg) +
        text(72, 88, String(blocked), 64, p.fg, 800) +
        text(72, 124, done > 0 ? `blocked · ${done} done` : "blocked", 17, p.fg, 500, 0.9),
    );
  }
  if (done > 0) {
    const p = PALETTE.done;
    return svgUrl(frame(p.bg) + text(72, 88, String(done), 64, p.fg, 800) + text(72, 124, "done", 17, p.fg, 500, 0.9));
  }
  const p = PALETTE.idle;
  return svgUrl(
    frame(p.bg) +
      `<path d="M50 70 L66 86 L96 54" fill="none" stroke="#A3E635" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>` +
      text(72, 124, `${total} agent${total === 1 ? "" : "s"}`, 17, p.fg, 500, 0.85),
  );
}

/** Workspace key: number, label, rolled-up status. */
export function renderWorkspace({ status, label, number, focused, agents }) {
  const p = PALETTE[status] ?? PALETTE.unknown;
  const l = fit(label || `ws ${number}`, 10);
  return svgUrl(
    frame(p.bg, focused) +
      `<rect x="0" y="0" width="144" height="34" fill="#000000" fill-opacity="0.22"/>` +
      text(72, 24, number != null ? `#${number}` : "", 17, p.fg, 700) +
      text(72, 84, l, sizeFor(l, 30, 16), p.fg, 700) +
      text(72, 122, status === "unknown" ? `${agents} agents` : `${p.label.toLowerCase()} · ${agents}`, 16, p.fg, 400, 0.85),
  );
}
