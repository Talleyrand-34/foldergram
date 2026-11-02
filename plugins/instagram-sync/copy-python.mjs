/**
 * Copies the plugin's Python helper into the compiled output.
 *
 * The helper is a plain script, so `tsc` does not carry it over. The deploy
 * copies `plugins/<name>/dist/`, so it has to end up there.
 */
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(pluginDir, "python");
const target = path.join(pluginDir, "dist", "python");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

console.log(`instagram-sync: copied python helper → ${target}`);
