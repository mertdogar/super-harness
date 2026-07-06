// The app contract: the harness fragment + the auth fragment, merged via
// `plugins`. authContract() adds the `guest` role, the users/credentials/sessions
// collections, and signIn/signUp/signOut/whoami; harnessContract() adds the four
// harness.* collections + the harness surface. Both ends import this one module.
import { defineContract, type Contract } from "@super-line/core"
import { harnessContract } from "@super-harness/shared"
import { authContract } from "@super-line/plugin-auth"

// Annotated `Contract` (not the inferred type): the merged type spans plugin-auth's
// zod 3 schemas AND super-harness's zod 4 schemas, which TS can't name portably
// across an exported boundary (TS2742). The loose type is fine here — every
// consumer (createSuperLineServer/Client, auth()) is generic over `C extends
// Contract`, and the harness-client seam is bridged explicitly.
export const app: Contract = defineContract({
  plugins: [harnessContract(), authContract()],
  roles: { user: {} },
})

