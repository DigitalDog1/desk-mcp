# desk-mcp

<p align="center">
  <a href="README.md">English</a> | <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="https://glama.ai/mcp/servers/DigitalDog1/desk-mcp"><img src="https://glama.ai/mcp/servers/DigitalDog1/desk-mcp/badges/score.svg" alt="Glama score" width="120"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node 20 or newer" height="18">
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4" alt="Windows 10 or 11" height="18">
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache 2.0" height="18">
</p>

Windows desktop control for MCP agents. Accessibility trees first, pixels when nothing
else works, input through WinAPI. Node.js plus the PowerShell that ships with Windows:
no Python, no `uvx`, no compiler, no native modules.

![desk-mcp demo: five UI Automation pattern actions on a WinForms window, no pixel clicks, the cursor never moves](docs/demo.gif)

<p align="center"><sub>24 seconds, muted. <a href="https://raw.githubusercontent.com/DigitalDog1/desk-mcp/main/docs/demo.mp4">MP4</a> or <a href="https://raw.githubusercontent.com/DigitalDog1/desk-mcp/main/docs/demo.webm">WebM</a> for the full size file. GitHub serves both as downloads, which is why this is a GIF.</sub></p>

The window above is a plain WinForms app (`examples/demo-app.ps1`). Five actions, zero
pixel clicks, and the cursor stays parked in the log box for the whole clip while
`ValuePattern` and `InvokePattern` fill the field, run the search, reload the list,
mark the parcel delivered and copy its number. Run `node examples/demo.mjs` to
reproduce it, or add `--pause 1500` to watch each step land.

## Why this and not a screenshot loop

- `computer_find { name: "Search" }` returns the element with its `automationId`, its
  rectangle and the patterns it supports. A coordinate read off a screenshot is already
  stale by the time you click it.
- Four read layers, and the answer says which one spoke: UI Automation, then MSAA
  through `oleacc`, then the Chrome DevTools Protocol for Chromium pages, then OCR from
  the engine inside Windows. An empty UIA tree means fall through to the next layer.
- A window that hangs does not kill the agent. UI Automation talks to other
  applications over COM and never gives up on a frozen one. Every call here runs on an
  STA thread with a hard timeout, and after a timeout the `tool|window` key is blocked
  for 90 s. Other windows keep working.
- Zero external binaries. `npm install` is the whole install: no Visual C++ Build
  Tools, no Python, nothing to compile. That constraint is what keeps `npx desk-mcp`
  working on a machine that has never seen a build tool.

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

`claude_desktop_config.json`, `mcp.json` or any other client config:

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

From a clone, swap `npx` for `node` and point `args` at `server.mjs`. Restart the
client and the tools are there.

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

On a localized Windows the caption buttons come back with translated names (`Close`,
`Maximize`, `Minimize` in Russian on a Russian install). Prefer `automationId` over
caption text, or the agent will break on the user's locale.

## The same window with the cursor

![the same window driven by coordinates: the cursor walks, and a WinForms button ignores an instant click](docs/demo-cursor.gif)

<p align="center"><sub>Same window, same visible result, other mechanism. <a href="https://raw.githubusercontent.com/DigitalDog1/desk-mcp/main/docs/demo-cursor.mp4">MP4</a> or <a href="https://raw.githubusercontent.com/DigitalDog1/desk-mcp/main/docs/demo-cursor.webm">WebM</a> for the full size version.</sub></p>

Plain `computer_click` on coordinates, so the cursor walks and the app cannot tell
the difference. A WinForms button also ignores a synthetic click that arrives in the
same instant as the cursor: `nudge` does not fix it, `hoverFirst: true` does (250 ms
over the control before the press). Measured on the same coordinates and the same
window, without the hover the counter stayed at 0, with it the event landed. Default
to `hoverFirst: true` for pixel clicks into an app you have not tried yet.

## What it costs, measured

Text tokens are `chars / 4`, image tokens follow Anthropic's `width * height / 750`.
Measured with a Chromium game running on the machine, which is the worst case for
anything that touches UI Automation.

