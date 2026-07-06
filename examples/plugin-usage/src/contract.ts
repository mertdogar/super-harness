// YOUR app's super-line contract. The ONLY harness-specific line is
// `harnessContract()` inside `plugins` — that fragment contributes the harness
// surface (requests + streaming events, on `shared`) AND the four `harness.*`
// collections (threads / nodes / tools / membership). Everything under `shared`
// and `roles` is your own; here a single `app.serverInfo` request stands in for
// whatever your app already exposes. Server and client both import this module.
import { z } from "zod"
import { defineContract, defineSurface } from "@super-line/core"
import { harnessContract } from "@super-harness/shared"

export const app = defineContract({
  // Merge the harness fragment beside your app's surface. A duplicate key would
  // throw here, but the `harness.*` prefix makes a real collision impossible.
  plugins: [harnessContract()],
  shared: defineSurface({
    clientToServer: {
      "app.serverInfo": { input: z.object({}), output: z.object({ name: z.string(), harness: z.boolean() }) },
    },
  }),
  roles: { user: {} },
})
