import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 380,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/scheduler/")) {
            return "react-vendor";
          }
          if (id.includes("/node_modules/lucide-react/") || id.includes("/node_modules/lucide/")) {
            return "ui-icons";
          }
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/flight-data": {
        target: "http://localhost:4010",
        rewrite: (path) => path.replace(/^\/flight-data/, "")
      },
      "/situation-data": {
        target: "http://localhost:4020",
        rewrite: (path) => path.replace(/^\/situation-data/, "")
      },
      "/safety-data": {
        target: "http://localhost:4030",
        rewrite: (path) => path.replace(/^\/safety-data/, "")
      },
      "/tak-gateway": {
        target: "http://localhost:4040",
        rewrite: (path) => path.replace(/^\/tak-gateway/, "")
      },
      "/health": "http://localhost:4000",
      "/metrics": "http://localhost:4000",
      "/mock-cop": "http://localhost:4000"
    }
  }
});