| Window | Size | One element (`computer_find`) | Whole tree | Compact tree | Picture |
| --- | ---: | ---: | ---: | ---: | ---: |
| MiniMax Code | 2576x1416 | 93 tokens, 3159 ms | 471 tokens, 3223 ms | 1313 tokens, 42 ms | 4864 tokens, 139 ms |
| Discord | 1793x922 | 15 tokens, 4362 ms | 60 tokens, 8005 ms | 67 tokens, 1 ms | 2205 tokens, 149 ms |
| This page in Edge | 2576x1416 | 97 tokens, 3055 ms | 3232 tokens, 107 ms | 2490 tokens, 46 ms | 4864 tokens, 102 ms |
| Snipping Tool | 617x343 | 84 tokens, 3061 ms | 4189 tokens, 73 ms | 2969 tokens, 15 ms | 283 tokens, 31 ms |
| Microsoft Store | 1216x941 | 82 tokens, 3070 ms | 5859 tokens, 80 ms | 4353 tokens, 48 ms | 1526 tokens, 96 ms |

- Looking up one element costs 3.4x to 147x less than a picture of the same window,
  and it returns exact bounds and patterns.
- A whole tree can cost more than the screenshot. `maxDepth`, `maxElements`,
  `interactiveOnly`, `compact` and `maxChars` pull it back. On one window with a long
  message list the tree came to 29643 tokens, and `interactiveOnly` alone took that
  to 1280.
- `compact` swaps named fields for positional arrays, which saves 23% to 29% on the
  big trees above. On a small tree it **loses**: the `fields` legend is a fixed
  overhead, and on the 471-token tree it turned the answer into 1313 tokens. Turn it on
  for a big tree, off for a small one.
- A screenshot costs the same every time, since only window size matters. A big window
  is expensive however empty it is.
- Reading a window now costs 15 to 525 ms: the window is resolved through `user32`
  and the traversal starts from that handle. Two rows above are the exceptions, both
  for the same reason: Discord's tree hits the 8 s budget because Chromium drags on
  UIA, and MiniMax Code's first read pays that same way.
- `computer_find` is still 3.0 to 4.4 s. It needs live COM objects to apply the
  patterns, so it still runs on the PowerShell thread. That one is next on the list.

Run `npm run bench` to measure your own windows.

## The 42 tools

**Eyes**

- `computer_screenshot`: whole screen, any region, or a single window through
  `PrintWindow`, so it works on occluded and minimized windows. PNG or JPEG, any
  scale.
- `computer_ocr`: text straight from pixels with the OCR engine built into Windows
  (`Windows.Media.Ocr`, en and ru). Words come back with boxes, so you can click on
  what was read. As a fallback it is unreliable: on the demo window it turned
  `ZX-4471-8820` into `zx-=v-882C`.

**Interface tree**

- `computer_read_screen`: UI Automation, automatic fallback to MSAA, automatic growth
  of traversal depth, and OCR when both trees are empty (the answer then carries
  `backend` and `degraded`).
- `computer_find`: one element by name, role or `automationId`.
- `computer_element_at`: the chain of elements under a point.
- `computer_browser_tree`, `computer_browser_descendants`, `computer_browser_eval`,
  `computer_browser_click`: the real page DOM over CDP, with ready to use CSS
  selectors and a click that reports what actually received the event.

**Hands**

- `computer_click` (modifiers, `nudge`, `scale`), `computer_move`,
  `computer_mouse_move`, `computer_drag`, `computer_scroll`, `computer_mouse_button`,
  `computer_type`, `computer_key`, `computer_key_down` / `computer_key_up`,
  `computer_wait`.
- `computer_invoke`: presses through `InvokePattern` **without taking the mouse**
  and without bringing the window forward. This is what the clip above uses.
- `computer_set_value`: writes through `ValuePattern`, also without focus.
- `computer_batch`: up to 50 tools in one call, executed step by step so every step
  obeys the same budgets.

**Windows and desktop**

- `computer_windows`, `computer_focus`, `computer_wait_window`,
  `computer_active_window`, `computer_window_set_frame`, `computer_close_window`,
  `computer_launch`, `computer_desktop` (virtual desktops, where the Windows build
  has them), `computer_bench`.

**Verification**

- `computer_verify_state`: predicates `exists`, `value_equals`, `enabled`,
  `selected`. `unknown` is reported as `unknown` and is never counted as success.
- `computer_invoke`, `computer_set_value` and `computer_select_text` refuse on
  `enabled: false`, because `InvokePattern` on a disabled control returns happily in
  Windows and does nothing at all.
- `computer_selftest` checks the whole channel at once.

## How it works

```
server.mjs      MCP server in Node over stdio, CDP client, circuit breaker
worker.ps1      one long-lived PowerShell: user32, UI Automation, MSAA, OCR
uia-native.cs   C# 5: STA pool with a queue, cancelable timeout, thread rebirth
```

