# Publishing desk-mcp

1. Run `npm ci`, `npm run check`, `npm test`, `npm run check:docs` and `npm run check:package` on Windows. Run `npm run bench` and review failures and raw samples before making performance claims.
2. Keep versions in `package.json`, `package-lock.json`, `server.mjs` and `mcpb/manifest.json` synchronized; document changes in the changelog.
3. Run `npm pack`. Install that tarball into a scratch project and verify `computer_selftest` reports `nativeUia: true`. Check both README languages and the `lib` directory are present.
4. Publish using the owner's npm credentials: `npm publish desk-mcp-1.5.1.tgz --access public`. Publishing and any required login/2FA are separate release actions.
5. Verify `npm view desk-mcp version` and a fresh installation before changing README quick-start instructions to `npx -y desk-mcp`. The registry returned 404 on 2026-11-13; this does not guarantee the name can be registered.

For an MCPB bundle, keep the entry point at `server/server.mjs`, put `worker.ps1`, `uia-native.cs`, `bench.ps1` and `lib/` next to it, and bundle production `node_modules` at the bundle root. `mcpb/manifest.json` is the bundle manifest; an npm tarball is not an MCPB bundle.
