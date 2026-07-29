import { $ } from "bun";

await $`rm -rf dist`;

const build = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
});

if (!build.success) {
  throw new AggregateError(build.logs, "Failed to bundle the SDK");
}

await $`bunx tsc -p ./tsconfig.build.json`;
