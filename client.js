import { parseDesignMd, resolveComponents } from "./parser.mjs";
import { parseColorWith, contrastRatio, wcagLevels, bestTextColor, toHex } from "./color.mjs";

// --- DOM-backed color resolver: supports ANY CSS color format the browser knows
const probe = document.createElement("span");
probe.style.display = "none";
document.body.appendChild(probe);
function domResolve(str) {
    probe.style.color = "";
    probe.style.color = str;
    if (!probe.style.color) return null;
    return getComputedStyle(probe).color || null;
}
const resolveColor = (v) => parseColorWith(String(v), domResolve);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const $ = (sel) => document.querySelector(sel);
const editor = $("#editor");

let current = "";
let saveTimer = null;

// --- Server sync -------------------------------------------------------------
async function loadInitial() {
    try {
        const res = await fetch("state");
        const data = await res.json();
        current = data.content || "";
        setSource(data.source);
    } catch { current = ""; }
    editor.value = current;
    render();
    subscribe();
}

function setSource(src) {
    const el = $("#src-path");
    if (!el) return;
    if (src) {
        el.textContent = src;
        el.title = "Linked file: " + src + " (edits here are not written back to the file)";
        el.style.display = "inline-block";
    } else {
        el.textContent = "";
        el.style.display = "none";
    }
}

function subscribe() {
    try {
        const es = new EventSource("events");
        es.addEventListener("load", (e) => {
            const data = JSON.parse(e.data);
            if (typeof data.content === "string" && data.content !== editor.value) {
                editor.value = data.content;
                current = data.content;
                render();
            }
            if ("source" in data) setSource(data.source);
        });
    } catch { /* SSE optional */ }
}

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fetch("update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: editor.value }),
        }).catch(() => {});
    }, 400);
}

editor.addEventListener("input", () => {
    current = editor.value;
    render();
    scheduleSave();
});

// --- Fonts -------------------------------------------------------------------
let lastFontKey = "";
function loadFonts(design) {
    const families = new Set();
    for (const t of Object.values(design.typography || {})) {
        if (t && typeof t === "object" && t.fontFamily) families.add(String(t.fontFamily));
    }
    const key = [...families].sort().join("|");
    if (key === lastFontKey || families.size === 0) return;
    lastFontKey = key;
    const parts = [...families].map((f) =>
        "family=" + encodeURIComponent(f.trim()).replace(/%20/g, "+") + ":wght@300;400;500;600;700;800");
    let link = document.getElementById("dm-fonts");
    if (!link) {
        link = document.createElement("link");
        link.id = "dm-fonts";
        link.rel = "stylesheet";
        document.head.appendChild(link);
    }
    link.href = "https://fonts.googleapis.com/css2?" + parts.join("&") + "&display=swap";
}

// --- Render orchestrator -----------------------------------------------------
let parsed = null;
function render() {
    parsed = parseDesignMd(current, domResolve);
    const d = parsed.design;
    loadFonts(d);

    // chrome accent vars
    if (d.colors.tertiary) document.documentElement.style.setProperty("--tertiary", String(resolveColorStr(d.colors.tertiary)));
    if (d.colors.primary) document.documentElement.style.setProperty("--primary", String(resolveColorStr(d.colors.primary)));
    if (d.colors.surface) document.documentElement.style.setProperty("--surface", String(resolveColorStr(d.colors.surface)));

    // header
    $("#ds-name").textContent = d.name || "Untitled design system";
    const metaBits = [];
    if (d.version) metaBits.push("v" + d.version);
    metaBits.push(Object.keys(d.colors).length + " colors");
    metaBits.push(Object.keys(d.typography).length + " type");
    metaBits.push(Object.keys(d.components).length + " components");
    $("#ds-meta").textContent = metaBits.join(" · ");

    // instant lint from bundled parser, then upgrade to official linter async
    updateLintBadges(parsed.summary);
    renderColors(d);
    renderTypography(d);
    renderLayout(d);
    renderComponents(d);
    renderContrast(d);
    renderLint({ summary: parsed.summary, findings: parsed.findings, engine: "bundled" });
    renderProse(parsed);
    scheduleLintRefresh(current);
}

function updateLintBadges(summary) {
    setBadge("tabbadge-lint-err", summary.errors, "err");
    setBadge("tabbadge-lint-warn", summary.warnings, "warn");
}

