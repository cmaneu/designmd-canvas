// Pure-JS color parsing + WCAG contrast utilities.
// Works in both Node (for agent-callable actions) and the browser (live preview).
// In the browser, an optional DOM-based resolver handles any CSS color format
// (oklch, lab, color-mix, ...) that the lightweight parser here can't decode.

const NAMED_COLORS = {
    black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000",
    blue: "#0000ff", yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff",
    silver: "#c0c0c0", gray: "#808080", grey: "#808080", maroon: "#800000",
    olive: "#808000", lime: "#00ff00", aqua: "#00ffff", teal: "#008080",
    navy: "#000080", fuchsia: "#ff00ff", purple: "#800080", orange: "#ffa500",
    transparent: "#00000000", cornflowerblue: "#6495ed", rebeccapurple: "#663399",
    crimson: "#dc143c", gold: "#ffd700", indigo: "#4b0082", coral: "#ff7f50",
    salmon: "#fa8072", tomato: "#ff6347", chocolate: "#d2691e", tan: "#d2b48c",
    beige: "#f5f5dc", ivory: "#fffff0", khaki: "#f0e68c", lavender: "#e6e6fa",
    plum: "#dda0dd", orchid: "#da70d6", turquoise: "#40e0d0", skyblue: "#87ceeb",
    steelblue: "#4682b4", slategray: "#708090", slategrey: "#708090",
    darkslategray: "#2f4f4f", dimgray: "#696969", lightgray: "#d3d3d3",
    lightgrey: "#d3d3d3", whitesmoke: "#f5f5f5", gainsboro: "#dcdcdc",
    forestgreen: "#228b22", seagreen: "#2e8b57", darkgreen: "#006400",
    firebrick: "#b22222", brown: "#a52a2a", sienna: "#a0522d",
};

function clamp255(n) {
    return Math.max(0, Math.min(255, Math.round(n)));
}

function parseHex(hex) {
    let h = hex.slice(1);
    if (h.length === 3 || h.length === 4) {
        h = h.split("").map((c) => c + c).join("");
    }
    if (h.length !== 6 && h.length !== 8) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b, a };
}

function parseNumberOrPercent(token, scale) {
    token = token.trim();
    if (token.endsWith("%")) return (parseFloat(token) / 100) * scale;
    return parseFloat(token);
}

function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(1, s));
    l = Math.max(0, Math.min(1, l));
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return { r: clamp255((r + m) * 255), g: clamp255((g + m) * 255), b: clamp255((b + m) * 255) };
}

// Parse a CSS color string into { r, g, b, a } (0-255, a 0-1) or null.
export function parseColor(input) {
    if (!input || typeof input !== "string") return null;
    let s = input.trim().toLowerCase();
    if (s.startsWith("#")) return parseHex(s);
    if (NAMED_COLORS[s]) return parseHex(NAMED_COLORS[s]);

    const fn = s.match(/^(rgba?|hsla?)\s*\(([^)]*)\)$/);
    if (fn) {
        const kind = fn[1];
        const parts = fn[2].split(/[,/]/).map((p) => p.trim()).filter((p) => p.length);
        if (kind === "rgb" || kind === "rgba") {
            const r = clamp255(parseNumberOrPercent(parts[0], 255));
            const g = clamp255(parseNumberOrPercent(parts[1], 255));
            const b = clamp255(parseNumberOrPercent(parts[2], 255));
            const a = parts[3] != null ? parseNumberOrPercent(parts[3], 1) : 1;
            return { r, g, b, a };
        }
        const h = parseFloat(parts[0]);
        const sat = parseNumberOrPercent(parts[1], 1);
        const li = parseNumberOrPercent(parts[2], 1);
        const a = parts[3] != null ? parseNumberOrPercent(parts[3], 1) : 1;
        return { ...hslToRgb(h, sat, li), a };
    }
    return null;
}

// Optional DOM-backed resolver: given a resolver(str)->"rgb(...)" (browser only),
// fall back to it for exotic formats the parser can't decode.
export function parseColorWith(input, domResolver) {
    const direct = parseColor(input);
    if (direct) return direct;
    if (typeof domResolver === "function") {
        const resolved = domResolver(input);
        if (resolved) return parseColor(resolved);
    }
    return null;
}

function channelLuminance(c) {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance({ r, g, b }) {
    return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(c1, c2) {
    const L1 = relativeLuminance(c1);
    const L2 = relativeLuminance(c2);
    const lighter = Math.max(L1, L2);
    const darker = Math.min(L1, L2);
    return (lighter + 0.05) / (darker + 0.05);
}

// Evaluate a contrast ratio against WCAG 2.1 thresholds.
export function wcagLevels(ratio) {
    return {
        ratio,
        normalAA: ratio >= 4.5,
        normalAAA: ratio >= 7,
        largeAA: ratio >= 3,
        largeAAA: ratio >= 4.5,
        uiAA: ratio >= 3, // non-text / UI components
    };
}

// Pick black or white text for best contrast on a given background.
export function bestTextColor(bg) {
    const parsed = typeof bg === "string" ? parseColor(bg) : bg;
    if (!parsed) return "#000000";
    const white = contrastRatio(parsed, { r: 255, g: 255, b: 255 });
    const black = contrastRatio(parsed, { r: 0, g: 0, b: 0 });
    return white >= black ? "#ffffff" : "#000000";
}

export function toHex({ r, g, b }) {
    return "#" + [r, g, b].map((c) => clamp255(c).toString(16).padStart(2, "0")).join("");
}
