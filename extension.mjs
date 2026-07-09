// Extension: designmd-canvas
// Live preview, WCAG contrast checker, and linter for DESIGN.md design-system files.
//
// Each open canvas instance gets its own loopback HTTP server that serves the
// renderer shell + shared parsing modules, exposes JSON state/report endpoints,
// and pushes agent-initiated updates to the iframe over Server-Sent Events.
//
// Engine split: the browser renders visuals (colors, type, components, contrast)
// from the bundled zero-dependency parser.mjs. Lint findings come from the
// official `@google/design.md` linter when available, falling back to the
// bundled parser's findings so the extension still works when shared without
// node_modules.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { renderShell } from "./renderer.mjs";
import { parseDesignMd } from "./parser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ARTIFACTS_DIR = path.join(
    process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"),
    "extensions", "designmd-canvas", "artifacts",
);

const STATIC = {
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/client.js": { file: "client.js", type: "text/javascript; charset=utf-8" },
    "/parser.mjs": { file: "parser.mjs", type: "text/javascript; charset=utf-8" },
    "/color.mjs": { file: "color.mjs", type: "text/javascript; charset=utf-8" },
};

// --- Official linter (lazy, optional) ---------------------------------------
let officialLint; // undefined = not tried, null = unavailable, fn = ready
async function getOfficialLint() {
    if (officialLint !== undefined) return officialLint;
    try {
        const mod = await import("@google/design.md/linter");
        officialLint = typeof mod.lint === "function" ? mod.lint : null;
    } catch {
        officialLint = null;
    }
    return officialLint;
}

// Produce a normalized report: { engine, summary:{errors,warnings,info}, findings[], designSystem? }
async function runReport(content) {
    const lint = await getOfficialLint();
    if (lint) {
        try {
            const r = lint(content);
            const s = r.summary || {};
            return {
                engine: "official",
                summary: {
                    errors: s.errors ?? 0,
                    warnings: s.warnings ?? 0,
                    info: s.info ?? s.infos ?? 0,
                },
                findings: (r.findings || []).map((f) => ({
                    severity: f.severity,
                    path: f.path || "",
                    message: f.message,
                })),
                designSystem: r.designSystem,
            };
        } catch (err) {
            // fall through to bundled parser
        }
    }
    const parsed = parseDesignMd(content);
    return {
        engine: "fallback",
        summary: parsed.summary,
        findings: parsed.findings,
        designSystem: parsed.design,
    };
}

let DEFAULT_CONTENT = "";
async function defaultContent() {
    if (!DEFAULT_CONTENT) {
        try { DEFAULT_CONTENT = await readFile(path.join(__dirname, "default-design.md"), "utf8"); }
        catch { DEFAULT_CONTENT = "---\nname: My Design System\ncolors:\n  primary: \"#1A1C1E\"\n---\n\n## Overview\n"; }
    }
    return DEFAULT_CONTENT;
}

// instanceId -> { content, source, server, url, clients:Set<res> }
const instances = new Map();

const artifactPath = (instanceId) => path.join(ARTIFACTS_DIR, `${instanceId}.md`);
const metaPath = (instanceId) => path.join(ARTIFACTS_DIR, `${instanceId}.json`);

// Common locations a DESIGN.md might live in a workspace, in priority order.
const WORKSPACE_CANDIDATES = [
    "DESIGN.md", "design.md", "Design.md",
    "docs/DESIGN.md", "docs/design.md",
    ".github/DESIGN.md", "design/DESIGN.md",
];

async function findWorkspaceDesignMd(workspacePath) {
    if (!workspacePath) return null;
    for (const rel of WORKSPACE_CANDIDATES) {
        const abs = path.join(workspacePath, ...rel.split("/"));
        if (existsSync(abs)) {
            try {
                const content = await readFile(abs, "utf8");
                return { path: abs, display: rel, content };
            } catch { /* keep looking */ }
        }
    }
    return null;
}