// Fetch authoritative findings from the official @google/design.md linter (server-side).
let lintTimer = null;
function scheduleLintRefresh(content) {
    clearTimeout(lintTimer);
    lintTimer = setTimeout(async () => {
        try {
            const res = await fetch("api/lint", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content }),
            });
            const report = await res.json();
            if (content !== current) return; // stale
            if (report && report.summary && Array.isArray(report.findings)) {
                updateLintBadges(report.summary);
                renderLint(report);
            }
        } catch { /* keep bundled findings */ }
    }, 350);
}

function resolveColorStr(v) {
    const c = resolveColor(v);
    return c ? `rgb(${c.r}, ${c.g}, ${c.b})` : String(v);
}

function setBadge(id, n, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    if (n > 0) { el.textContent = n; el.className = "badge " + cls; el.style.display = "inline-block"; }
    else { el.style.display = "none"; }
}

// --- Colors panel ------------------------------------------------------------
function renderColors(d) {
    const el = $("#panel-colors");
    const names = Object.keys(d.colors);
    if (!names.length) { el.innerHTML = emptyState("No color tokens defined."); return; }
    let html = '<p class="section-title">Color tokens</p><div class="swatch-grid">';
    for (const name of names) {
        const val = String(d.colors[name]);
        const c = resolveColor(val);
        const bg = c ? `rgb(${c.r},${c.g},${c.b})` : "transparent";
        const txt = c ? bestTextColor(c) : "#000";
        const hex = c ? toHex(c) : "invalid";
        let contrast = "";
        let swatchFlag = "";
        if (c) {
            const wr = contrastRatio(c, { r: 255, g: 255, b: 255 });
            const br = contrastRatio(c, { r: 0, g: 0, b: 0 });
            const AA = 4.5; // WCAG 2.x normal-text minimum
            const wPass = wr >= AA;
            const bPass = br >= AA;
            const badge = (ratio, pass, bgHex, label) =>
                `<span class="mini-badge ${pass ? "pass" : "fail"}" title="Contrast of ${esc(label)} text on this color: ${ratio.toFixed(2)}:1 — ${pass ? "passes" : "fails"} WCAG AA (4.5:1)">`
                + `<span class="dot" style="background:${bgHex}"></span>${ratio.toFixed(1)}`
                + `<span class="mk">${pass ? "✓" : "✗"}</span></span>`;
            contrast = `<div class="contrast-row">
                ${badge(wr, wPass, "#fff", "white")}
                ${badge(br, bPass, "#000", "black")}
            </div>`;
            // Flag the token when neither white nor black text meets AA on it.
            if (!wPass && !bPass) swatchFlag = ' data-wcag="fail"';
        }
        const hexForInput = c ? toHex(c) : "#000000";
        const chip = c
            ? `<label class="chip pickable" style="background:${esc(bg)};color:${txt}" title="Click to pick a new color for &ldquo;${esc(name)}&rdquo;">
                <span>Aa</span><span class="chip-hex">${esc(hex)}</span>
                <span class="pick-hint" aria-hidden="true">✎</span>
                <input type="color" class="swatch-picker" data-token="${esc(name)}" value="${esc(hexForInput)}" aria-label="Pick a new color for ${esc(name)}">
            </label>`
            : `<div class="chip" style="background:${esc(bg)};color:${txt}">
                <span>Aa</span><span class="chip-hex">${esc(hex)}</span>
            </div>`;
        html += `<div class="swatch"${swatchFlag}>
            ${chip}
            <div class="info">
                <div class="tname">${esc(name)}${swatchFlag ? '<span class="wcag-warn" title="Neither black nor white text reaches WCAG AA (4.5:1) on this color">⚠ low contrast</span>' : ""}</div>
                <div class="tval">${esc(val)}${c ? "" : " ⚠"}</div>
                ${contrast}
            </div>
        </div>`;
    }
    html += "</div>";
    el.innerHTML = html;
}

