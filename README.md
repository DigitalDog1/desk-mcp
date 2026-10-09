# desk-mcp

<p align="center">
  <a href="README.md">English</a> | <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="https://glama.ai/mcp/servers/DigitalDog1/desk-mcp"><img src="https://glama.ai/mcp/servers/DigitalDog1/desk-mcp/badges/score.svg" alt="Glama score" width="120"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node 20 or newer" height="20">
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4" alt="Windows 10 or 11" height="20">
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache 2.0" height="20">
  <img src="https://img.shields.io/badge/dependencies-0%20native-success.svg" alt="Zero native dependencies" height="20">
  <img src="https://img.shields.io/badge/tests-85%20passed-brightgreen.svg" alt="85 tests passed" height="20">
</p>

**Control Windows applications with your AI assistant — with zero native dependencies.**

Direct accessibility controls first, pixels when needed, input through WinAPI. Click buttons by name or element ID, read 200+ row tables in milliseconds, type without stealing focus, and save up to 99% of tokens with differential snapshots. Built with pure Node.js and the PowerShell that ships with Windows — no .NET SDK, no Python, no compilers, no native modules. Works with Claude Desktop, Cursor, VS Code, Windsurf, and any MCP client.

---

<h3 align="center">⚡ Live Demo: 10 Actions in 2.2 Seconds (Hands-Off)</h3>

![desk-mcp demo: five UI Automation pattern actions on a WinForms window, no pixel clicks, the cursor never moves](docs/demo.gif)

<p align="center"><sub>24 seconds, muted. <a href="https://raw.githubusercontent.com/DigitalDog1/desk-mcp/main/docs/demo.mp4">MP4</a> or <a href="https://raw.githubusercontent.com/DigitalDog1/desk-mcp/main/docs/demo.webm">WebM</a> for the full size file.</sub></p>

The window above is a plain WinForms app (`examples/demo-app.ps1`). Five complex actions land with zero pixel clicks, zero vision hallucinations, and the mouse cursor stays parked in the log box while `ValuePattern` and `InvokePattern` fill the fields, trigger the search, reload the list, mark the parcel delivered, and copy its tracking number. Run `node examples/demo.mjs` to reproduce all 10 steps in 2.2 seconds!

---

## Why this and not a screenshot loop

Most computer-use agents rely solely on screenshots: capture an image, send thousands of vision tokens to an LLM, guess pixel coordinates, click, and repeat. desk-mcp puts **direct controls first**:

| Task | Screenshot-Only Approach | desk-mcp (Direct Controls First) |
| :--- | :--- | :--- |
| Click a button | Guess coordinates from image (goes stale, DPI scaling breaks) | Click named element directly via `InvokePattern` or `elementId` |
| Read tables / lists | Hallucination-prone OCR; slow multi-page scrolling | `computer_read_table`: entire table read in a single call |
| Check checkbox / state | Guess visual checked state from pixel appearance | Inspect boolean `selected` state directly via `computer_verify_state` |
| Track UI changes | Re-capture full screen image every step (high token bill) | `mode: auto` differential snapshots send strictly what changed |
| Multi-step action sequence | Multiple network round-trips to LLM (high latency) | `computer_batch` executes complete pipelines in a single round-trip |
| User cursor position | Mouse jumps around screen, interrupts user's typing | Hands-off: controls act in background without moving cursor |

- **Precision over Hallucination**: `computer_find { name: "Search" }` returns the element with its `automationId`, bounding box, and supported patterns. Coordinates read off a screenshot are already stale by the time you click them.
- **Four Read Layers with Automatic Fallback**: UI Automation, then MSAA through `oleacc`, then Chrome DevTools Protocol (CDP) for Chromium pages, then Windows OCR (`Windows.Media.Ocr`). If UIA returns an empty tree, desk-mcp automatically falls through to the next layer and reports its `backend`.
- **Freeze-Resilient Circuit Breaker**: UI Automation communicates over COM and never gives up on a frozen window (Steam, 1C, hanging WPF). Every call here runs on an STA thread with a hard cancelable timeout, and a failing window trips a 90 s circuit breaker while all other windows remain responsive.
- **Zero External Binaries**: Pure Node.js + Windows built-in PowerShell 5.1. Instant `npx -y desk-mcp` — no Visual C++ Build Tools, no .NET 10 SDK, no Python, nothing to compile.

