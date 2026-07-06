// The HOST app's contract: its own surface + the harness fragment, merged via
// `plugins`. Shared by server.ts and client.ts — in a real host this is your
// app's existing contract module. harnessContract() contributes the harness
// surface (on `shared`) AND the four harness.* collections; a duplicate
// collection/handler key throws at defineContract, but the harness.* prefix
// makes collisions impossible in practice.
import { z } from "zod"
import { defineContract, defineSurface } from "@super-line/core"
import { harnessContract } from "@super-harness/shared"

export const hostContract = defineContract({
  plugins: [harnessContract()],
  // The host's own request. `demo.echo` rides `shared` here for simplicity; a
  // real app would put role-specific requests under `roles`.
  shared: defineSurface({
    clientToServer: {
      "demo.echo": { input: z.object({ text: z.string() }), output: z.object({ echoed: z.string() }) },
    },
  }),
  roles: { user: {} },
})
