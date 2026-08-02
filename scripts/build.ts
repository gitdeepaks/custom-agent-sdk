import { $ } from "bun";

await $`rm -rf dist`;

const build = await Bun.build({
  entrypoints: [
    "./src/index.ts",
    "./src/providers/openai/index.ts",
    "./src/providers/anthropic/index.ts",
  ],
  outdir: "./dist",
  target: "node",
  naming: "[dir]/[name].[ext]",
  external: ["@opentelemetry/api"],
});

if (!build.success) {
  throw new AggregateError(build.logs, "Failed to bundle the SDK");
}

await $`bunx tsc -p ./tsconfig.build.json`;
