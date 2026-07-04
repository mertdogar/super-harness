// The HOST app's contract: its own surface merged with the harness fragment.
// Shared by server.ts and client.ts — in a real host this is your app's
// existing contract module. A duplicate key across the two surfaces is a
// compile error naming the key; the harness.* prefix makes collisions
// impossible in practice.
import { z } from "zod"
import { defineContract, defineSurface, mergeSurfaces } from "@super-line/core"
import { harnessSurface } from "@super-harness/shared"

export const hostContract = defineContract({
  // harnessSurface must ride `shared` (not a role): super-line rooms are
  // mixed-role, so room broadcasts only carry shared events — and every
  // harness signal is a room broadcast.
  shared: mergeSurfaces(
    harnessSurface,
    defineSurface({
      clientToServer: {
        "demo.echo": { input: z.object({ text: z.string() }), output: z.object({ echoed: z.string() }) },
      },
    }),
  ),
  roles: { user: {} },
})
