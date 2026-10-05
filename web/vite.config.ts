import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Serve /api/* from the same handlers the Vercel functions use, so `npm run web` behaves like production. */
function apiInDev(): Plugin {
  const routes = { "/api/propose": "handlePropose", "/api/report": "handleReport" } as const;
  return {
    name: "stockpilot-api",
    configureServer(server) {
      for (const [route, handler] of Object.entries(routes)) server.middlewares.use(route, async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          return res.end();
        }
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const api = await server.ssrLoadModule("/../agent/api.ts");
        const { status, json } = await api[handler](JSON.parse(raw || "null"));
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(json));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiInDev()],
  // viem is most of the bundle; ~190 KB gzipped in total is fine for this app.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
