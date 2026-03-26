import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "src",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/index.html"),
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
