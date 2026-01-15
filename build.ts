import { Copy } from "./copyplugin";
import { Strip } from "bun-plugin-strip";

import fs from "fs";
const debug = "DEBUG" in process.env;
if (debug) {
  console.log("\x1b[1m\x1b[36mINFO: building in debug mode\x1b[0m");
}
const outdir = "./dist";
const tsconfigPath = "./tsconfig.json";
fs.rmSync(outdir, { recursive: true, force: true });
Bun.build({
  tsconfig: tsconfigPath,
  entrypoints: ["./src/CountCycle.ts", "./src/CryptOpt.ts"],
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

// Build scripts & measurement tools.
Bun.build({
  tsconfig: tsconfigPath,
  entrypoints: ["./scripts/GraphMutatedVariants.ts"],
  target: "node",
  minify: !debug,
  outdir: "dist",
  external: ["*.node"],
});
