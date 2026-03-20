import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "src",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/index.html"),
      },
    },
  },
  resolve: {
    alias: {
      "../assets": resolve(__dirname, "assets"),
      "../dist/css": resolve(__dirname, "src/css"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
