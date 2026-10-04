// Copies the MediaPipe Tasks Vision wasm runtime from node_modules into
// public/ so it is served from our own origin (no CDN dependency at demo time).
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = join("node_modules", "@mediapipe", "tasks-vision", "wasm");
const dest = join("public", "mediapipe", "wasm");
mkdirSync(dest, { recursive: true });
for (const file of readdirSync(src)) {
  if (file.startsWith("vision_wasm_internal") || file.startsWith("vision_wasm_nosimd_internal")) {
    cpSync(join(src, file), join(dest, file));
  }
}
console.log(`MediaPipe wasm copied to ${dest}`);