## Install

```bash
npm install -g desk-mcp
```

or from a clone:

```bash
git clone https://github.com/DigitalDog1/desk-mcp.git
cd desk-mcp
npm install
```

Requires Node.js 20+ and Windows 10 1809 or Windows 11.

### Connect

Add to your MCP client config (**Claude Desktop** at `%APPDATA%\Claude\claude_desktop_config.json`, **Cursor** at `.cursor/mcp.json`, or **Windsurf** / **VS Code**):

```json
{
  "mcpServers": {
    "desk-mcp": {
      "command": "npx",
      "args": ["-y", "desk-mcp"]
    }
  }
}
```

From a clone, swap `npx` for `node` and point `args` at `server.mjs`. Restart the client and the tools are there immediately.

## Try it in 60 seconds

```bash
# 1. a window to work with (English labels, logs every action into itself)
powershell -NoProfile -ExecutionPolicy Bypass -STA -File examples\demo-app.ps1

# 2. the agent side: find by meaning, write through ValuePattern,
#    press through InvokePattern, then verify the result
node examples/demo.mjs
```

```
--- 1. Find window "Parcel Tracker" and the Search button by automationId
{
  "count": 1,
  "elements": [
    {
      "name": "Search",
      "type": "Button",
      "id": "btnSearch",
      "class": "WindowsForms10.BUTTON.app.0.ab05f7_r37_ad1",
      "rect": { "x": 530, "y": 173, "w": 120, "h": 32 },
      "enabled": true,
      "offscreen": false,
      "patterns": [ "InvokePattern" ]
    }
  ]
}

--- 3. Write the tracking number through ValuePattern, no focus and no mouse
{
  "ok": true,
  "via": "ValuePattern",
  "value": "ZX-9026-1147",
  "element": { "name": "Tracking number:", "type": "Edit", "id": "searchBox", ... }
}

--- 4. Press Search through InvokePattern
{ "ok": true, "via": "InvokePattern", "element": { "id": "btnSearch", ... } }

--- 5. Verify the field value, not just that a click happened
{ "ok": true, "checks": [ { "state": "satisfied", "detail": "found 1" } ] }

--- 6. Press Copy tracking number and read the clipboard
clipboard: "ZX-4471-8820" (12 chars)
```

On a localized Windows the caption buttons come back with translated names (`Close`, `Maximize`, `Minimize` in Russian on a Russian install). Prefer `automationId` over caption text, or the agent will break on the user's locale.

## The same window with the cursor

![the same window driven by coordinates: the cursor walks, and a WinForms button ignores an instant click](docs/demo-cursor.gif)

<p align="center"><sub>Same window, same visible result, other mechanism. <a href="https://raw.githubusercontent.com/DigitalDog1/desk-mcp/main/docs/demo-cursor.mp4">MP4</a> or <a href="https://raw.githubusercontent.com/DigitalDog1/desk-mcp/main/docs/demo-cursor.webm">WebM</a> for the full size version.</sub></p>

Plain `computer_click` on coordinates, so the cursor walks and the app cannot tell the difference. A WinForms button also ignores a synthetic click that arrives in the same instant as the cursor: `nudge` does not fix it, `hoverFirst: true` does (250 ms over the control before the press). Measured on the same coordinates and the same window, without the hover the counter stayed at 0, with it the event landed. Default to `hoverFirst: true` for pixel clicks into an app you have not tried yet.

## What it costs, measured

`npm run bench:full` walks every visible window, measures each read several times, takes the median, and prints token and latency numbers. Text tokens are `chars / 4`, image tokens follow Anthropic's `width * height / 750`. Numbers below come from Windows 10, i5-12400F, Node 24, with live windows:

