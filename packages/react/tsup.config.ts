import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/harness-client.ts"],
  format: ["esm", "cjs"],
  dts: true,
  target: "es2022",
  clean: true,
});
