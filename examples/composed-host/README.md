# @super-harness/composed-host

The composition reference: a host application with its own super-line surface
that **mounts the harness beside it** — one server, one socket, one auth for
both. Where `dev-server` and `web` call `serve()` to run the harness as a
standalone server, this example shows the pattern an existing super-line app
uses to embed the harness into a server it already owns. It's the shape a host
project (for example, a design tool with its own super-line backend) copies.

## Run

You need `AI_GATEWAY_API_KEY` in the repo-root `.env`. Start the server in one
terminal and the client in another:

```bash
# 1. server — a host super-line server with a demo.echo request + the harness
pnpm -F @super-harness/composed-host start      # ws://localhost:4112/ws

# 2. client — one shared socket driving BOTH surfaces
pnpm -F @super-harness/composed-host client
```

The client prints the host request result and then streams a harness turn over
the same connection:

```
[composed-client] demo.echo → HELLO HOST
Hi to the composed world!
[composed-client] turn complete — one socket, two surfaces.
```

`COMPOSED_HOST_PORT` overrides the port (default 4112); `CHAT_MODEL` the gateway
model.

## How it works

The three source files map to the two sides of composition:

- `src/contract.ts` — the host's contract: `harnessSurface` merged with the
  app's own `demo.echo` request. Shared by both the server and the client, so
  they agree on one wire.
- `src/server.ts` — the host's super-line server, mounting the harness with
  `harnessStores()` and `mountHarness()`.
- `src/client.ts` — one `createSuperLineClient` for both surfaces, handed to
  `createHarnessClient({ client })` so the headless harness client borrows the
  host's socket instead of opening its own.

### The four host obligations

A host that mounts the harness must do four things, all visible in `src/`:

1. Merge `harnessSurface` into the contract's `shared` block:
   `shared: mergeSurfaces(harnessSurface, ownSurface)`. It must ride `shared`,
   not a role — super-line rooms are mixed-role, so room broadcasts carry only
   shared events, and every harness signal is a room broadcast.
2. Spread `await harnessStores(storage)` into the server's `stores` config,
   before `createSuperLineServer`.
3. Shape `authenticate` so its `ctx` includes `{ userId, resourceId? }`, and
   return `ctx.userId` from `identify`. This is load-bearing: the harness grants
   store access to `ctx.userId`, and without `identify` the principal falls back
   to the random connection id, so every tree read is silently denied.
4. Spread `mountHarness(srv, harness).handlers` into the `shared` block of
   `implement()`.

On the client, spread `harnessClientStores()` into the shared client's `stores`
so the `harness.node` and `harness.thread` replicas exist alongside the host's
own. `createHarnessClient({ client })` runs in borrowed mode: its `close()`
detaches the harness listeners but never closes the host's socket.