| Window | Size | `find` | Whole tree | `compact` | Filtered tree | Repeat (`auto`) | Picture | OCR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Microsoft Edge (Browser) | 2576x1416 | 110 | 8552 | 7388 | 197 | 38 | 4864 | 16191 |
| File Explorer (Folders) | 1270x859 | 98 | 57844 | 47874 | 2764 | 38 | 1455 | 6808 |
| LibreOffice (Office) | 2576x1416 | 99 | 29096 | 24486 | 6797 | 38 | 4864 | 17927 |
| Font Catalog (Data Grid) | 896x599 | 97 | 54514 | 43708 | 4142 | 38 | 716 | 3424 |
| Parcel Tracker (Demo App) | 940x640 | 83 | 12837 | 10536 | 3135 | 38 | 803 | 5074 |
| MS Paint (Canvas & Tools) | 1843x1005 | 83 | 8247 | 6843 | 1898 | 38 | 2470 | 6285 |

Filtered tree is `maxDepth: 4, interactiveOnly: true, compact: true`. Repeat is the same read again through `mode: auto` carrying the token from the previous answer. Picture tokens come from the measured pixel size of the returned image, not from the window rectangle.

Key takeaways from real-window measurements:

- **Filtering changes everything**: A raw, unpruned UI tree includes deeply nested internal containers (8,000 to 58,000 tokens). Applying sensible filters (`maxDepth: 4, interactiveOnly: true, compact: true`) reduces token weight down to 197–2,700 tokens — up to 25 times cheaper than a screenshot while keeping every interactive element directly addressable.
- **Differential snapshots (`mode: auto`) save 99.7% of tokens**: The first inspection provides the baseline; every subsequent call carrying the previous token returns strictly the delta (just 38 tokens on repeated reads against 8,552 to 57,844 for the first one). That is the cheapest line in the table and the reason to send the token back.
- **Addressability over guesses**: A picture provides zero addressable controls; every click requires a visual coordinate estimate that easily breaks on scaling or window movement. UI Automation gives named elements at ~100 tokens each with exact control IDs and patterns.
- **Data-Dense Tasks (Font Catalog: 246 items)**: When an agent needs to locate an item in a large list or table, visual scrolling requires 14 screenshot pages, 29 tool calls, and 73 seconds. In desk-mcp, `computer_read_table` reads all 246 rows in 158 ms, allowing the agent to complete the entire goal in 3 calls and 7.9 seconds (9.4 times faster, 10 times fewer round-trips).
- `compact` saves 14% to 18% on large trees.
- OCR is the weakest reader of a whole window and the strongest one when coordinates are known: a 420x40 strip costs 296 tokens against 3135 for the filtered tree, and a picture of that same strip costs 23.
- Walking the tree is slower than taking the picture: ~65 ms against 16 ms on native windows. UIA is COM into another process.

### Where this loses

- **Coordinates are already known.** Reading a whole window to get one field costs 6 to 11 times more than OCR of that field.
- **No filter, and the question is visual.** A picture is 3 to 16 times cheaper, and it is the only one that answers "what colour is the button" or "is the layout broken". Those answers are not in the structure at any price.
- **A stale token.** Every `mode: auto` answer returns a new token and the next call must carry it. Reuse the old one and the whole tree comes back, 67 to 426 times more tokens. That is deliberate: a diff against a baseline the caller no longer holds would be invented.
- **A window that repaints itself.** Changes pile up, the delta outgrows the full view, and the server returns the full view.
- **No accessibility tree** (games, UWP, protected content). The answer arrives as `kind: fallback` with OCR text and no delta, which is what Wallpaper UI shows above.
- **A grid without a header row.** `TablePatternInformation` in .NET has no "this row is the header" flag, so `computer_read_table` treats the first row as the header by convention. `headers: false` reads every row as data.

### What this benchmark does not measure

- The numbers belong to this machine and to the windows that were open. Another machine gives another table, possibly another order of magnitude.
- It measures the cost of reading, not whether an agent picked the right tool.
- Nothing is loaded on purpose: no busy app in parallel, no window being resized, no multi-monitor DPI change.
- Text tokens use `chars / 4`. Cyrillic really costs more, and both sides lose the same way.
- Image tokens follow the published formulas. The real bill depends on the model and on how the client tiles the picture.

