const packageJson = await Bun.file("package.json").json();

const requiredFiles = new Set<string>([
  "dist/index.js",
  "dist/index.d.ts",
  "dist/providers/openai/index.js",
  "dist/providers/openai/index.d.ts",
  "dist/providers/anthropic/index.js",
  "dist/providers/anthropic/index.d.ts",
  "LICENSE",
  "README.md",
  "SECURITY.md",
]);

for (const entry of Object.values(
  packageJson.exports as Record<string, Record<string, string>>,
)) {
  for (const target of Object.values(entry)) {
    requiredFiles.add(target.replace(/^\.\//, ""));
  }
}

const missing: string[] = [];
for (const path of requiredFiles) {
  if (!(await Bun.file(path).exists())) missing.push(path);
}

if (missing.length > 0) {
  throw new Error(`Package artifacts are missing:\n${missing.join("\n")}`);
}

if (packageJson.private === true) {
  throw new Error("A private package cannot be published");
}

if (packageJson.publishConfig?.access !== "public") {
  throw new Error("Scoped package must explicitly publish with public access");
}

console.log(`Verified ${requiredFiles.size} package artifacts`);
