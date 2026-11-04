import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer/director",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../../out/director",
    emptyOutDir: true,
    target: "chrome140",
  },
});