// --- Color token editing (via the swatch color picker) -----------------------
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Surgically replace a single color token's value inside the front-matter
// `colors:` block, preserving indentation and any existing quote style.
function updateColorInSource(source, token, newHex) {
    const nl = source.includes("\r\n") ? "\r\n" : "\n";
    const lines = source.split(/\r?\n/);
    if (!lines.length || lines[0].trim() !== "---") return source;
    let fmEnd = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") { fmEnd = i; break; }
    }
    if (fmEnd === -1) return source;

    let colorsIdx = -1, colorsIndent = 0;
    for (let i = 1; i < fmEnd; i++) {
        const m = lines[i].match(/^(\s*)colors\s*:\s*$/);
        if (m) { colorsIdx = i; colorsIndent = m[1].length; break; }
    }
    if (colorsIdx === -1) return source;

    const tokRe = new RegExp("^(\\s*)(" + reEsc(token) + ")\\s*:\\s*(.*)$");
    for (let i = colorsIdx + 1; i < fmEnd; i++) {
        const line = lines[i];
        if (line.trim() === "") continue;
        const indent = (line.match(/^(\s*)/)[1] || "").length;
        if (indent <= colorsIndent) break; // left the colors block
        const m = line.match(tokRe);
        if (m && m[1].length > colorsIndent) {
            const rawVal = m[3].trim();
            const quote = rawVal.startsWith('"') ? '"' : rawVal.startsWith("'") ? "'" : "";
            const value = quote ? quote + newHex + quote : newHex;
            lines[i] = m[1] + m[2] + ": " + value;
            return lines.join(nl);
        }
    }
    return source;
}

function findPicker(token) {
    return [...document.querySelectorAll("#panel-colors .swatch-picker")]
        .find((i) => i.dataset.token === token) || null;
}

// Lightweight in-place preview while the picker is open (avoids re-rendering the
// panel, which would tear down the live <input> the OS picker is bound to).
function liveUpdateSwatch(token, hex) {
    const inp = findPicker(token);
    if (!inp) return;
    const chip = inp.closest(".chip");
    const swatch = inp.closest(".swatch");
    const c = resolveColor(hex);
    if (chip) {
        chip.style.background = hex;
        if (c) chip.style.color = bestTextColor(c);
        const hx = chip.querySelector(".chip-hex");
        if (hx) hx.textContent = hex.toLowerCase();
    }
    if (swatch) {
        const tv = swatch.querySelector(".tval");
        if (tv) tv.textContent = hex;
    }
}

function applyColorEdit(token, hex, commit) {
    const next = updateColorInSource(current, token, hex);
    if (next !== current) {
        current = next;
        editor.value = current;
        scheduleSave();
    }
    if (commit) render();       // full resync (badges, contrast, components)
    else liveUpdateSwatch(token, hex);
}

(() => {
    const panel = $("#panel-colors");
    if (!panel) return;
    const handler = (commit) => (e) => {
        const inp = e.target.closest && e.target.closest(".swatch-picker");
        if (!inp) return;
        applyColorEdit(inp.dataset.token, String(inp.value).toUpperCase(), commit);
    };
    panel.addEventListener("input", handler(false));  // live while dragging
    panel.addEventListener("change", handler(true));  // committed on close
})();