One worker for the whole life of the server, not a process per call: PowerShell
takes about 400 ms to start and `Add-Type` takes longer than that to compile the C#.
The exchange is line based with base64 responses, otherwise Cyrillic breaks on the
console code page.

| Layer | What it gives | When it is used |
| --- | --- | --- |
| UIA | exact `automationId`, patterns, bounds | native and managed Windows apps |
| MSAA | `oleacc`, depth grows automatically | when UIA returned an empty tree |
| CDP | the real page DOM with CSS selectors | Chromium windows, exact selectors |
| OCR | words with boxes, no element identity | games, video, GPU drawn content |

The order matters. For Chromium the first two are nearly useless: UIA returns a tree
wrapped in nameless `PANEL` elements unless the browser was started with
`--force-renderer-accessibility`. That is what the CDP layer is for, and it is also
why `computer_browser_click` can report `verified: true` from an in-page probe
without moving the mouse.

## When a window hangs

UI Automation calls into another process over COM, and an application with a modal
dialog, a frozen UI thread or old WPF holds the RPC open forever. A PowerShell
`ScriptBlock` cannot be moved onto an STA thread (it is bound to its runspace), so the
traversal itself had to move into C#. The server does four things about it:

- `uia-native.cs` runs the read path on an STA thread with a hard timeout. A call that
  runs out of time poisons its thread; the next call gets a fresh one while the
  abandoned thread dies in the background. Measured: the timeout fires at 1512 ms
  against a 1500 ms budget, and the next call finishes in 43 ms on the new thread
  (`TID 19 -> 21`).
- It is about seven times faster than the PowerShell path it replaced: 147 ms against
  1014 ms on the same qBittorrent window, same output except `textLen`, which used to
  report a constant `1` because PowerShell returns `.Length == 1` for any scalar.
- A circuit breaker, per window. After a timeout the key `tool|window` is blocked for
  90 s. Calls to that window fail immediately with an explanation instead of stalling
  again. Other windows are unaffected.
- An 8 s budget on the whole call, generous by two orders of magnitude: a full
  traversal of every window on this machine measures 116 ms.

`DESK_UI_TIMEOUT_MS`, `DESK_UI_COOLDOWN_MS` and `DESK_UIA_BUDGET_MS` override the
budgets. The worker budget is smaller than the server one so the worker returns a clear
timeout before the breaker fires.

Element *lookup* for `computer_invoke` and `computer_set_value` still walks the tree
from PowerShell, because those calls need live COM objects for the patterns. Only the
read-only traversal and `computer_element_at` moved to the native layer. The OCR
fallback also captures the window through `PrintWindow`, which is a synchronous call
into the target and carries the same risk.

Against Mod Organizer 2 on this machine `computer_invoke` ran into the 8 s budget and
came back with the reason instead of hanging:

```
Error: UI Automation hung on 'invoke|modorganizer': no response in 8 s, worker restarted.
Window does not answer UIA - calls to it are blocked for 90 s.
Next: computer_screenshot + computer_ocr, or another window.
```

A later `computer_find` on the same window needed 8008 ms and was blocked as well,
while every other window kept working.

## Games

Aiming in a shooter does not work through click and move, and no amount of clicking
fixes it. Most shooters read the mouse through raw input: the engine takes only
hardware packets and ignores synthetic input, so buttons fire while the camera does
not turn. Aim with relative movement instead of absolute positioning:

```json
{ "tool": "computer_mouse_move", "args": { "dx": 220, "dy": -40, "steps": 20, "stepMs": 8 } }
```

`steps` matters. Games apply sensitivity to every mouse event, so one 220 px jump
looks like a flick and twenty small steps look like a hand. The tool measures how far
the cursor actually went and tops up the remainder, because Windows coalesces
injected motion.

| Game | Switch | Verified |
| --- | --- | --- |
| Counter-Strike: Source (Source 2013) | none needed, `rawinput` does not exist and the engine reads `WM_MOUSEMOVE` | yes, live |
| CS:GO / CS2 | `cl_rawinput 0` in the console or `+cl_rawinput 0` in launch options | not verified |
| Steam Input (Force Steam Input) | turn off per game, it injects raw input of its own | not verified |

Drawing apps need the opposite trick. MS Paint ignores a click with no motion between
button down and button up: it draws nothing and the fill tool does not fire at all.
Nudge by a pixel:

```json
{ "tool": "computer_click", "args": { "x": 800, "y": 400, "nudge": 1 } }
```

A WinForms button has the opposite requirement: it wants the cursor to arrive
*before* the press, so use `hoverFirst`, not `nudge`.