`npm run bench` is the older token-only comparison, `npm run bench:full` is the full screen benchmark, and `npm run bench:fonts` benchmarks real task execution on a 246-item table. Window resolution goes through `user32` directly from that handle, so a badly behaved neighbour never stalls the server. Full walk of the demo app, start to finish: `node examples/demo.mjs` finishes in 2.2 s.

## The 46 tools

**Eyes**

- `computer_screenshot`: whole screen, any region, or a single window through `PrintWindow` or `hwnd`, working even on occluded and minimized windows. PNG or JPEG, any scale.
- `computer_ocr`: text straight from pixels with Windows built-in OCR (`Windows.Media.Ocr`). Supports 4K/8K tile slicing, transparency alpha compensation, listing installed languages (`languages: true`), and Set-of-Marks visual overlay badges (`mark: "rect"`). Words come back with bounding boxes so you can click on them.
- `computer_screeninfo`: virtual screen bounds and every attached monitor.
- `computer_permissions`: checks whether UI Automation, clipboard, and window enumeration actually work on this machine, failing fast at setup instead of midway through an agent run.

**Interface tree**

- `computer_read_screen`: UI Automation with automatic MSAA fallback, dynamic depth growth, and OCR fallback (reports `backend` and `degraded`). `mode: auto` with `since` returns only modified nodes; `compact`, `maxChars`, `maxDepth`, `maxElements`, and `interactiveOnly` dramatically reduce context. Supports `truncatedReason`.
- `computer_read_table`: headers and rows of a grid, list, or Details view through `GridPattern`, one call instead of walking the entire tree. First row is read as header by convention (`headersByConvention`); `headers: false` disables it.
- `computer_find`: find elements by name, role, `automationId`, regex pattern (`nameRegex`), or exact match (`requireUnique`). Reports `searchIncomplete` when budget is reached.
- `computer_element_at`: inspects the chain of elements directly under a point.
- `computer_browser_start`, `computer_browser_list`, `computer_browser_tree`, `computer_browser_descendants`, `computer_browser_eval`, `computer_browser_click`: real page DOM via Chrome DevTools Protocol (computer_browser_*), with CSS selectors and clicks reporting what actually received the event.

**Hands**

- `computer_click` (modifiers, `nudge`, `scale`, `hoverFirst`), `computer_move`, `computer_cursor`, `computer_mouse_move`, `computer_drag`, `computer_scroll`, `computer_mouse_button`, `computer_type` (supports `inputMode: paste` and `delayMs`), `computer_key`, `computer_key_down` / `computer_key_up`, `computer_wait`.
- `computer_polyline`: one continuous stroke through a list of points. N separate drags lift the pen on every vertex and arrive as broken segments.
- `computer_invoke`: triggers `InvokePattern` without moving the mouse or focusing the window. Addressed by name or directly by `elementId` from `computer_find`.
- `computer_set_value`: writes through `ValuePattern` without focus, accepts `elementId` and `inputMode: value | type | paste`.
- `computer_select`: picks a value in a dropdown, combo box, list, or tab through `SelectionItem` and `ExpandCollapse`, opening and closing it automatically (accepts `elementId`). A pattern that runs without selecting anything returns `notSelected`.
- `computer_batch`: up to 50 tools in one call, executed sequentially with parameter substitution (`"${steps.0.element.name}"`), turning read-decide-act loops into a single network round-trip.

**Windows and desktop**

- `computer_windows`: visible top-level windows with `title`, `hwnd`, `process`, `class`, and bounds. Send `hwnd` in later calls so windows remain reachable when their titles change dynamically.
- `computer_focus`, `computer_wait_window`, `computer_active_window`, `computer_window_set_frame`, `computer_close_window`, `computer_launch`, `computer_desktop` (virtual desktops), `computer_bench`, `computer_clipboard_get`, and `computer_clipboard_set`.

**Verification**