// --- Typography panel --------------------------------------------------------
function renderTypography(d) {
    const el = $("#panel-typography");
    const names = Object.keys(d.typography);
    if (!names.length) { el.innerHTML = emptyState("No typography tokens defined."); return; }
    let html = '<p class="section-title">Type scale</p>';
    for (const name of names) {
        const t = d.typography[name] || {};
        const style = [
            t.fontFamily ? `font-family:'${esc(String(t.fontFamily))}', sans-serif` : "",
            t.fontSize ? `font-size:${esc(String(t.fontSize))}` : "",
            t.fontWeight ? `font-weight:${esc(String(t.fontWeight))}` : "",
            t.lineHeight ? `line-height:${esc(String(t.lineHeight))}` : "",
            t.letterSpacing ? `letter-spacing:${esc(String(t.letterSpacing))}` : "",
            t.fontFeature ? `font-feature-settings:${esc(String(t.fontFeature))}` : "",
            t.fontVariation ? `font-variation-settings:${esc(String(t.fontVariation))}` : "",
        ].filter(Boolean).join(";");
        const meta = [
            t.fontFamily && esc(String(t.fontFamily)),
            t.fontSize && esc(String(t.fontSize)),
            t.fontWeight && ("w" + esc(String(t.fontWeight))),
            t.lineHeight && ("lh " + esc(String(t.lineHeight))),
            t.letterSpacing && ("ls " + esc(String(t.letterSpacing))),
        ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
        html += `<div class="type-row">
            <div class="type-meta"><strong style="color:var(--text-color-default)">${esc(name)}</strong>${meta}</div>
            <p class="type-sample" style="${style}">The quick brown fox jumps over the lazy dog</p>
        </div>`;
    }
    el.innerHTML = html;
}

// --- Layout panel ------------------------------------------------------------
function parseDim(v) {
    const m = String(v).match(/^(-?[\d.]+)(px|rem|em)?$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = m[2] || "";
    const px = unit === "rem" || unit === "em" ? n * 16 : n;
    return { n, unit, px };
}

function renderLayout(d) {
    const el = $("#panel-layout");
    const spacing = Object.entries(d.spacing || {});
    const rounded = Object.entries(d.rounded || {});
    if (!spacing.length && !rounded.length) { el.innerHTML = emptyState("No spacing or radius tokens defined."); return; }
    let html = "";
    if (spacing.length) {
        html += '<p class="section-title">Spacing scale</p>';
        const maxPx = Math.max(...spacing.map(([, v]) => (parseDim(v)?.px || 0)), 1);
        for (const [k, v] of spacing) {
            const dim = parseDim(v);
            const w = dim ? Math.max(2, (dim.px / maxPx) * 320) : 2;
            html += `<div class="scale-row">
                <span class="lbl">${esc(k)}</span>
                <div class="scale-bar" style="width:${w}px"></div>
                <span class="tval" style="font-family:var(--font-mono);font-size:12px;color:var(--text-color-muted)">${esc(String(v))}</span>
            </div>`;
        }
    }
    if (rounded.length) {
        html += '<p class="section-title">Corner radius</p><div class="radius-grid">';
        for (const [k, v] of rounded) {
            const dim = parseDim(v);
            const r = dim ? Math.min(dim.px, 42) : 0;
            html += `<div class="radius-item">
                <div class="radius-box" style="border-radius:${r}px"></div>
                ${esc(k)}<br><span style="color:var(--text-color-muted)">${esc(String(v))}</span>
            </div>`;
        }
        html += "</div>";
    }
    el.innerHTML = html;
}

// --- Components panel --------------------------------------------------------
function renderComponents(d) {
    const el = $("#panel-components");
    const comps = resolveComponents(d);
    const names = Object.keys(comps);
    if (!names.length) { el.innerHTML = emptyState("No components defined."); return; }
    let html = '<p class="section-title">Component preview</p><div class="comp-grid">';
    for (const name of names) {
        const props = comps[name];
        const bg = props.backgroundColor?.resolved;
        const fg = props.textColor?.resolved;
        const rounded = props.rounded?.resolved;
        const padding = props.padding?.resolved;
        const typo = props.typography?.resolved;
        const isCard = /card|surface|container|panel/i.test(name);
        const label = isCard ? "Content" : humanize(name);
        const renderStyle = [
            bg ? `background:${esc(String(bg))}` : "background:var(--surface,#fff)",
            fg ? `color:${esc(String(fg))}` : "",
            rounded ? `border-radius:${esc(String(rounded))}` : "",
            padding ? `padding:${esc(String(padding))}` : "padding:10px 16px",
            typo && typo.fontFamily ? `font-family:'${esc(String(typo.fontFamily))}',sans-serif` : "",
            typo && typo.fontSize ? `font-size:${esc(String(typo.fontSize))}` : "",
            typo && typo.fontWeight ? `font-weight:${esc(String(typo.fontWeight))}` : "font-weight:600",
            isCard ? "width:100%;text-align:left;box-shadow:0 1px 3px rgba(0,0,0,.12)" : "border:none;cursor:pointer",
        ].filter(Boolean).join(";");
        const tag = isCard ? "div" : "button";
        let propRows = "";
        for (const [p, info] of Object.entries(props)) {
            const shown = info.broken ? `${esc(String(info.raw))} ✗` : esc(String(info.resolved ?? info.raw));
            propRows += `<div class="${info.broken ? "broken" : ""}"><span>${esc(p)}</span><span>${shown}</span></div>`;
        }
        html += `<div class="comp-card">
            <div class="cname">${esc(name)}</div>
            <div class="comp-render"><${tag} style="${renderStyle}">${esc(label)}</${tag}></div>
            <div class="comp-props">${propRows}</div>
        </div>`;
    }
    html += "</div>";
    el.innerHTML = html;
}

function humanize(name) {
    return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- Contrast checker panel --------------------------------------------------
let ccInit = false;
function renderContrast(d) {
    const el = $("#panel-contrast");
    const colorNames = Object.keys(d.colors);
    const options = colorNames.map((n) => {
        const c = resolveColor(d.colors[n]);
        return { name: n, css: c ? `rgb(${c.r},${c.g},${c.b})` : null };
    }).filter((o) => o.css);

    if (!ccInit) {
        el.innerHTML = `
            <p class="section-title">Interactive contrast checker</p>
            <div class="cc-controls">
                <div class="cc-field"><label>Foreground (text)</label><select id="cc-fg"></select></div>
                <div class="cc-field"><label>Background</label><select id="cc-bg"></select></div>
            </div>
            <div class="cc-preview" id="cc-preview">
                <div class="big">Large heading sample</div>
                <div class="small">Normal body text — the quick brown fox jumps over the lazy dog.</div>
            </div>
            <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
                <div class="cc-ratio" id="cc-ratio">—</div>
                <div class="cc-badges" id="cc-badges"></div>
            </div>
            <p class="section-title" style="margin-top:26px">Component contrast audit</p>
            <div id="cc-audit"></div>`;
        ccInit = true;
        $("#cc-fg").addEventListener("change", updateContrast);
        $("#cc-bg").addEventListener("change", updateContrast);
    }

    const fgSel = $("#cc-fg"), bgSel = $("#cc-bg");
    const prevFg = fgSel.value, prevBg = bgSel.value;
    const optHtml = options.map((o) => `<option value="${esc(o.css)}" data-name="${esc(o.name)}">${esc(o.name)}</option>`).join("");
    fgSel.innerHTML = optHtml;
    bgSel.innerHTML = optHtml;
    // preserve selection across re-renders; otherwise sensible defaults (darkest fg, lightest bg)
    if (options.length) {
        fgSel.value = valueExists(fgSel, prevFg) ? prevFg : pickBy(options, true);
        bgSel.value = valueExists(bgSel, prevBg) ? prevBg : pickBy(options, false);
    }
    updateContrast();
    renderAudit(d);
}

// guard select values across re-renders
function valueExists(sel, v) { return !!v && [...sel.options].some((o) => o.value === v); }
function pickBy(options, wantDark) {
    let best = options[0].css, bestL = wantDark ? Infinity : -Infinity;
    for (const o of options) {
        const c = parseColorWith(o.css);
        if (!c) continue;
        const L = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        if (wantDark ? L < bestL : L > bestL) { bestL = L; best = o.css; }
    }
    return best;
}

function updateContrast() {
    const fg = $("#cc-fg")?.value, bg = $("#cc-bg")?.value;
    if (!fg || !bg) return;
    const cfg = parseColorWith(fg), cbg = parseColorWith(bg);
    const prev = $("#cc-preview");
    prev.style.background = bg;
    prev.style.color = fg;
    if (!cfg || !cbg) return;
    const ratio = contrastRatio(cfg, cbg);
    const levels = wcagLevels(ratio);
    $("#cc-ratio").textContent = ratio.toFixed(2) + ":1";
    $("#cc-badges").innerHTML = [
        badge("Normal AA", levels.normalAA),
        badge("Normal AAA", levels.normalAAA),
        badge("Large AA", levels.largeAA),
        badge("Large AAA", levels.largeAAA),
        badge("UI / Graphics", levels.uiAA),
    ].join("");
}

function badge(label, pass) {
    return `<div class="wcag-badge ${pass ? "pass-bg" : "fail-bg"}">
        <span class="k">${label}</span>
        <span class="v ${pass ? "pass" : "fail"}">${pass ? "PASS" : "FAIL"}</span>
    </div>`;
}

function renderAudit(d) {
    const comps = resolveComponents(d);
    const rows = [];
    for (const [name, props] of Object.entries(comps)) {
        const bg = props.backgroundColor?.resolved;
        const fg = props.textColor?.resolved;
        if (!bg || !fg) continue;
        const cbg = resolveColor(bg), cfg = resolveColor(fg);
        if (!cbg || !cfg) continue;
        const ratio = contrastRatio(cfg, cbg);
        const lv = wcagLevels(ratio);
        rows.push(`<tr>
            <td>${esc(name)}</td>
            <td><span class="swatch-pair"><span class="dot" style="background:rgb(${cfg.r},${cfg.g},${cfg.b})"></span>on<span class="dot" style="background:rgb(${cbg.r},${cbg.g},${cbg.b})"></span></span></td>
            <td style="font-family:var(--font-mono)">${ratio.toFixed(2)}:1</td>
            <td class="${lv.normalAA ? "pass" : "fail"}">${lv.normalAA ? "PASS" : "FAIL"}</td>
            <td class="${lv.largeAA ? "pass" : "fail"}">${lv.largeAA ? "PASS" : "FAIL"}</td>
        </tr>`);
    }
    const audit = $("#cc-audit");
    if (!rows.length) { audit.innerHTML = emptyState("No components define both text and background colors."); return; }
    audit.innerHTML = `<table class="audit-table">
        <thead><tr><th>Component</th><th>Pair</th><th>Ratio</th><th>Normal AA</th><th>Large AA</th></tr></thead>
        <tbody>${rows.join("")}</tbody></table>`;
}

// --- Lint panel --------------------------------------------------------------
function renderLint(p) {
    const el = $("#panel-lint");
    const s = p.summary;
    const engineLabel = p.engine === "official"
        ? '<span style="color:var(--text-color-muted);font-size:11px">engine: @google/design.md</span>'
        : p.engine === "bundled"
            ? '<span style="color:var(--text-color-muted);font-size:11px">engine: bundled (checking…)</span>'
            : '<span style="color:var(--text-color-muted);font-size:11px">engine: bundled</span>';
    let html = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <p class="section-title" style="margin:0">Linter findings</p>${engineLabel}</div>`;
    html += `<div class="lint-summary">
        <div class="lint-pill"><span class="n" style="color:#cf222e">${s.errors}</span><span class="l">Errors</span></div>
        <div class="lint-pill"><span class="n" style="color:#9a6700">${s.warnings}</span><span class="l">Warnings</span></div>
        <div class="lint-pill"><span class="n" style="color:#0969da">${s.info}</span><span class="l">Info</span></div>
    </div>`;
    if (!p.findings.length) {
        html += emptyState("✓ No findings. This DESIGN.md looks clean.");
    } else {
        const order = { error: 0, warning: 1, info: 2 };
        const sorted = [...p.findings].sort((a, b) => order[a.severity] - order[b.severity]);
        for (const f of sorted) {
            html += `<div class="finding">
                <span class="sev ${f.severity}">${f.severity}</span>
                <div class="fbody"><div class="fpath">${esc(f.path)}</div><div class="fmsg">${esc(f.message)}</div></div>
            </div>`;
        }
    }
    el.innerHTML = html;
}

// --- Prose panel (minimal markdown) ------------------------------------------
function renderProse(p) {
    const el = $("#panel-prose");
    if (!p.sections.length) { el.innerHTML = emptyState("No markdown sections found."); return; }
    let html = '<div class="prose">';
    for (const s of p.sections) {
        html += `<h2>${esc(s.heading)}</h2>` + mdToHtml(s.body);
    }
    html += "</div>";
    el.innerHTML = html;
}

function mdToHtml(md) {
    const lines = md.split(/\r?\n/);
    let out = "", inList = false;
    const inline = (t) => esc(t)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    for (const line of lines) {
        const l = line.trim();
        if (/^###\s+/.test(l)) { if (inList) { out += "</ul>"; inList = false; } out += `<h3>${inline(l.replace(/^###\s+/, ""))}</h3>`; }
        else if (/^-\s+/.test(l)) { if (!inList) { out += "<ul>"; inList = true; } out += `<li>${inline(l.replace(/^-\s+/, ""))}</li>`; }
        else if (l === "") { if (inList) { out += "</ul>"; inList = false; } }
        else { if (inList) { out += "</ul>"; inList = false; } out += `<p>${inline(l)}</p>`; }
    }
    if (inList) out += "</ul>";
    return out;
}

function emptyState(msg) { return `<div class="empty-state">${esc(msg)}</div>`; }

// --- Tabs --------------------------------------------------------------------
document.querySelectorAll(".dm-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".dm-tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".dm-panel").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById("panel-" + tab.dataset.panel).classList.add("active");
    });
});

// --- Collapsible source pane -------------------------------------------------
const COLLAPSE_KEY = "dm-editor-collapsed";
function setCollapsed(collapsed) {
    document.body.classList.toggle("editor-collapsed", collapsed);
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* ignore */ }
}
$("#collapse-btn")?.addEventListener("click", () => setCollapsed(true));
$("#expand-rail")?.addEventListener("click", () => setCollapsed(false));
try { if (localStorage.getItem(COLLAPSE_KEY) === "1") setCollapsed(true); } catch { /* ignore */ }

// --- Toolbar buttons ---------------------------------------------------------
loadInitial();