async function persist(instanceId, content) {
    try {
        await mkdir(ARTIFACTS_DIR, { recursive: true });
        await writeFile(artifactPath(instanceId), content, "utf8");
    } catch { /* best effort */ }
}

async function persistMeta(instanceId, meta) {
    try {
        await mkdir(ARTIFACTS_DIR, { recursive: true });
        await writeFile(metaPath(instanceId), JSON.stringify(meta), "utf8");
    } catch { /* best effort */ }
}

async function ensureState(instanceId, seed, source) {
    let entry = instances.get(instanceId);
    if (!entry) {
        entry = { content: "", source: null, server: null, url: null, clients: new Set() };
        instances.set(instanceId, entry);
        const p = artifactPath(instanceId);
        if (existsSync(p)) {
            try { entry.content = await readFile(p, "utf8"); } catch { /* ignore */ }
            try {
                if (existsSync(metaPath(instanceId))) {
                    const m = JSON.parse(await readFile(metaPath(instanceId), "utf8"));
                    if (m && typeof m.source === "string") entry.source = m.source;
                }
            } catch { /* ignore */ }
        }
    }
    if (typeof source === "string" && source.length) {
        entry.source = source;
        await persistMeta(instanceId, { source });
    }
    if (typeof seed === "string" && seed.length) {
        entry.content = seed;
        await persist(instanceId, seed);
    }
    if (!entry.content) entry.content = await defaultContent();
    return entry;
}

function pushToClients(entry, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of entry.clients) {
        try { res.write(payload); } catch { /* client gone */ }
    }
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; if (body.length > 5_000_000) req.destroy(); });
        req.on("end", () => resolve(body));
        req.on("error", () => resolve(""));
    });
}

