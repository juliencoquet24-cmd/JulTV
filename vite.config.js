import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" pour que le site fonctionne sous https://<user>.github.io/<repo>/
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist" },
});
