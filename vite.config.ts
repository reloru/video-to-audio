import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import preact from "@preact/preset-vite";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/**
 * Emits /sw.js with the full list of built files to precache, so the app (including
 * the ffmpeg core) works offline after the first visit. The cache version is a hash of
 * every precached file, so any change to the build replaces the cache.
 */
function serviceWorker(): Plugin {
  return {
    name: "service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const hash = createHash("sha256");
      const built = Object.values(bundle)
        .filter((item) => !item.fileName.endsWith(".map"))
        .sort((a, b) => a.fileName.localeCompare(b.fileName));
      for (const item of built) {
        hash.update(item.fileName);
        hash.update(item.type === "chunk" ? item.code : item.source);
      }
      const publicFiles = listFiles("public")
        .map((path) => relative("public", path).split("\\").join("/"))
        .filter((path) => !path.startsWith("_") && !path.startsWith("."))
        .sort();
      for (const path of publicFiles) {
        hash.update(path);
        hash.update(readFileSync(join("public", path)));
      }
      const precache = ["./", ...built.map((item) => item.fileName).filter((f) => f !== "index.html"), ...publicFiles];
      const source = readFileSync("src/sw.js", "utf8")
        .replace('"__PRECACHE__"', JSON.stringify(precache))
        .replace("__VERSION__", hash.digest("hex").slice(0, 16));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [preact(), serviceWorker()],
  worker: { format: "es" },
  build: {
    target: ["es2022", "safari16"],
    assetsInlineLimit: 0,
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/core/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
