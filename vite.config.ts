import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "src",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: process.env.NODE_ENV === "production" ? false : "inline",
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/index.html"),
      },
      output: {
        manualChunks: {
          "tauri-core": ["@tauri-apps/api"],
          "tauri-plugins": [
            "@tauri-apps/plugin-dialog",
            "@tauri-apps/plugin-notification",
            "@tauri-apps/plugin-process",
            "@tauri-apps/plugin-updater",
          ],
          previews: ["pdfjs-dist", "marked", "@highlightjs/cdn-assets"],
          search: ["fuse.js"],
          validation: ["zod"],
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
