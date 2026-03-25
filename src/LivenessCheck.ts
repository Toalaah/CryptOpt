/**
 * Copyright 2023 University of Adelaide
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * This script takes a state file (--readState <path>) and computes liveness
 * information for the model, printing liveIn/liveOut sets for each instruction
 * to stdout.
 *
 * Usage:
 *   node ./dist/LivenessCheck.js --readState <path-to-state.json>
 */

import fs from "fs";

import yargs from "yargs";

import { BitcoinCoreBridge } from "@/bridge/bitcoin-core-bridge";
import { FiatBridge } from "@/bridge/fiat-bridge";
import { JasminBridge } from "@/bridge/jasmin-bridge";
import { ManualBridge } from "@/bridge/manual-bridge";
import { Model } from "@/model";
import { LivenessAnalyzer } from "@/registerAllocator/liveness";
import type { CryptOpt } from "@/types";
import { buildInterferenceGraph } from "./registerAllocator/interferenceGraph";

const args = yargs(process.argv.slice(2))
  .scriptName("./LivenessCheck")
  .usage("$0 --readState <state-file>")
  .option("readState", {
    string: true,
    describe: "Path to a JSON state file (to, body, parsedArgs) to load into the model.",
    demandOption: true,
  })
  .help("help")
  .alias("h", "help")
  .parseSync();

const stateFile = JSON.parse(fs.readFileSync(args.readState).toString()) as CryptOpt.StateFile;
const { parsedArgs } = stateFile;
const { bridge, memoryConstraints } = parsedArgs;

// Model.init() must be called before Model.restore() so that _methodParameters
// is non-empty (getInstance() guards on this). restoreFromFile would override
// _nodes/_order anyway, so we only need the function shape here.
switch (bridge) {
  case "fiat": {
    const { curve, method } = parsedArgs as { curve: string; method: string };
    Model.init({
      memoryConstraints,
      json: new FiatBridge().getCryptOptFunction(method as never, curve as never),
    });
    break;
  }
  case "bitcoin-core": {
    const { method } = parsedArgs as { method: string };
    Model.init({ memoryConstraints, json: new BitcoinCoreBridge().getCryptOptFunction(method as never) });
    break;
  }
  case "jasmin":
    Model.init({ memoryConstraints, json: new JasminBridge().getCryptOptFunction() });
    break;
  case "manual": {
    const { jsonFile, cFile } = parsedArgs as { jsonFile: string; cFile: string };
    Model.init({ memoryConstraints, json: new ManualBridge(jsonFile, cFile).getCryptOptFunction() });
    break;
  }
  default:
    console.error(`Unknown bridge: ${bridge}`);
    process.exit(1);
}

// Override _nodes and _order with the saved optimiser state.
Model.restoreFromFile(args.readState);

const nodes = Model.nodesInTopologicalOrder;
const livenessInfo = LivenessAnalyzer.computeLiveness();
const { liveIn, liveOut } = livenessInfo;

// Collect all variables that appear in any liveIn/liveOut set.
const allVars = new Set<string>();
for (let i = 0; i < nodes.length; i++) {
  for (const v of liveIn[i]) allVars.add(v);
  for (const v of liveOut[i]) allVars.add(v);
}

const n = nodes.length;

const liveRanges = new Map<string, number[]>();
for (const v of [...allVars].sort()) {
  const range = [0, 0];
  let j = 0;
  for (let i = 0; i < n; ++i) {
    if (j == 2) break;
    const isLiveAtI = liveIn[i].has(v) || liveOut[i].has(v);
    if (isLiveAtI && j == 0) {
      range[j++] = i;
    } else if (!isLiveAtI && j == 1) {
      range[j++] = i - 1;
    } else if (j == 1 && i == n - 1) {
      range[j++] = n - 1;
    }
  }
  liveRanges.set(v, range);
}

for (let i = 0; i < nodes.length; i++) {
  const node = nodes[i];
  const name = node.name.join(", ");
  const op = node.operation;
  const operands = node.arguments.join(", ");
  console.log(`[${i}] ${name} = ${op}(${operands})`);
  if (liveRanges.has(name)) {
    const range = liveRanges.get(name)!;
    console.log(`  range: [${range[0]},${range[1]}]`);
  }
  console.log(`  liveIn:  {${[...liveIn[i]].join(", ")}}`);
  console.log(`  liveOut: {${[...liveOut[i]].join(", ")}}`);
}

const maxVarLen = allVars.values().reduce((v, acc) => Math.max(v, acc.length), 0);
console.log("\n=== Live Ranges ===");
for (const v of [...allVars].sort()) {
  // Position i is live if the variable is in liveIn[i] (live at instruction entry)
  // or liveOut[i] (live at instruction exit, i.e. defined here and used later).
  const bar = Array.from({ length: n }, (_, i) => (liveIn[i].has(v) || liveOut[i].has(v) ? "*" : "_")).join(
    "",
  );
  console.log(`${v.padEnd(maxVarLen, " ")}: ${bar}`);
}

// const iGraph = buildInterferenceGraph(livenessInfo);
//
// console.log("\n=== Interference Graph ===");
// const sortedNodes = [...iGraph.adj.keys()].sort();
// for (const node of sortedNodes) {
//   const neighbors = [...iGraph.adj.get(node)!].sort().join(", ");
//   const degree = iGraph.degree.get(node)!;
//   const precoloredLabel = iGraph.precolored.has(node)
//     ? ` [precolored: ${iGraph.precoloredReg.get(node)}]`
//     : "";
//   console.log(`  ${node}${precoloredLabel} (degree ${degree}): {${neighbors}}`);
// }
