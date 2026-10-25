import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Env lives in the repo root .env so all services share one file.
export default defineConfig(({ mode }) => {
  const root = resolve(__dirname, "../..");
  const env = loadEnv(mode, root, "VITE_");
  return {
    plugins: [react()],
    envDir: root,
    define: {
      "import.meta.env.VITE_KOHAKU_API": JSON.stringify(env.VITE_KOHAKU_API ?? "http://localhost:8787"),
      "import.meta.env.VITE_KOHAKU_FLEET": JSON.stringify(env.VITE_KOHAKU_FLEET ?? "http://localhost:8788"),
      "import.meta.env.VITE_KOHAKU_WS": JSON.stringify(env.VITE_KOHAKU_WS ?? ""),
    },
    server: { port: 5173, host: true },
    build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  };
});
