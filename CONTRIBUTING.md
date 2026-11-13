# Contributing

Windows 10/11 and Node.js 20+ are required for desktop integration tests.

```powershell
npm ci
npm run check
npm run test:unit
npm run check:docs
npm test
npm run check:package
```

- Keep `worker.ps1` in UTF-8 **with BOM** and `uia-native.cs` compatible with C# 5.
- Register tools through `reg()` so discovery, disabling and batch validation share a schema.
- Reproduce behavior through an MCP client; verify application state, not only an input acknowledgement.
- Add a regression test for a bug fix. Keep cursor/keyboard tests on a dedicated fixture or dry-run server.
- Update both README languages. `check:docs` checks tool names, environment variables, runnable examples, local links, demo references and version consistency.
- Preserve the no-native-npm-modules design. Pure JavaScript dependencies are allowed.

`npm run test:smoke` reads live windows and may skip inaccessible targets. With Parcel Tracker open it also exercises its controls. Selftest briefly presses Shift. Browser launching is opt-in with `DESK_TEST_CDP=1`. A failing check must exit nonzero.

Run `npm run bench` for the controlled benchmark. Keep raw samples, errors, machine details and independent correctness checks with any performance claim. Do not extrapolate an LLM's latency from a guessed delay per tool call.

Architecture and Windows-specific constraints: [AGENTS.md](AGENTS.md). Release steps: [docs/PUBLISHING.md](docs/PUBLISHING.md).
