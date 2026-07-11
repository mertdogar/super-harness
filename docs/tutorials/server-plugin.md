---
title: Add the server plugin
---

# Add the server plugin

Merge the contract fragment and runtime plugin into your existing super-line
server. Your app keeps ownership of authentication, transports, and storage.

```ts
const contract = defineContract({
  plugins: [harnessContract()],
  roles: { user: {} },
})

const server = createSuperLineServer(contract, {
  transports,
  collections: memoryCollections(),
  authenticate,
  identify: (connection) => connection.ctx.userId,
  plugins: [harness(engine)],
})
```

`identify` is required: the harness uses its returned principal for
membership-based row-level security.

## Next steps

Read the complete [composition guide](../guides/composition).
