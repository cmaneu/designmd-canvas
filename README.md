# DESIGN.md preview — a GitHub Copilot CLI canvas

A live, interactive canvas for [**DESIGN.md**](https://github.com/google-labs-code/design.md)
design-system files. Open it next to a `DESIGN.md` and get an instant preview of
colors, typography, layout tokens and components — plus a WCAG contrast checker
and a linter.

![type: canvas extension](https://img.shields.io/badge/Copilot%20CLI-canvas%20extension-blue)

## Features

- **Live preview** — edit the `DESIGN.md` source on the left, see colors,
  typography, spacing/radius, and rendered components update on the right.
- **Color tokens with WCAG flags** — every swatch shows white/black text
  contrast ratios badged green (passes AA 4.5:1) or red (fails). Colors where
  neither black nor white text reaches AA are flagged **⚠ low contrast**.
- **Contrast checker** — an interactive foreground/background checker plus an
  audit table of every component's text-on-background pair against WCAG AA.
- **Linter** — findings from the official
  [`@google/design.md`](https://www.npmjs.com/package/@google/design.md) linter
  when installed, with a bundled zero-dependency linter as an offline fallback.
- **Collapsible source pane** — collapse the editor to a thin rail to maximise
  preview space (remembered per browser).
- **Workspace auto-load** — on open with no input, it reads the `DESIGN.md` from
  the current session's workspace (`./`, `docs/`, or `.github/`). Edits are
  non-destructive — they persist to the canvas's own artifact, never written
  back to the repo file.

## Install

### From this repo (recommended)

Use the Copilot CLI **"Install extension from…"** flow (or the `install_extension`
tool) with this repo's folder URL:

```
https://github.com/cmaneu/designmd-canvas/tree/main
```

It installs into your **user scope** (`~/.copilot/extensions/designmd-canvas/`),
so it's available across all your sessions.

### Manual

Clone into your Copilot extensions directory:

```sh
git clone https://github.com/cmaneu/designmd-canvas \
  ~/.copilot/extensions/designmd-canvas
```

Then reload extensions (command palette → *Reload extensions*) or restart the
session.

### Optional: official linter engine

The extension works out of the box using the bundled linter. To enable the
official `@google/design.md` engine, install deps once:

```sh
cd ~/.copilot/extensions/designmd-canvas
npm install
```

## Usage

1. Open the **DESIGN.md preview** canvas (the agent can open it, or use the
   command palette). With a `DESIGN.md` in your workspace it loads automatically;
   otherwise a sample design system is shown.
2. Edit the source on the left — the preview, contrast checker, and lint findings
   update live.

### Agent-facing actions

| Action | Description |
| --- | --- |
| `load` | Load DESIGN.md `content` or a file `path` into the canvas. |
| `reload_workspace` | Re-read `DESIGN.md` from the workspace (`./`, `docs/`, `.github/`). |
| `get_report` | Return the linter report (summary, findings, parsed tokens). |
| `get_content` | Return the current source shown in the canvas, including edits. |

## How it works

Each open canvas instance runs a small loopback HTTP server that serves the
renderer and streams updates to the iframe over Server-Sent Events. Rendering is
driven by a bundled, zero-dependency parser (`parser.mjs` + `color.mjs`) so the
visual preview works even without `node_modules`. Lint findings come from the
official `@google/design.md` linter server-side when available, falling back to
the bundled linter otherwise.

State is stored per instance under
`~/.copilot/extensions/designmd-canvas/artifacts/` — the source `DESIGN.md` file
in your repo is never modified.

## License

ISC
