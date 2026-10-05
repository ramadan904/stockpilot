import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Serve /api/propose from the same handler the Vercel function uses, so `npm run web` behaves like production. */
function apiInDev(): Plugin {
  return {
    name: "stockpilot-api",
    configureServer(server) {
      server.middlewares.use("/api/propose", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          return res.end();
        }
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const { handlePropose } = await server.ssrLoadModule("/../agent/api.ts");
        const { status, json } = await handlePropose(JSON.parse(raw || "null"));
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
