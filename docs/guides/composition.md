---
title: Compose into a host
---

# Compose into a host

Super Harness composes as a plugin alongside your app surface. It adds the
`harness.*` requests and four typed collections without creating a second
server or socket.

Your host must merge `harnessContract()`, provide one collections backend,
return a stable user principal from `identify`, and include `harness(engine)`
in its plugins.

```ts
const host = defineContract({
  plugins: [harnessContract()],
  shared: defineSurface({ clientToServer: { /* your handlers */ } }),
  roles: { user: {} },
})
```

The host's `implement()` call only provides its own handlers. The plugin owns
every `harness.*` handler.
