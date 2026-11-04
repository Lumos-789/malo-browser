import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/fixture",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../out/fixture",
    emptyOutDir: true,
    target: "chrome140",
  },
});
