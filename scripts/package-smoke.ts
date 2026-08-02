import { isAbsolute, join } from "node:path";

const root = process.cwd();
const tempRoot = join(
  process.env["TMPDIR"] ?? "/tmp",
  `open-agent-package-${crypto.randomUUID()}`,
);
const consumer = join(tempRoot, "consumer");

const run = async (command: string[], cwd = root): Promise<string> => {
  const process = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, CI: "true" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`,
    );
  }
  return stdout.trim();
};

await run(["mkdir", "-p", consumer]);

try {
  const packOutput = await run([
    "bun",
    "pm",
    "pack",
    "--destination",
    tempRoot,
    "--quiet",
  ]);
  const packedTarball = packOutput.split("\n").at(-1);
  if (!packedTarball) throw new Error("bun pm pack did not return a tarball");
  const tarball = isAbsolute(packedTarball)
    ? packedTarball
    : join(tempRoot, packedTarball);

  const entries = (await run(["tar", "-tzf", tarball])).split("\n");
  const forbidden = entries.filter((entry) =>
    /(^|\/)(\.env|node_modules|test|coverage)(\/|$)/.test(entry),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Tarball contains forbidden files:\n${forbidden.join("\n")}`,
    );
  }

  await Bun.write(
    join(consumer, "package.json"),
    JSON.stringify({ name: "package-smoke", private: true, type: "module" }),
  );
  await Bun.write(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        target: "ESNext",
        module: "Preserve",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["*.ts"],
    }),
  );
  await Bun.write(
    join(consumer, "smoke.ts"),
    `import { VERSION, Agent, generateText } from "@deepaksankhyan91/open-agent-sdk";
import { createOpenAI } from "@deepaksankhyan91/open-agent-sdk/openai";
import { createAnthropic } from "@deepaksankhyan91/open-agent-sdk/anthropic";

if (!VERSION || typeof Agent !== "function" || typeof generateText !== "function") {
  throw new Error("Core runtime exports are invalid");
}
if (typeof createOpenAI !== "function" || typeof createAnthropic !== "function") {
  throw new Error("Provider runtime exports are invalid");
}

createOpenAI({ apiKey: "package-smoke" }).languageModel("test-model");
createAnthropic({ apiKey: "package-smoke" }).languageModel("test-model");
console.log(VERSION);
`,
  );

  await run(["bun", "add", tarball], consumer);
  const version = await run(["bun", "smoke.ts"], consumer);
  await run([join(root, "node_modules", ".bin", "tsc"), "-p", "."], consumer);

  const packageJson = await Bun.file(
    join(
      consumer,
      "node_modules",
      "@deepaksankhyan91",
      "open-agent-sdk",
      "package.json",
    ),
  ).json();
  if (packageJson.version !== version) {
    throw new Error(
      `Runtime version ${version} does not match package ${packageJson.version}`,
    );
  }

  console.log(`Verified packed @deepaksankhyan91/open-agent-sdk@${version}`);
} finally {
  await run(["rm", "-rf", tempRoot]);
}
