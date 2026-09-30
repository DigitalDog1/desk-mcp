# desk-mcp

<p align="center">
  <a href="README.md">English</a> &nbsp;|&nbsp; <a href="README.ru.md">Русский</a>
</p>

![the three read layers](docs/layers.png)

MCP server for automating the Windows desktop: screenshots, OCR, mouse and
keyboard, and accessibility trees from UI Automation, MSAA and Chrome DevTools
Protocol. Runs on Node.js and the PowerShell that ships with Windows — no
Python, no `uvx`, no native modules.

![computer_find](docs/find.png)

## What it does

**Eyes**
- `computer_screenshot` — the whole screen, an arbitrary region, or a specific
  window (via `PrintWindow`, so it works on occluded and minimized windows);
  scaling, PNG and JPEG.
- `computer_ocr` — text straight from pixels, using the OCR engine built into
  Windows (`Windows.Media.Ocr`, ru/en). Words and lines come back with
  bounding boxes, so you can click on what was read.

**Interface tree**
- `computer_read_screen` — UI Automation, with automatic fallback to MSAA and
  automatic growth of the traversal depth.
- `computer_find` — find an element by name, role or `automationId`.
- `computer_element_at` — what is at a given point.
- `computer_browser_tree` — the page DOM with ready-to-use CSS selectors (CDP).

**Hands**
- `computer_click` (with modifiers), `computer_move`, `computer_drag`, `computer_scroll`,
  `computer_mouse_button`, `computer_type`, `computer_key`, `computer_key_down` / `_up`, `computer_wait`.
- `computer_invoke` — presses through `InvokePattern` **without capturing the mouse**
  and without bringing the window forward.
- `computer_set_value` — writes through `ValuePattern` without focus.
- `computer_batch` — up to 50 tools in a single call, stopping at the first error.

**Windows**
- `computer_windows`, `computer_focus`, `computer_wait_window`, `computer_active_window`,
  `computer_window_set_frame`, `computer_close_window`, `computer_launch`.
- `computer_desktop` — virtual desktops, on the builds of Windows that have them.

**Verification**
- `computer_verify_state` — predicates: exists / `value_equals` / `enabled` / `selected`.
  `unknown` is reported honestly and is not success.
- `computer_browser_click` returns evidence that the click landed: an in-page
  probe **or** a URL change.
- `computer_selftest` — checks the whole channel at once.

41 tools in total. Schema and descriptions: run `node server.mjs`, or connect any
MCP client.

## Install

```bash
git clone https://github.com/DigitalDog1/desk-mcp.git
cd desk-mcp
npm install
```

Requires Node.js 20+ and Windows 10 1809 / 11. No PowerShell install needed —
it is already there.

### Connect

`mcp.json`:

```json
{
  "mcpServers": {
    "desk-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\desk-mcp\\server.mjs"]
    }
  }
}
```

## How it works

```
server.mjs   MCP server in Node, stdio, CDP client
worker.ps1   long-running PowerShell: user32, UI Automation, MSAA, OCR
```

One worker for the whole life of the server, not a process per call: PowerShell
takes about 400 ms to start, and `Add-Type` takes longer still to compile the C#.
The exchange is line-based with base64 responses — otherwise Cyrillic breaks on
the console code page.

## The three read layers

The order matters, because for Chromium the first two are nearly useless: UIA
returns a tree wrapped in nameless `PANEL` elements, and only when Chromium was
started with `--force-renderer-accessibility`. An empty tree is not an error, it
is the signal to fall through to the next layer.

| Layer | What it gives |
|---|---|
| UIA | native windows: exact `automationId`, patterns, bounds |
| MSAA | `oleacc`, used when UIA came back empty, with depth growing automatically |
| CDP | the real page DOM with ready-to-use CSS selectors |

## How to work with it

![computer_ocr](docs/ocr.png)

The most expensive mistake is not "the tool didn't work", it is "the tool worked,
but not on the right thing". So the loop is: **observe → act by meaning → verify**.
`computer_invoke` may come back with `via: "pixel"`, which means there was no
pattern and the click went to the center of the bounds — treat the result with
more suspicion. A tool that found nothing refuses honestly: that is a finding,
not a reason to click blind coordinates.

## Safety

`computer_close_window` and `computer_launch` are destructive and irreversible.
Both require an explicit `confirm: true` and refuse without it. Text on screen
is untrusted data, not instructions.

## Limitations

- **Exclusive fullscreen** (games, video): `CopyFromScreen` returns black.
  This needs DXGI Desktop Duplication.
- **UWP windows** expose neither a UIA nor an MSAA tree.
- **Virtual desktops** depend on the Windows build: on 10 19035
  `VirtualDesktopManager.dll` is absent and the tool returns an error.
- **The worker is single-threaded**: a hung UIA call blocks the queue. The
  treatment is a 30 s timeout, killing the process and restarting it.

## Tests

```bash
npm test
```

Expected tail: `ИТОГ: 39 ок, 0 провалов`. The suite **does not move the
cursor** — read-only: screenshots, windows, trees, OCR, clipboard, CDP reads.

## Windows gotchas

Everything below was reproduced in practice, not taken from documentation.

- A `.ps1` file must be UTF-8 **with BOM**: without it, PowerShell 5.1 reads
  the file as ANSI and silently breaks parsing of Cyrillic.
- In `KEYBDINPUT` the fields are `ushort`, not `uint`. Declare `uint` and the
  struct becomes 32 bytes instead of 24, `dwFlags` ends up in the wrong place,
  and `SendInput` neither fails, nor complains, nor returns an error. It
  silently does nothing.
- PowerShell has no `[ushort]` type; it is `[uint16]`.
- A static C# method cannot be named `Move` or `Wheel`: the call fails with
  "does not contain a method named…". Worked around with `MoveTo`/`ScrollWheel`.
- `SendKeys` cannot type Cyrillic at all. Only `SendInput` +
  `KEYEVENTF_UNICODE` works.
- `ConvertTo-Json -Depth` for a UI tree must be **larger than 12**: a node is
  about two levels of nesting, so a shallow depth silently substitutes a string
  holding a .NET type name.
- UIA can report infinite bounds — check `IsInfinity` and `NaN` before
  casting to `Int32`.
- COM objects (`AutomationElement`) must not be cached: they go stale as the
  tree is repainted. Only identifiers are cached, with a fresh lookup before
  every action.
- `Add-Type` compiles as C# 5, so no `$"..."` string interpolation.
- Interpolating a name before a colon turns `"$Owner`:$Token"` into `$Owner:`,
  which PowerShell reads as a scoped variable. Write `${Owner}`.

Change history: [CHANGELOG.md](CHANGELOG.md).
Attribution of ideas and dependency licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Read [CONTRIBUTING.md](CONTRIBUTING.md) before editing — it lists traps that the
code alone does not reveal.

## License

MIT. Windows public APIs are used per Microsoft's documentation.
