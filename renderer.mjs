// HTML shell for the DESIGN.md canvas. Assets (styles.css, client.js, parser.mjs,
// color.mjs) are served as separate files by the extension server so the browser
// can import the shared parsing modules directly.

export function renderShell() {
    return `<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <title>DESIGN.md preview</title>
    <link rel="stylesheet" href="styles.css" />
</head>
<body>
    <header class="dm-header">
        <div class="dm-title">
            <span class="name" id="ds-name">Loading…</span>
            <span class="meta" id="ds-meta"></span>
        </div>
        <div class="spacer"></div>
    </header>
    <div class="dm-body">
        <button class="expand-rail" id="expand-rail" title="Show DESIGN.md source">
            <span class="chev">›</span><span class="rail-label">DESIGN.md source</span>
        </button>
        <div class="dm-editor-pane" id="editor-pane">
            <div class="pane-label">
                <span class="pane-label-text">DESIGN.md source</span>
                <span class="src-path" id="src-path" title=""></span>
                <button class="collapse-btn" id="collapse-btn" title="Collapse source">‹</button>
            </div>
            <textarea id="editor" spellcheck="false" autocomplete="off"></textarea>
        </div>
        <div class="dm-preview-pane">
            <div class="dm-tabs">
                <button class="dm-tab active" data-panel="colors">Colors</button>
                <button class="dm-tab" data-panel="typography">Typography</button>
                <button class="dm-tab" data-panel="layout">Layout</button>
                <button class="dm-tab" data-panel="components">Components</button>
                <button class="dm-tab" data-panel="contrast">Contrast</button>
                <button class="dm-tab" data-panel="lint">Lint<span class="badge" id="tabbadge-lint-err" style="display:none"></span><span class="badge" id="tabbadge-lint-warn" style="display:none"></span></button>
                <button class="dm-tab" data-panel="prose">Prose</button>
            </div>
            <div class="dm-scroll">
                <div class="dm-panel active" id="panel-colors"></div>
                <div class="dm-panel" id="panel-typography"></div>
                <div class="dm-panel" id="panel-layout"></div>
                <div class="dm-panel" id="panel-components"></div>
                <div class="dm-panel" id="panel-contrast"></div>
                <div class="dm-panel" id="panel-lint"></div>
                <div class="dm-panel" id="panel-prose"></div>
            </div>
        </div>
    </div>
    <script type="module" src="client.js"></script>
</body>
</html>`;
}
