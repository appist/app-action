import path from "node:path";
import fs from "node:fs";
import * as esbuild from "esbuild";

await esbuild.build({
	bundle: true,
	entryPoints: ["src/index.ts"],
	external: [
		"@miniflare/tre",
		"esbuild",
		"fsevents",
		"rollup-plugin-node-polyfills",
	],
	outfile: "dist/index.cjs",
	platform: "node",
	target: "es2021",
});
