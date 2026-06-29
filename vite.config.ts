import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "src",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1000,
    sourcemap: process.env.NODE_ENV === "production" ? false : "inline",
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/index.html"),
      },
      output: {
        manualChunks: (id: string) => {
          if (id.includes("node_modules/@tauri-apps/api")) return "tauri-core";
          if (
            id.includes("node_modules/@tauri-apps/plugin-dialog") ||
            id.includes("node_modules/@tauri-apps/plugin-notification") ||
            id.includes("node_modules/@tauri-apps/plugin-process") ||
            id.includes("node_modules/@tauri-apps/plugin-updater")
          ) {
            return "tauri-plugins";
          }
          if (
            id.includes("node_modules/pdfjs-dist") ||
            id.includes("node_modules/marked") ||
            id.includes("node_modules/@highlightjs/cdn-assets")
          ) {
            return "previews";
          }
          if (id.includes("node_modules/zod")) return "validation";
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "../assets": resolve(import.meta.dirname, "assets"),
      "../dist/css": resolve(import.meta.dirname, "src/css"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