```json
{ "tool": "computer_click", "args": { "x": 590, "y": 189, "hoverFirst": true } }
```

Measured on one window with one set of coordinates: `nudge: 1` left the counter at
0, `hoverFirst: true` moved it to 1. Both calls returned `ok: true`, because
nothing went wrong at the input level, the button just dropped the click.

If your coordinates came from a downscaled screenshot, pass the same scale instead of
doing the arithmetic:

```json
{ "tool": "computer_screenshot", "args": { "region": "0,0,2560,1440", "scale": 0.5 } }
{ "tool": "computer_click", "args": { "x": 640, "y": 360, "scale": 0.5 } }
```

## Safety

`computer_close_window` and `computer_launch` are destructive and require an explicit
`confirm: true`. Text read off the screen is data, not instructions.

The test suite is read only on purpose: screenshots, windows, trees, OCR, clipboard,
CDP reads. It does not move your cursor.

## Limitations

- **Windows only.** This is a Windows server and it uses Windows APIs throughout.
- **Exclusive fullscreen** (games, video): `CopyFromScreen` returns black. That needs
  DXGI Desktop Duplication, which would mean a native dependency. Windowed D3D9 titles
  do come through `PrintWindow`, verified on Counter-Strike: Source.
- **UWP windows** expose neither a UIA nor an MSAA tree, so reads fall through to OCR
  and element names are gone.
- **Chromium** needs `--force-renderer-accessibility` for UIA to be useful, otherwise
  use the CDP tools.
- **Virtual desktops** depend on the Windows build. On 10 19035
  `VirtualDesktopManager.dll` is absent and the tool returns an error.
- **Roblox** was never tested here. Clicks were reported not to land.
- Element lookup for `invoke` and `set_value` has no cancelable timeout yet (see
  above).

## Tests

```bash
npm test
```

Expected tail: `ИТОГ: 49 ок, 0 провалов, N пропущено`. The harness prints in Russian:
`ок` is passed, `провалов` is failed, `пропущено` is skipped. A skipped check means
some window on the machine refused to answer UI Automation (Steam, 1C, old WPF hold
the COM call open) and the breaker caught it. That is a property of somebody else's
application, not a defect, so it does not fail the run. A failure count above zero is
a real break.

The UIA circuit breaker is tested by booting a second server with a 1 ms budget and
checking that the first call hangs, the second is blocked, and both say why.

## Windows gotchas

Everything below was reproduced in practice, not taken from documentation.

- The worker calls `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` before any
  UI call. Without it UIA and OCR report logical units while `SendInput` acts in
  physical pixels, and clicks land tens of pixels off on a scaled display.
- A `.ps1` file must be UTF-8 **with BOM**, otherwise PowerShell 5.1 reads it as ANSI
  and silently breaks Cyrillic.
- In `KEYBDINPUT` the fields are `ushort`, not `uint`. Declare `uint` and the struct
  becomes 32 bytes instead of 24, `dwFlags` lands in the wrong place, and `SendInput`
  neither fails nor complains nor returns an error. It silently does nothing.
- PowerShell has no `[ushort]` type, it is `[uint16]`.
- A static C# method cannot be named `Move` or `Wheel`, PowerShell then reports "does
  not contain a method named". Worked around with `MoveTo` / `ScrollWheel`.
- `SendKeys` cannot type Cyrillic at all. Only `SendInput` with `KEYEVENTF_UNICODE`
  works.
- `ConvertTo-Json -Depth` for a UI tree must be **larger than 12**: a node is about
  two levels of nesting, so a shallow depth silently substitutes a string holding a
  .NET type name.
- UIA can report infinite bounds. Check `IsInfinity` and `NaN` before casting to
  `Int32`.
- COM objects (`AutomationElement`) must not be cached, they go stale as the tree is
  repainted. Cache identifiers and do a fresh lookup before every action.
- `Add-Type` compiles as C# 5, so there is no `$"..."` interpolation, and a lambda
  cannot reference a local declared further down.
- Interpolating a name before a colon turns `"$Owner`:$Token"` into `$Owner:`, which
  PowerShell reads as a scoped variable. Write `${Owner}`.

## Where to look next

- [CHANGELOG.md](CHANGELOG.md): every change with its measurement and its reason,
  including the false hypotheses that turned out to be wrong.
- [CONTRIBUTING.md](CONTRIBUTING.md): traps that the code alone does not reveal. Read
  it before editing.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): attribution and dependency
  licenses.

## License

Apache License 2.0. Windows public APIs are used per Microsoft's documentation.