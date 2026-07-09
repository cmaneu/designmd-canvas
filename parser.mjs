// DESIGN.md parser + linter. Pure JS (Node + browser).
// Parses the YAML front-matter subset used by the DESIGN.md spec, extracts the
// markdown sections, resolves {path.to.token} references, and produces lint
// findings that mirror the shape of `@google/design.md`'s linter output.

import { parseColorWith, contrastRatio, wcagLevels } from "./color.mjs";

const SECTION_ORDER = [
    { name: "Overview", aliases: ["overview", "brand & style", "brand and style"] },
    { name: "Colors", aliases: ["colors", "colours", "color"] },
    { name: "Typography", aliases: ["typography"] },
    { name: "Layout", aliases: ["layout", "layout & spacing", "layout and spacing"] },
    { name: "Elevation & Depth", aliases: ["elevation & depth", "elevation", "elevation and depth"] },
    { name: "Shapes", aliases: ["shapes", "shape"] },
    { name: "Components", aliases: ["components", "component"] },
    { name: "Do's and Don'ts", aliases: ["do's and don'ts", "dos and don'ts", "do's and donts", "dos and donts"] },
];

const VALID_COMPONENT_PROPS = new Set([
    "backgroundColor", "textColor", "typography", "rounded", "padding", "size", "height", "width",
]);

// --- Minimal indentation-based YAML parser for the front-matter subset --------

function stripInlineComment(line) {
    let inSingle = false, inDouble = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
            return line.slice(0, i);
        }
    }
    return line;
}

function coerceScalar(raw) {
    let v = raw.trim();
    if (v === "") return "";
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "null" || v === "~") return null;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
}

