import { Copy } from "./copyplugin";
import { Strip } from "bun-plugin-strip";
import { spawnSync } from "bun";

import fs from "fs";
import path from "path";

const debug = "DEBUG" in process.env;
if (debug) {
  console.log("\x1b[1m\x1b[36mINFO: building in debug mode\x1b[0m");
}
const outdir = "./dist";
const tsconfigPath = "./tsconfig.json";
fs.rmSync(outdir, { recursive: true, force: true });
Bun.build({
  tsconfig: tsconfigPath,
  entrypoints: [
    "./src/CountCycle.ts",
    "./src/CryptOpt.ts",
    "./src/LivenessCheck.ts",
    "./src/Assemble.ts",
    "./src/GenerateStartState.ts",
  ],
  target: "node",
  minify: !debug,
  outdir: outdir,
  external: ["*.node"],
  plugins: [
    Strip({
      include: ["**/*.ts"],
      functions: debug ? [] : ["Logger.log"],
      tsconfigPath,
    }),
    Copy({
      assets: [
        {
          from: "./src/bridge/jasmin-bridge/data/",
          to: `./${outdir}/data/jasmin-bridge`,
        },
        {
          from: "./src/bridge/fiat-bridge/data/",
          to: `./${outdir}/data/fiat-bridge`,
        },
        {
          from: "./src/bridge/bitcoin-core-bridge/data/",
          to: `./${outdir}/data/bitcoin-core-bridge`,
        },
      ],
      verbose: false,
      verify: true,
    }),
  ],
});

const hasExecutable = (bin: string) => {
  const res = spawnSync({
    cmd: ["which", bin],
    stderr: "ignore",
    stdout: "ignore",
  });
  return res.exitCode === 0;
};

// Build scripts & measurement tools.
for (const script of ["./scripts/TestEquivalence.ts", "./scripts/bench.go"]) {
  const toolName = path.basename(path.basename(script, ".ts"), ".go");
  if (script.endsWith(".go")) {
    if (!hasExecutable("go")) continue;
    console.log(`Building tool: ${toolName}`);
    const proc = Bun.spawn(["go", "build", script], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error(`Failed to build tool ${script}!`);
      process.exit(exitCode);
    }
  } else {
    console.log(`Building tool: ${toolName}`);
    Bun.build({
      tsconfig: tsconfigPath,
      entrypoints: [script],
      target: "node",
      minify: !debug,
      outdir: "dist",
      external: ["*.node"],
    });
  }
}
