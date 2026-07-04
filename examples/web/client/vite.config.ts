import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Bind all interfaces + allow the tailnet MagicDNS host so a phone on the
  // tailnet can reach this dev server by hostname (Vite blocks unknown domains).
  server: { host: true, allowedHosts: [".ts.net"] },
});
