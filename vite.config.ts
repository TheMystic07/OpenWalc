import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "src",
  publicDir: resolve(__dirname, "public"),
  server: {
    host: "0.0.0.0",
    port: 3001,
    allowedHosts: ["openwalc.mystic.cat", "agent.mystic.cat"],
    proxy: {
      "/ws": {
        target: "ws://localhost:18800",
        ws: true,
      },
      "/api": {
        target: "http://localhost:18800",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: resolve(__dirname, "src/index.html"),
        world: resolve(__dirname, "src/world.html"),
        skills: resolve(__dirname, "src/skills.html"),
      },
    },
  },
});