- `computer_verify_state`: asserts predicates `exists`, `value_equals`, `enabled`, `selected`. `unknown` is reported as `unknown` and never as success.
- `computer_wait_element`: waits for an element to appear, disappear, or reach a state (`enabled`, `disabled`, `visible`, `offscreen`, `on`, `off`, `indeterminate`) instead of blind sleeps. Timeout returns `satisfied: false` with `reason: timeout`.
- `computer_invoke`, `computer_set_value`, and `computer_select_text` refuse on `enabled: false`, preventing silent failures on disabled controls.
- Every failure carries a typed `code` (`ElementNotFound`, `ElementDisabled`, `OptionNotFound`, `PatternUnavailable`, `NotSelected`, `WindowNotFound`, `NeedsConfirm`, `BlockedByList`, `InvalidArgument`, `NotSupported`, `WorkerRestarted`, `Timeout`, `UIABlocked`, `CaptureFailed`, `InputBlocked`, `AmbiguousMatch`).
- `computer_selftest` verifies the entire communication channel end-to-end.

## How it works

```
server.mjs      MCP server in Node over stdio, CDP client, circuit breaker
worker.ps1      one long-lived PowerShell: user32, UI Automation, MSAA, OCR
uia-native.cs   C# 5: STA pool with a queue, cancelable timeout, thread rebirth
```

One worker process runs for the lifetime of the server. Communication is line-based with base64 responses to guarantee encoding integrity across Windows console codepages.

| Layer | What it gives | When it is used |
| --- | --- | --- |
| UIA | exact `automationId`, patterns, bounds | native and managed Windows apps |
| MSAA | `oleacc`, depth grows automatically | when UIA returned an empty tree |
| CDP | the real page DOM with CSS selectors | Chromium windows, exact selectors |
| OCR | words with boxes, no element identity | games, video, GPU drawn content |

The fallback hierarchy matters. For Chromium, UIA returns nameless panels unless started with `--force-renderer-accessibility`; the built-in CDP layer gives direct DOM access and verification.

## When a window hangs

UI Automation calls into other processes over COM. If a target app hangs or holds a modal dialog, the COM RPC call never returns. desk-mcp resolves this completely:

- `uia-native.cs` runs reads on a dedicated STA thread with a hard cancelable timeout. Expired threads are poisoned and replaced by fresh threads while the abandoned thread terminates in the background.
- It is ~7x faster than pure PowerShell: 147 ms vs 1014 ms on the same qBittorrent window.
- Automatic Circuit Breaker: failing calls trip a per-window circuit breaker for 90 s, returning instant errors instead of stalling again. All other windows remain unaffected.
- Generous 8 s overall deadline protects against hung external workers.

`DESK_UI_TIMEOUT_MS`, `DESK_UI_COOLDOWN_MS`, and `DESK_UIA_BUDGET_MS` customize these budgets.

When an app hangs, desk-mcp reports the failure immediately:

```
Error: UI Automation hung on 'invoke|modorganizer': no response in 8 s, worker restarted.
Window does not answer UIA - calls to it are blocked for 90 s.
Next: computer_screenshot + computer_ocr, or another window.
```

## Games

Shooters and 3D games read mouse input via raw input and ignore absolute cursor moves. Use relative motion with small increments:

```json
{ "tool": "computer_mouse_move", "args": { "dx": 220, "dy": -40, "steps": 20, "stepMs": 8 } }
```

Drawing applications like MS Paint ignore instantaneous clicks without motion. Nudge by one pixel:

```json
{ "tool": "computer_click", "args": { "x": 800, "y": 400, "nudge": 1 } }
```

WinForms buttons require the cursor to arrive *before* the press: use `hoverFirst: true` (250 ms hover before clicking):

```json
{ "tool": "computer_click", "args": { "x": 590, "y": 189, "hoverFirst": true } }
```

Scale coordinates automatically when working with downscaled screenshots:

```json
{ "tool": "computer_screenshot", "args": { "region": "0,0,2560,1440", "scale": 0.5 } }
{ "tool": "computer_click", "args": { "x": 640, "y": 360, "scale": 0.5 } }
```

## Safety

`computer_close_window` and `computer_launch` are destructive and require an explicit `confirm: true`. Text read off the screen is treated as data, never executed as instructions.

The automated test suite is strictly read-only: it never moves or hijacks the user's cursor.

## Running an agent without supervision

Four environment variable switches enable unattended, secure agent operation:

