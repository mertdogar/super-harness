# composed-host example

The composition reference: a HOST app's super-line server running the harness as
a PLUGIN beside its own surface — one server, one socket, one auth, one
collections backend. This is the pattern an external host app copies.

`pnpm -F @super-harness/composed-host start` (server, Bun, root `.env` with
`AI_GATEWAY_API_KEY`), then `pnpm -F @super-harness/composed-host client` in a
second terminal. `COMPOSED_HOST_PORT` (default 4112) / `CHAT_MODEL` override.

The host obligations (all in `src/`):

1. **Merge the fragment via `plugins`**: `defineContract({ plugins:
   [harnessContract()], shared: ownSurface, roles })` — `harnessContract()`
   contributes the harness surface (on `shared`) + the four `harness.*`
   collections.
2. **One collections backend**: `collections: memoryCollections()` — serves the
   harness collections beside any of the host's own.
3. **`authenticate` ctx carries `userId` (+`resourceId`); `identify` returns
   `ctx.userId`** — the harness RLS keys on the principal; without `identify`
   it's the random conn.id and every membership-gated read is denied.
4. **Add the plugin**: `plugins: [harness(engine)]` — `harness.*` handler keys
   are subtracted from `implement()`, so the host implements only its own
   (`srv.implement({ shared: { 'demo.echo': … }, user: {} })`).

Client side: ONE `createSuperLineClient(hostContract)` (no `stores` — collections
are built into the client) handed to `createHarnessClient({ client })` in
borrowed mode (its `close()` detaches listeners, never closes the socket).

For the auth-paired variant (identity → principal via `@super-line/plugin-auth`),
see `examples/auth`.