// Parse the subset of YAML DESIGN.md uses: nested maps only, no sequences.
function parseYaml(text) {
    const lines = text.split(/\r?\n/);
    const root = {};
    // stack of { indent, container }
    const stack = [{ indent: -1, container: root }];

    for (let raw of lines) {
        const noComment = stripInlineComment(raw);
        if (noComment.trim() === "") continue;
        const indent = noComment.length - noComment.trimStart().length;
        const content = noComment.trim();
        const colon = content.indexOf(":");
        if (colon === -1) continue; // ignore malformed / sequence lines
        const key = content.slice(0, colon).trim().replace(/^["']|["']$/g, "");
        const valuePart = content.slice(colon + 1).trim();

        while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
            stack.pop();
        }
        const parent = stack[stack.length - 1].container;

        if (valuePart === "") {
            const child = {};
            parent[key] = child;
            stack.push({ indent, container: child });
        } else {
            parent[key] = coerceScalar(valuePart);
        }
    }
    return root;
}

// --- Front matter + section splitting ----------------------------------------

export function splitFrontMatter(text) {
    const normalized = text.replace(/^\uFEFF/, "");
    const m = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
    if (!m) return { frontMatter: null, body: normalized, raw: "" };
    return { frontMatter: m[1], body: normalized.slice(m[0].length), raw: m[1] };
}

function extractSections(body) {
    const lines = body.split(/\r?\n/);
    const sections = [];
    let current = null;
    for (const line of lines) {
        const h2 = line.match(/^##\s+(.*\S)\s*$/);
        if (h2 && !line.startsWith("###")) {
            current = { heading: h2[1].trim(), lines: [] };
            sections.push(current);
        } else if (current) {
            current.lines.push(line);
        }
    }
    return sections.map((s) => ({ heading: s.heading, body: s.lines.join("\n").trim() }));
}

// --- Token reference resolution ----------------------------------------------

function getByPath(obj, path) {
    const parts = path.split(".");
    let cur = obj;
    for (const p of parts) {
        if (cur == null || typeof cur !== "object" || !(p in cur)) return undefined;
        cur = cur[p];
    }
    return cur;
}

const REF_RE = /^\{([^}]+)\}$/;

function resolveRef(value, tokens, seen = new Set()) {
    if (typeof value !== "string") return { value, broken: null };
    const m = value.match(REF_RE);
    if (!m) return { value, broken: null };
    const path = m[1].trim();
    if (seen.has(path)) return { value: undefined, broken: path };
    seen.add(path);
    const target = getByPath(tokens, path);
    if (target === undefined) return { value: undefined, broken: path };
    return resolveRef(target, tokens, seen);
}

// --- Main parse ---------------------------------------------------------------

export function parseDesignMd(text, domResolver) {
    const { frontMatter } = splitFrontMatter(text);
    const { body } = splitFrontMatter(text);
    const tokens = frontMatter ? parseYaml(frontMatter) : {};
    const sections = extractSections(body);

    const design = {
        name: typeof tokens.name === "string" ? tokens.name : undefined,
        version: tokens.version != null ? String(tokens.version) : undefined,
        description: typeof tokens.description === "string" ? tokens.description : undefined,
        colors: isPlainObject(tokens.colors) ? tokens.colors : {},
        typography: isPlainObject(tokens.typography) ? tokens.typography : {},
        rounded: isPlainObject(tokens.rounded) ? tokens.rounded : {},
        spacing: isPlainObject(tokens.spacing) ? tokens.spacing : {},
        components: isPlainObject(tokens.components) ? tokens.components : {},
    };

    const findings = lint({ tokens, design, sections, domResolver });
    const summary = summarize(findings);

    return { design, sections, tokens, findings, summary, hasFrontMatter: !!frontMatter };
}

function isPlainObject(v) {
    return v && typeof v === "object" && !Array.isArray(v);
}

// Resolve every component's properties, tracking broken references.
export function resolveComponents(design) {
    const out = {};
    for (const [name, props] of Object.entries(design.components)) {
        if (!isPlainObject(props)) continue;
        const resolved = {};
        for (const [prop, value] of Object.entries(props)) {
            const { value: v, broken } = resolveRef(value, {
                colors: design.colors,
                typography: design.typography,
                rounded: design.rounded,
                spacing: design.spacing,
            });
            resolved[prop] = { raw: value, resolved: v, broken };
        }
        out[name] = resolved;
    }
    return out;
}

// --- Linting ------------------------------------------------------------------

function lint({ tokens, design, sections, domResolver }) {
    const findings = [];
    const add = (severity, path, message) => findings.push({ severity, path, message });

    // version / naming info
    if (!design.name) add("warning", "name", "Design system has no `name` in front matter.");
    if (design.version) add("info", "version", `Spec version: "${design.version}".`);

    // At least a primary color must exist
    if (!design.colors || Object.keys(design.colors).length === 0) {
        add("error", "colors", "No `colors` defined. At least a `primary` color is required.");
    } else if (!("primary" in design.colors)) {
        add("warning", "colors.primary", "No `primary` color token defined (recommended convention).");
    }

    // Validate color values
    for (const [name, value] of Object.entries(design.colors)) {
        if (!parseColorWith(String(value), domResolver)) {
            add("error", `colors.${name}`, `Invalid color value: "${value}".`);
        }
    }

    // Duplicate section headings -> error
    const seenHeadings = new Map();
    for (const s of sections) {
        const key = normalizeHeading(s.heading);
        seenHeadings.set(key, (seenHeadings.get(key) || 0) + 1);
    }
    for (const [key, count] of seenHeadings) {
        if (count > 1) add("error", `section.${key}`, `Duplicate "## ${key}" heading (${count}x). File is invalid.`);
    }

    // Section ordering -> warning
    const orderIndexes = [];
    for (const s of sections) {
        const idx = SECTION_ORDER.findIndex((so) => so.aliases.includes(normalizeHeading(s.heading)));
        if (idx !== -1) orderIndexes.push({ heading: s.heading, idx });
    }
    for (let i = 1; i < orderIndexes.length; i++) {
        if (orderIndexes[i].idx < orderIndexes[i - 1].idx) {
            add("warning", `section.${normalizeHeading(orderIndexes[i].heading)}`,
                `Section "${orderIndexes[i].heading}" appears out of the recommended order.`);
        }
    }

    // Component property + reference validation
    const refScope = { colors: design.colors, typography: design.typography, rounded: design.rounded, spacing: design.spacing };
    for (const [cname, props] of Object.entries(design.components)) {
        if (!isPlainObject(props)) continue;
        for (const [prop, value] of Object.entries(props)) {
            if (!VALID_COMPONENT_PROPS.has(prop)) {
                add("warning", `components.${cname}.${prop}`, `Unknown component property "${prop}".`);
            }
            if (typeof value === "string" && REF_RE.test(value.trim())) {
                const { broken } = resolveRef(value.trim(), refScope);
                if (broken) add("error", `components.${cname}.${prop}`, `Broken token reference "${value}" (unresolved: ${broken}).`);
            }
        }
    }

    // Contrast audit for components with both text + background colors
    const comps = resolveComponents(design);
    for (const [cname, props] of Object.entries(comps)) {
        const bg = props.backgroundColor?.resolved;
        const fg = props.textColor?.resolved;
        if (bg && fg) {
            const cbg = parseColorWith(String(bg), domResolver);
            const cfg = parseColorWith(String(fg), domResolver);
            if (cbg && cfg) {
                const ratio = contrastRatio(cbg, cfg);
                const levels = wcagLevels(ratio);
                const r = ratio.toFixed(2);
                if (!levels.largeAA) {
                    add("error", `components.${cname}`, `textColor on backgroundColor has contrast ${r}:1 — fails WCAG AA.`);
                } else if (!levels.normalAA) {
                    add("warning", `components.${cname}`, `textColor on backgroundColor has contrast ${r}:1 — passes AA for large text only.`);
                } else {
                    add("info", `components.${cname}`, `textColor on backgroundColor has contrast ${r}:1 — passes WCAG AA.`);
                }
            }
        }
    }

    return findings;
}

function normalizeHeading(h) {
    return h.trim().toLowerCase();
}

function summarize(findings) {
    return {
        errors: findings.filter((f) => f.severity === "error").length,
        warnings: findings.filter((f) => f.severity === "warning").length,
        info: findings.filter((f) => f.severity === "info").length,
    };
}

export { SECTION_ORDER, VALID_COMPONENT_PROPS };