async function startServer(instanceId) {
    const entry = instances.get(instanceId);
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        const pathname = url.pathname;

        if (pathname === "/" || pathname === "/index.html") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(renderShell());
            return;
        }
        if (STATIC[pathname]) {
            try {
                const content = await readFile(path.join(__dirname, STATIC[pathname].file), "utf8");
                res.setHeader("Content-Type", STATIC[pathname].type);
                res.end(content);
            } catch {
                res.statusCode = 404; res.end("not found");
            }
            return;
        }
        if (pathname === "/state") {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ content: entry.content, source: entry.source || null }));
            return;
        }
        if (pathname === "/update" && req.method === "POST") {
            const body = await readBody(req);
            try {
                const data = JSON.parse(body || "{}");
                if (typeof data.content === "string") {
                    entry.content = data.content;
                    await persist(instanceId, data.content);
                }
            } catch { /* ignore */ }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (pathname === "/api/lint" && req.method === "POST") {
            const body = await readBody(req);
            let content = entry.content;
            try {
                const data = JSON.parse(body || "{}");
                if (typeof data.content === "string") content = data.content;
            } catch { /* use current */ }
            const report = await runReport(content);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ engine: report.engine, summary: report.summary, findings: report.findings }));
            return;
        }
        if (pathname === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            res.write(": connected\n\n");
            entry.clients.add(res);
            const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* */ } }, 25000);
            req.on("close", () => { clearInterval(ping); entry.clients.delete(res); });
            return;
        }
        res.statusCode = 404;
        res.end("not found");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    entry.server = server;
    entry.url = `http://127.0.0.1:${port}/`;
    return entry;
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "designmd-canvas",
            displayName: "DESIGN.md preview",
            description: "Live preview, WCAG contrast checker, and linter for a DESIGN.md design-system file.",
            inputSchema: {
                type: "object",
                properties: {
                    content: { type: "string", description: "Inline DESIGN.md file contents to load into the canvas." },
                    path: { type: "string", description: "Absolute path to a DESIGN.md file to read and preview." },
                },
                additionalProperties: false,
            },
            open: async (ctx) => {
                let seed = typeof ctx.input?.content === "string" ? ctx.input.content : undefined;
                let source;
                const filePath = typeof ctx.input?.path === "string" ? ctx.input.path : undefined;
                if (!seed && filePath) {
                    try { seed = await readFile(filePath, "utf8"); source = filePath; }
                    catch { await session.log(`Could not read DESIGN.md at ${filePath}`, { level: "warn" }); }
                }
                // Auto-load the workspace DESIGN.md when nothing was supplied and this
                // instance has no durable artifact yet (first open in a fresh session).
                const fresh = !instances.has(ctx.instanceId) && !existsSync(artifactPath(ctx.instanceId));
                if (!seed && fresh) {
                    const ws = await findWorkspaceDesignMd(session.workspacePath);
                    if (ws) {
                        seed = ws.content;
                        source = ws.display;
                        await session.log(`DESIGN.md canvas: loaded ${ws.display} from workspace.`, { level: "info", ephemeral: true });
                    }
                }
                const entry = await ensureState(ctx.instanceId, seed, source);
                if (!entry.server) await startServer(ctx.instanceId);
                if (seed) pushToClients(entry, "load", { content: entry.content, source: entry.source });
                return { title: "DESIGN.md preview", url: entry.url, status: entry.source ? "linked" : "ready" };
            },
            actions: [
                {
                    name: "load",
                    description: "Load DESIGN.md content into the canvas and refresh the live preview.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            content: { type: "string", description: "DESIGN.md file contents to preview." },
                            path: { type: "string", description: "Absolute path to a DESIGN.md file to read and preview." },
                        },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        let content = typeof ctx.input?.content === "string" ? ctx.input.content : undefined;
                        let source;
                        if (!content && typeof ctx.input?.path === "string") {
                            try { content = await readFile(ctx.input.path, "utf8"); source = ctx.input.path; }
                            catch { throw new CanvasError("read_failed", `Could not read file: ${ctx.input.path}`); }
                        }
                        if (typeof content !== "string") {
                            throw new CanvasError("invalid_input", "Provide either `content` or `path`.");
                        }
                        const entry = await ensureState(ctx.instanceId, undefined, source);
                        entry.content = content;
                        await persist(ctx.instanceId, content);
                        pushToClients(entry, "load", { content, source: entry.source });
                        const report = await runReport(content);
                        return { ok: true, engine: report.engine, summary: report.summary };
                    },
                },
                {
                    name: "reload_workspace",
                    description: "Re-read the DESIGN.md from the current workspace (root, docs/, .github/) and refresh the canvas, discarding unsaved edits in the canvas.",
                    handler: async (ctx) => {
                        const ws = await findWorkspaceDesignMd(session.workspacePath);
                        if (!ws) {
                            throw new CanvasError("not_found", session.workspacePath
                                ? "No DESIGN.md found in the workspace (looked in root, docs/, .github/)."
                                : "This session has no workspace to read a DESIGN.md from.");
                        }
                        const entry = await ensureState(ctx.instanceId, ws.content, ws.display);
                        pushToClients(entry, "load", { content: entry.content, source: entry.source });
                        const report = await runReport(ws.content);
                        return { ok: true, source: ws.display, engine: report.engine, summary: report.summary };
                    },
                },
                {
                    name: "get_report",
                    description: "Return the linter report (summary, findings, parsed tokens) for the canvas's current DESIGN.md.",
                    handler: async (ctx) => {
                        const entry = await ensureState(ctx.instanceId);
                        return await runReport(entry.content);
                    },
                },
                {
                    name: "get_content",
                    description: "Return the current DESIGN.md source shown in the canvas (including any live edits).",
                    handler: async (ctx) => {
                        const entry = await ensureState(ctx.instanceId);
                        return { content: entry.content };
                    },
                },
            ],
            onClose: async (ctx) => {
                const entry = instances.get(ctx.instanceId);
                if (entry) {
                    for (const res of entry.clients) { try { res.end(); } catch { /* */ } }
                    entry.clients.clear();
                    if (entry.server) {
                        await new Promise((resolve) => entry.server.close(() => resolve()));
                    }
                    instances.delete(ctx.instanceId);
                }
            },
        }),
    ],
});
