# composed-host example

The composition reference: a HOST app's super-line server mounting the
harness beside its own surface — one server, one socket, one auth. This is
the pattern an external host app (e.g. designer) copies.

`pnpm -F @super-harness/composed-host start` (server, Bun, root `.env` with
`AI_GATEWAY_API_KEY`), then `pnpm -F @super-harness/composed-host client` in a
second terminal. `COMPOSED_HOST_PORT` (default 4112) / `CHAT_MODEL` override.

The four host obligations (all demonstrated in `src/`):

1. `shared: mergeSurfaces(harnessSurface, ownSurface)` — the fragment must
   ride `shared`, not a role: rooms only broadcast shared events.
2. `stores: { ...await harnessStores(cfg), ...ownStores }` — before
   `createSuperLineServer`.
3. `authenticate` ctx extends `HarnessCtx`, and `identify` returns
   `ctx.userId` — store ACL grants key on it; without identify the principal
   is the random conn.id and every tree read is silently denied.
4. `srv.implement({ shared: { ...mountHarness(srv, harness).handlers, ...own } })`.

Client side: ONE `createSuperLineClient(hostContract)` with
`harnessClientStores()` spread in, handed to `createHarnessClient({ client })`
(borrowed mode — its `close()` detaches listeners, never closes the socket).
