import { Copy } from "./copyplugin";

import fs from "fs";
const outdir = "./dist";
fs.rmSync(outdir, { recursive: true, force: true });
Bun.build({
  tsconfig: "./tsconfig.json",
  entrypoints: ["./src/CountCycle.ts", "./src/CryptOpt.ts"],
  target: "node",
  minify: false,
  outdir: outdir,
  external: ["*.node"],
  plugins: [
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
