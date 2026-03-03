import { defineConfig } from "vite";
import { resolve } from "path";

const HTML_ENTRY_ALIASES: Record<string, string> = {
  "/admin": "/admin.html",
  "/admin/": "/admin.html",
  "/world": "/world.html",
  "/world/": "/world.html",
  "/skills": "/skills.html",
  "/skills/": "/skills.html",
};

function applyHtmlEntryAliases(
  req: { url?: string },
  res: { statusCode: number; setHeader: (name: string, value: string) => void; end: () => void },
  next: () => void,
): void {
  const originalUrl = req.url ?? "";
  const pathOnly = originalUrl.split("?")[0];
  const target = HTML_ENTRY_ALIASES[pathOnly];
  if (!target) {
    next();
    return;
  }

  const queryIndex = originalUrl.indexOf("?");
  const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : "";
  res.statusCode = 302;
  res.setHeader("Location", `${target}${query}`);
  res.end();
}

export default defineConfig({
  root: "src",
  publicDir: resolve(__dirname, "public"),
  plugins: [
    {
      name: "html-entry-aliases",
      configureServer(server) {
        server.middlewares.use(applyHtmlEntryAliases);
      },
      configurePreviewServer(server) {
        server.middlewares.use(applyHtmlEntryAliases);
      },
    },
  ],
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
        admin: resolve(__dirname, "src/admin.html"),
      },
    },
  },
});
