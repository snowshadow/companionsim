import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { simEvalApiPlugin } from "./server/vite-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), simEvalApiPlugin()],
  server: {
    port: 5260,
    strictPort: true,
  },
});