```bash
# Preview what the agent would do without executing mutating actions
DESK_DRY_RUN=1 npx -y desk-mcp

# Audit every tool call, parameters, duration, and outcome to JSONL
DESK_AUDIT=1 npx -y desk-mcp
DESK_AUDIT_PATH=C:\logs\desk-mcp.jsonl npx -y desk-mcp

# Restrict actions to specific window titles (checked before execution)
DESK_ALLOW_TITLES="Блокнот|Notepad" npx -y desk-mcp

# Disable specific tools completely (* wildcard supported)
DESK_DISABLE_TOOLS=computer_click,computer_type npx -y desk-mcp
```

Disabled tools are unregistered from the server; agents cannot see or call them, and `computer_batch` rejects them by name.

Audit logs record one structured line per call:

```
2026-10-06 10:07:02 tool=invoke title="Parcel Tracker" ms=33 outcome=ok via= dryRun=True
2026-10-06 10:07:02 tool=invoke title="Roblox" ms=6 outcome=error via= dryRun=True
```

## Limitations

- **Windows only.** Uses Win32, UI Automation, and Windows runtime APIs throughout.
- **Exclusive fullscreen games**: `CopyFromScreen` returns black. Windowed DirectX titles work cleanly via `PrintWindow`.
- **UWP windows**: expose limited UIA/MSAA trees; desk-mcp automatically falls back to OCR.
- **Chromium**: use built-in CDP tools for complete DOM control without starting flags.
- **Virtual desktops**: depends on Windows build; older builds lacking `VirtualDesktopManager.dll` return an error.
- **Roblox**: clicks may not land in protected client windows.
- Element lookup for `invoke` and `set_value` has no cancelable timeout yet (see above).

## Tests

```bash
npm test
npm run check:docs      # README.md и README.ru.md описывают одно и то же
```

Expected tail: `ИТОГ: 85 ок, 0 провалов, N пропущено`. The harness prints in Russian:
`ок` is passed, `провалов` is failed, `пропущено` is skipped. A skipped check means
some window on the machine refused to answer UI Automation (Steam, 1C, old WPF hold
the COM call open) and the breaker caught it. That is a property of somebody else's
application, not a defect, so it does not fail the run. A failure count above zero is
a real break.

The UIA circuit breaker is tested by booting a second server with a 1 ms budget and
checking that the first call hangs, the second is blocked, and both say why.

## Windows gotchas

Everything below was reproduced in practice, not taken from documentation:

- The worker calls `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` before any UI call. Without it UIA and OCR report logical units while `SendInput` acts in physical pixels, causing clicks to miss on scaled displays.
- A `.ps1` file must be UTF-8 **with BOM**, otherwise PowerShell 5.1 reads it as ANSI and silently breaks Cyrillic.
- In `KEYBDINPUT` the fields are `ushort`, not `uint`. Declaring `uint` makes the struct 32 bytes instead of 24, placing `dwFlags` in the wrong memory offset and causing `SendInput` to silently fail.
- PowerShell has no `[ushort]` type; use `[uint16]`.
- Static C# methods cannot be named `Move` or `Wheel` (PowerShell name collision); resolved with `MoveTo` / `ScrollWheel`.
- `SendKeys` cannot type Cyrillic reliably; desk-mcp uses `SendInput` with `KEYEVENTF_UNICODE`.
- `ConvertTo-Json -Depth` for a UI tree must be greater than 12 to avoid shallow string serialization of .NET types.
- UI Automation can report infinite coordinates; desk-mcp validates `IsInfinity` and `NaN` before casting to `Int32`.
- `AutomationElement` COM objects must not be cached across actions because native trees mutate; cache IDs and look up fresh handles.
- `Add-Type` compiles under C# 5 (no `$"..."` interpolation).
- Variable interpolation before colons (`"$Owner:$Token"`) requires braces (`"${Owner}:$Token"`).

## Where to look next

Continuing work on this repository, whether you are a person or an agent: start from
`AGENTS.md`. It carries the full state, what is verified and how, the traps, and the next
goals in priority order.

- [CHANGELOG.md](CHANGELOG.md): every change with its measurement and its reason, including false hypotheses.
- [CONTRIBUTING.md](CONTRIBUTING.md): traps that the code alone does not reveal.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): attribution and dependency licenses.

## License

Apache License 2.0. Windows public APIs are used per Microsoft's documentation.