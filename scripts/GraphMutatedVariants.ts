import { assemble, strip } from "@/assembler";
import { CHOICE } from "@/enums";
import child_process from "child_process";
import { analyseMeasureResult, parsedArgs as parsedArgsFromCli } from "@/helper";
import globals from "@/helper/globals";
import { Model } from "@/model";
import { init } from "@/optimizer/helpers";
import { Paul, sha1Hash } from "@/paul";
import { RegisterAllocator } from "@/registerAllocator";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const parsedArgs = parsedArgsFromCli;

// const log = console.log;
if (!parsedArgs.verbose) {
  console.log = () => {};
}

function mutate(choice?: CHOICE): CHOICE {
  choice = choice ?? Paul.pick([CHOICE.PERMUTE, CHOICE.DECISION]);
  switch (choice) {
    case CHOICE.PERMUTE: {
      Model.mutatePermutation();
      break;
    }
    case CHOICE.DECISION: {
      let numTries = 0;
      // Try a couple of times to mutate decision
      while (!Model.mutateDecision()) {
        if (++numTries > 10) throw new Error("failed to mutate decision");
      }
      break;
    }
  }
  return choice;
}

const { seed } = parsedArgs;
Paul.seed = seed;
RegisterAllocator.options = parsedArgs;
const randomString = sha1Hash(Math.ceil(Date.now() * Math.random())).toString(36);
const libcheckfunctionDirectory = join(tmpdir(), "CryptOpt.cache", randomString);
const { measuresuite } = init(libcheckfunctionDirectory, parsedArgs);
globals.convergence = [];
globals.mutationLog = ["evaluation,choice,kept,PdetailsBackForwardChosenstepsWaled,DdetailsKindNumhotNumall"];

const msOpts = { batchSize: 200, numBatches: 31 };
const [max_y, max_x] = [100, 100];

let baseAsm = (() => {
  const { code } = assemble(parsedArgs.resultDir);
  return strip(code).join("\n");
})();

const results: number[][] = new Array(max_y).fill(0).map(() => new Array(max_x).fill(0));

for (let y = 0; y < max_y; ++y) {
  Model.saveSnaphot("tmp");
  for (let x = 0; x < max_x; ++x) {
    if (y === 0 && x === 0) {
      continue;
    }
    mutate(CHOICE.DECISION);
    const { code } = assemble(parsedArgs.resultDir);
    const asm = strip(code).join("\n");
    const measureResult = measuresuite.measure(msOpts.batchSize, msOpts.numBatches, [baseAsm, asm]);
    const analyzeResult = analyseMeasureResult(measureResult, { batchSize: msOpts.batchSize });
    const [meanRawBase, meanRawMut] = analyzeResult.rawMedian;
    results[y][x] = meanRawMut / meanRawBase;
  }
  Model.restoreSnapshot("tmp");
  mutate(CHOICE.PERMUTE);
}

results[0][0] = 1;

// const normalized = results.map((y) => y.map((x) => x));

const script = [
  `import numpy as np`,
  `import matplotlib.pyplot as plt`,
  `import matplotlib.colors as mcolors`,
  `plt.rc("text", usetex=True)`,
  `plt.rc("font", family="serif")`,
  `x = np.linspace(0, ${max_x}, ${max_x})`,
  `y = np.linspace(0, ${max_y}, ${max_y})`,
  `X, Y = np.meshgrid(x, y)`,
  `Z = np.array(${JSON.stringify(results)})`,
  `fig, ax = plt.subplots(layout='tight')`,
  `norm = mcolors.TwoSlopeNorm(vmin=Z.flatten().min(), vcenter=1.0, vmax=Z.flatten().max())`,
  `cax = ax.imshow(Z, extent=(0, ${max_x}, 0, ${max_y}), origin='lower', cmap='coolwarm', interpolation='bilinear', norm=norm)`,
  `ax.set_xticks(np.arange(0, ${max_x + 1}, ${Math.round(max_x / 10)}))`,
  `ax.set_yticks(np.arange(0, ${max_y + 1}, ${Math.round(max_y / 10)}))`,
  `fig.colorbar(cax, ax=ax, label="Cycle count ratio relative to baseline")`,
  // `ax.set_title(r"Heatmap of $f(x, y) = x \\cdot y$")`,
  `ax.set_xlabel(r"$n_{desc}$")`,
  `ax.set_ylabel(r"$n_{perm}$")`,
  `plt.savefig("heatmap.pdf", bbox_inches='tight')`,
].join("\n");

const result = child_process.spawnSync("python3", { input: script });
process.stdout.write(result.stdout);
writeFileSync("/tmp/script.py", script);
