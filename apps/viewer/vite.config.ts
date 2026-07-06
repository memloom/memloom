import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The built bundle is served by the memloom daemon itself (same origin as the API). In dev,
// proxy API calls to a running `memloom serve` so `pnpm dev` works against real data.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/memory": "http://127.0.0.1:4319",
      "/health": "http://127.0.0.1:4319",
    },
  },
});
