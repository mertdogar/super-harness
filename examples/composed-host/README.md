# @super-harness/composed-host

The **composition reference**: a host application's super-line server running
the harness as a **plugin** beside its own surface — one server, one socket,
one auth, one collections backend for both. Where `plugin-usage` is the
narrated adoption pitch and `dev-server`/`web` call `serve()` to run the
harness standalone, this example is the terse shape an existing super-line app
(say, a design tool with its own contract and collections) copies to embed the
harness into a server it already owns.

## Run

You need `AI_GATEWAY_API_KEY` in the repo-root `.env`. Start the server in one
terminal and the client in another:

```bash
# 1. server — a host super-line server: demo.echo + the harness plugin
pnpm -F @super-harness/composed-host start      # ws://localhost:4112/ws

# 2. client — ONE shared socket driving BOTH surfaces
pnpm -F @super-harness/composed-host client
```

The client calls the host's own request first, then streams a full harness
turn over the same connection:

```
[composed-client] demo.echo → HELLO HOST
Hi to the composed world!
[composed-client] turn complete — one socket, two surfaces.
```

`COMPOSED_HOST_PORT` overrides the port (default 4112); `CHAT_MODEL` the
gateway model.

## The wiring

Three source files, one per seam:

- **`src/contract.ts`** — the host's contract with the harness fragment merged
  via `plugins`:

  ```ts
  export const hostContract = defineContract({
    plugins: [harnessContract()],   // harness surface (on `shared`) + the four harness.* collections
    shared: defineSurface({ clientToServer: { "demo.echo": … } }),
    roles: { user: {} },
  })
  ```

  `harnessContract()` is a `defineContractPlugin` fragment: it contributes the
  harness requests/events on `shared` and the four `harness.*` collections
  (`threads`/`nodes`/`tools`/`membership`). The host's own surface — and any
  collections of its own — sit beside it in the same `defineContract`. A
  duplicate key throws at `defineContract`, but the `harness.*` prefix makes
  collisions impossible in practice. One module, shared by server and client,
  so both agree on one wire.

- **`src/server.ts`** — the host's server, with the harness as one plugin:

  ```ts
  const srv = createSuperLineServer(hostContract, {
    transports,
    authenticate,                     // ctx carries { userId, resourceId? }
    identify: (conn) => conn.ctx.userId,
    collections: memoryCollections(), // ONE backend: harness rows + the host's own
    plugins: [harness(engine)],
  })
  srv.implement({ shared: { "demo.echo": … }, user: {} })
  ```

- **`src/client.ts`** — ONE `createSuperLineClient(hostContract)` for both
  surfaces. It calls `demo.echo` directly, then hands the same client to
  `createHarnessClient({ client })` — **borrowed mode**: the harness client
  attaches its listeners to the host's socket and its `close()` detaches them
  without ever closing the connection. Collections ride the built-in
  `client.collection()`, so there is no client-side store config at all.

### The four host obligations

All four are visible in `src/`; miss one and composition breaks in a specific
way:

1. **Merge the fragment** — `harnessContract()` in the contract's `plugins`.
   The harness surface rides `shared` (its signals are room broadcasts, and
   rooms are mixed-role), the collections are declared on the contract.
2. **One collections backend** — `collections: memoryCollections()` (or
   `sqliteCollections()` / `pgliteCollections()`). It serves the harness
   collections beside any the host declares; the harness never owns a backend.
3. **`identify` → the principal** — `authenticate` puts `userId` (and
   optionally `resourceId`) on `ctx`, and `identify` returns `ctx.userId`.
   This is load-bearing: the harness collections' RLS keys on the principal,
   and super-line falls back to the random connection id without `identify` —
   the request surface still works, but every membership-gated read is
   silently denied and the tree renders empty.
4. **Add the plugin** — `harness(engine)` in `plugins`. Every `harness.*`
   handler key is **subtracted** from `implement()`, so the host implements
   only its own requests — no stubs, no spreads.

## What to look at

- **Cast-free host DX**: `srv.implement({ shared: { "demo.echo": … } })`
  typechecks with only the host's handlers — the plugin's handler subtraction
  removes the `harness.*` keys from the required set. No `as any`, no manual
  merging (`composition.test.ts` in `packages/server` is the litmus for this).
- **`identify` in `src/server.ts`**: the query-param `authenticate` is a dev
  stub — in production pair the same wiring with `@super-line/plugin-auth`
  (see `examples/auth`), and `identify` reads the session principal instead.
- **Borrowed client mode in `src/client.ts`**: `harness.close()` then
  `line.close()` — the harness never owns the host's socket.
