# Publishing desk-mcp

Everything that needs an account, a token or a browser session lives here, so the
next release does not have to rediscover it. Steps marked **(owner)** cannot be
finished from an agent session: they need your npm login, your GitHub fork and your
browser.

## 1. npm  (owner)

The package name `desk-mcp` is free on the registry (checked: `registry.npmjs.org/desk-mcp`
answers 404, which means unclaimed, not taken).

```bash
cd C:\Users\DigitalJesus\.minimax\workspace\desk-mcp
npm login                       # or: npm adduser
npm pack                        # desk-mcp-1.4.0.tgz
npm publish desk-mcp-1.4.0.tgz  # add --access public on the first publish
```

Before publishing, check the tarball actually contains the native UIA layer:

```bash
npm pack --dry-run              # uia-native.cs must be in the list
```

This used to be the worst bug in the package: `worker.ps1` loads
`Join-Path $PSScriptRoot 'uia-native.cs'` and quietly degrades to the slow
PowerShell path when the file is missing, so an npm install without that file ran
without the STA pool, without the cancelable timeout and seven times slower.
`uia-native.cs` is in `files` now, and the tarball is verified by installing it
into a scratch directory and checking that the worker prints
`UIA-DIAG: RunTree(...) -> ok=True` with `DESK_UIA_DIAG=1`.

Version lives in two places and they have drifted once already:
`package.json` and `server.mjs` (`new McpServer({ ... version })`).

## 2. awesome-mcp-servers  (owner)

Target: `punkpeye/awesome-mcp-servers`, section `### 🖥️ OS Automation`.

Requirements that actually matter, taken from that repository:

- The entry must carry a **Glama badge**, otherwise CI (`check-glama.yml`) fails the
  run with `missing-glama`. Ours is live and answers 200.
- Only emojis from the legend are allowed: `📇` JavaScript, `🏠` runs locally,
  `🪟` Windows.
- The name has to be exactly `owner/repo`.
- There is no star threshold and no quality checklist beyond the badge check.

Ready to paste line, append at the end of the OS Automation section (after
`Dominic-DK/askew-mcp`, around line 3299 at the time of writing):

```markdown
- [DigitalDog1/desk-mcp](https://github.com/DigitalDog1/desk-mcp) [![DigitalDog1/desk-mcp MCP server](https://glama.ai/mcp/servers/DigitalDog1/desk-mcp/badges/score.svg)](https://glama.ai/mcp/servers/DigitalDog1/desk-mcp) 📇 🏠 🪟 - Windows desktop control in pure Node.js with zero external binaries: screenshots, OCR, mouse and keyboard input, and element trees that fall back from UI Automation to MSAA to Chrome DevTools Protocol to OCR, with a per-window circuit breaker for applications that hang.
```

PR title, per their CONTRIBUTING convention for agent-submitted PRs:

```
Add DigitalDog1/desk-mcp 🤖🤖🤖
```

There is already Windows tooling in that section (`Harusame64/desktop-touch-mcp`,
`glasswarp/mcp-server`, `fixed-width/glass`, `munimtechnologies/munim-computer-use`,
`faze79/WPFVisualTreeMcp`). Two things are different about this one and both are in
the line above: no external binaries at all, and the degradation chain that ends in
OCR rather than stopping at an empty tree.

## 3. Smithery  (owner)

Current Smithery does not document a `server.json` with a `schema$` field. The
local path is an **MCPB bundle** (`manifest.json` per the MCPB spec,
https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md), or hosting by
URL at `https://smithery.ai/new`.

`mcpb/manifest.json` in this repo follows that spec (manifest_version 0.3). The
bundle it describes has to look like this, because `server.mjs` resolves its
worker relative to itself and Node dependencies must be inside the bundle:

```
desk-mcp.mcpb
├── manifest.json
├── package.json
├── node_modules/        bundled: @modelcontextprotocol/sdk, zod
└── server/
    ├── server.mjs
    ├── worker.ps1
    ├── uia-native.cs
    └── bench.ps1
```

```bash
npm install -g @anthropic-ai/mcpb
npm install -g smithery@latest      # the package is `smithery`, not @smithery/cli
smithery auth login                  # browser OAuth (owner)
smithery mcp publish ./desk-mcp.mcpb -n <org>/desk-mcp
```

Unconfirmed, check before relying on it: whether Smithery accepts a Windows-only
stdio bundle. The MCPB spec lists `win32` as a valid platform, but that is the
bundle format, not a promise from the registry.

`author.name` in `mcpb/manifest.json` is set to the GitHub handle `DigitalDog1`.
Replace it if you would rather ship your real name.

## 4. Glama

Already registered and answering, badge shows a rating. Nothing to do except keep
the README honest: people click through from that badge, and every claim at the top
of the README is backed by a measurement in the repository.