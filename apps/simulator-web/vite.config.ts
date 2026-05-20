import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/flight-data": {
        target: "http://localhost:4010",
        rewrite: (path) => path.replace(/^\/flight-data/, "")
      },
      "/health": "http://localhost:4000",
      "/metrics": "http://localhost:4000",
      "/mock-cop": "http://localhost:4000"
    }
  }
});
