import { Copy } from "./copyplugin";
import { Strip } from "bun-plugin-strip";

import fs from "fs";

const outdir = "./dist";
const tsconfigPath = "./tsconfig.json";
fs.rmSync(outdir, { recursive: true, force: true });
Bun.build({
  tsconfig: tsconfigPath,
  entrypoints: ["./src/CountCycle.ts", "./src/CryptOpt.ts"],
  target: "node",
  minify: false, // !("DEBUG" in process.env),
  outdir: outdir,
  external: ["*.node"],
  plugins: [
    Strip({
      include: ["**/*.ts"],
      functions: "DEBUG" in process.env ? [] : ["Logger.log"],
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
