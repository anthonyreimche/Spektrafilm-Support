import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      // SafeLight injects React at runtime via api.react — don't bundle it.
      external: ["react", "react-dom"],
    },
    outDir: "dist",
    sourcemap: true,
  },
});
