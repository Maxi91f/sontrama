import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  publicDir: "../public",
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8081",
      "/ws": { target: "ws://127.0.0.1:8081", ws: true },
    },
  },
});
