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
import { isImm, makeU64NameLimbs, matchArg, matchXD } from "@/helper";
import { Model } from "@/model";
import { defSetForNode, LivenessAnalyzer } from "@/registerAllocator/liveness";
import type { CryptOpt } from "@/types";

const args = yargs(process.argv.slice(2))
  .scriptName("./LivenessCheck")
  .usage("$0 --readState <state-file> [--rematerializeParams]")
  .option("readState", {
    string: true,
    describe: "Path to a JSON state file (to, body, parsedArgs) to load into the model.",
    demandOption: true,
  })
  .option("rematerializeParams", {
    boolean: true,
    default: false,
    describe: "Exclude method parameters (arg1, arg2, out1) from liveness and register-pressure counts.",
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

// Names of method parameters (arg1, arg2, out1).  Their values are always
// available at known stack locations so they need not occupy a general-purpose
// register.  When --rematerializeParams is set they are excluded from every
// use set so the backward liveness pass never treats them as live.
const paramNames: ReadonlySet<string> = args.rematerializeParams
  ? new Set(Model.methodParameters.map((p) => p.name))
  : new Set();

const nodes = Model.nodesInTopologicalOrder;
const livenessInfo = LivenessAnalyzer.computeLiveness(paramNames);
const { liveIn, liveOut } = livenessInfo;

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
// console.log("\n=== Interference Graph ===");
// const sortedNodes = [...iGraph.adj.keys()].sort();
// for (const node of sortedNodes) {
//   // When params are rematerializable they are not tracked as live, so they
//   // have no meaningful interference edges and can be omitted from the display.
//   if (paramNames.has(node)) continue;
//   const neighborsAll = [...iGraph.adj.get(node)!].sort();
//   const neighbors = neighborsAll.filter((nb) => !paramNames.has(nb)).join(", ");
//   // Recompute degree excluding param neighbours for an accurate count.
//   const degree = neighborsAll.filter((nb) => !paramNames.has(nb)).length;
//   const precoloredLabel = iGraph.precolored.has(node)
//     ? ` [precolored: ${iGraph.precoloredReg.get(node)}]`
//     : "";
//   console.log(`  ${node}${precoloredLabel} (degree ${degree}): {${neighbors}}`);
// }

// Attempt pressure-minimising scheduling (the goal being to reduce spills)
// Strategy: list scheduling that greedily minimises the net change in
// register pressure at each step.  At position j, from the set of all
// nodes whose data-flow predecessors have already been scheduled
// ("ready"), we pick the node that minimises:
//
//   delta = |born| - |freed|
//
// Where born refers to variables defined at position j that have at least one future consumer, and freed variables used here whose LAST remaining consumer is this node (i.e. the variable dies here and its register is released)
//
// Ties are broken by the node's critical-path length (longest dependency
// chain remaining): a longer chain means earlier scheduling is more
// urgent (i.e Sethi-Ullman heuristic).

const nodeLookupMap = Model.nodeLookupMap;

// Same u128 expansion as in liveness.ts: bare u128 names in arguments must
// be expanded to their two limb names so they match the def sets produced by
// makeU64NameLimbs (which always tracks limbs, not the u128 base name).
const u128Names = new Set<string>();
for (const nd of nodes) {
  if (nd.datatype === "u128") {
    for (const nm of nd.name) u128Names.add(nm as string);
  }
}

function localUseSet(node: CryptOpt.StringOperation): Set<string> {
  const s = new Set<string>();
  for (const arg of node.arguments) {
    if (isImm(arg)) continue;
    const m = matchArg(arg);
    if (m?.groups?.base) {
      if (!paramNames.has(m.groups.base)) s.add(m.groups.base);
      continue;
    }
    if (matchXD(arg) || nodeLookupMap.has(arg)) {
      if (u128Names.has(arg)) {
        s.add(`${arg}_0`);
        s.add(`${arg}_1`);
      } else {
        s.add(arg);
      }
    }
  }
  // base pointers that appear in write destinations (e.g. out1[n])
  for (const nm of node.name) {
    const m = matchArg(nm as string);
    if (m?.groups?.base && !paramNames.has(m.groups.base)) s.add(m.groups.base);
  }
  return s;
}

// def[i] / use[i] are indexed by position in the original topological order.
const def: Set<string>[] = nodes.map(defSetForNode);
const use: Set<string>[] = nodes.map(localUseSet);

// defNode[v] = position i in nodes where v is defined (body nodes only).
const defNode = new Map<string, number>();
for (let i = 0; i < n; i++) {
  for (const v of def[i]) defNode.set(v, i);
}

// consumers[v] = set of body-node positions that read v.
const consumers = new Map<string, Set<number>>();
for (let i = 0; i < n; i++) {
  for (const v of use[i]) {
    let s = consumers.get(v);
    if (!s) {
      s = new Set();
      consumers.set(v, s);
    }
    s.add(i);
  }
}

// Dependency edges: node A depends on node B iff A uses something B defines.
// deps[i]  = predecessors that must be scheduled before i.
// succs[i] = successors that must be scheduled after i.
const deps: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
const succs: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
for (let i = 0; i < n; i++) {
  for (const v of use[i]) {
    const d = defNode.get(v);
    if (d !== undefined && d !== i) {
      deps[i].add(d);
      succs[d].add(i);
    }
  }
}

// Critical-path length: longest path (in node count) from i to any sink.
// critPath[sink] = 0; critPath[i] = 1 + max(critPath[s] for s in succs[i]).
// Computed via iterative post-order DFS so large graphs don't stack-overflow.
const critPath: number[] = new Array(n).fill(0);
{
  const visited = new Uint8Array(n);
  const postOrder: number[] = [];
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    // Iterative DFS: stack holds [nodeIdx, successorIterator].
    const stack: Array<[number, Iterator<number>]> = [[start, succs[start][Symbol.iterator]()]];
    visited[start] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const { value: child, done } = top[1].next();
      if (done) {
        postOrder.push(top[0]);
        stack.pop();
      } else if (!visited[child]) {
        visited[child] = 1;
        stack.push([child, succs[child][Symbol.iterator]()]);
      }
    }
  }
  // postOrder: sinks are listed before sources (DFS post-order on a DAG).
  // Process them in this order so successor critPaths are ready.
  for (const i of postOrder) {
    let maxSuccCrit = 0;
    for (const s of succs[i]) {
      if (critPath[s] > maxSuccCrit) maxSuccCrit = critPath[s];
    }
    critPath[i] = succs[i].size === 0 ? 0 : 1 + maxSuccCrit;
  }
}

const inDeg = deps.map((d) => d.size);
const readySet = new Set<number>();
for (let i = 0; i < n; i++) {
  if (inDeg[i] === 0) readySet.add(i);
}
const scheduledSet = new Set<number>();
const minPressOrder: number[] = []; // new ordering: indices into `nodes`

while (minPressOrder.length < n) {
  let best = -1;
  let bestDelta = Infinity;
  let bestCrit = -1;

  for (const candidate of readySet) {
    // Variables freed: used here and no other unscheduled consumer exists.
    let freed = 0;
    for (const v of use[candidate]) {
      const cons = consumers.get(v);
      if (!cons) continue;
      let hasOther = false;
      for (const c of cons) {
        if (c !== candidate && !scheduledSet.has(c)) {
          hasOther = true;
          break;
        }
      }
      if (!hasOther) freed++;
    }

    // variables born ~= defined here and actually consumed somewhere.
    let born = 0;
    for (const v of def[candidate]) {
      if ((consumers.get(v)?.size ?? 0) > 0) born++;
    }

    const delta = born - freed;
    // prefer lower delta, break ties by longer critical path.
    if (delta < bestDelta || (delta === bestDelta && critPath[candidate] > bestCrit)) {
      bestDelta = delta;
      bestCrit = critPath[candidate];
      best = candidate;
    }
  }

  if (best === -1) best = [...readySet][0]; // safety fallback

  scheduledSet.add(best);
  minPressOrder.push(best);
  readySet.delete(best);
  for (const s of succs[best]) {
    if (--inDeg[s] === 0) readySet.add(s);
  }
}

// ---- Recompute liveness under the new order ----

const reordDef = minPressOrder.map((i) => def[i]);
const reordUse = minPressOrder.map((i) => use[i]);
const newLiveIn: Set<string>[] = Array.from({ length: n }, () => new Set<string>());
const newLiveOut: Set<string>[] = Array.from({ length: n }, () => new Set<string>());
for (let p = n - 1; p >= 0; p--) {
  const newOut = new Set<string>(p + 1 < n ? newLiveIn[p + 1] : []);
  const newIn = new Set<string>(reordUse[p]);
  for (const v of newOut) if (!reordDef[p].has(v)) newIn.add(v);
  newLiveOut[p] = newOut;
  newLiveIn[p] = newIn;
}

// register-pressure profiles

const origPressure = Array.from({ length: n }, (_, i) => liveIn[i].size);
const newPressure = Array.from({ length: n }, (_, i) => newLiveIn[i].size);
const origMaxPressure = n > 0 ? Math.max(...origPressure) : 0;
const newMaxPressure = n > 0 ? Math.max(...newPressure) : 0;

// interference-edge count for both schedules
function buildIEdgeSet(order: number[], livOut: ReadonlyArray<ReadonlySet<string>>): Set<string> {
  const seen = new Set<string>();
  for (let p = 0; p < order.length; p++) {
    const defs: string[] = [];
    for (const limb of makeU64NameLimbs(nodes[order[p]])) {
      if (limb !== "_" && matchXD(limb)) defs.push(limb);
    }
    for (const d of defs) {
      for (const v of livOut[p]) {
        if (d !== v) seen.add(d < v ? `${d}|${v}` : `${v}|${d}`);
      }
    }
    // Co-defined outputs (e.g. mulx hi/lo) always interfere.
    for (let i = 0; i < defs.length - 1; i++) {
      for (let j = i + 1; j < defs.length; j++) {
        const [a, b] = defs[i] < defs[j] ? [defs[i], defs[j]] : [defs[j], defs[i]];
        seen.add(`${a}|${b}`);
      }
    }
  }
  return seen;
}

const origIEdgeSet = buildIEdgeSet(
  Array.from({ length: n }, (_, i) => i),
  liveOut,
);
const newIEdgeSet = buildIEdgeSet(minPressOrder, newLiveOut);

// Degree in the new interference graph (for splitting heuristic).
const newInterfDegree = new Map<string, number>();
for (const edge of newIEdgeSet) {
  const bar = edge.indexOf("|");
  const a = edge.slice(0, bar);
  const b = edge.slice(bar + 1);
  newInterfDegree.set(a, (newInterfDegree.get(a) ?? 0) + 1);
  newInterfDegree.set(b, (newInterfDegree.get(b) ?? 0) + 1);
}

// ===================================================================
// Output: pressure-minimising schedule
// ===================================================================

console.log("\n=== Pressure-Minimising Schedule ===");
const pressWidth = Math.max(origMaxPressure, newMaxPressure).toString().length;
const idxWidth = (n - 1).toString().length;
const newOrder: number[] = [];
const order = Model.order;
for (let j = 0; j < n; j++) {
  const origIdx = minPressOrder[j];
  const nd = nodes[origIdx];
  const name = nd.name.join(", ");
  const pNew = newPressure[j].toString().padStart(pressWidth);
  const pOld = origPressure[origIdx].toString().padStart(pressWidth);
  // const moved = origIdx !== j ? ` (was [${origIdx.toString().padStart(idxWidth)}])` : "";
  const moved = ` (was [${origIdx.toString().padStart(idxWidth)}])`;
  const toValue = `toValue ( [${order[origIdx]}])`;
  newOrder.push(order[origIdx]);
  console.log(
    `[${j.toString().padStart(idxWidth)}]${moved.padEnd(idxWidth + 8)}` +
      `${toValue.padEnd(idxWidth + 8)}` +
      `  press ${pNew} (orig ${pOld})` +
      `  ${name} = ${nd.operation}(${nd.arguments.join(", ")})`,
  );
}

console.log(`\nMax register pressure  original: ${origMaxPressure}   optimised: ${newMaxPressure}`);
console.log(`Interference edges     original: ${origIEdgeSet.size}   optimised: ${newIEdgeSet.size}`);
console.log(`New order:\n ${JSON.stringify(newOrder)}`);

// ===================================================================
// Live-range splitting candidates (in the new schedule)
// ===================================================================
//
// A variable has a *gap* when it must stay live across a range of
// instructions where it is not used (bridging two usage clusters).
// Splitting the live range at the start of such a gap — by spilling
// immediately after the last use before the gap and reloading just
// before the next use - eliminates all interference edges that cross
// the gap without requiring an extra spill slot beyond what a simple
// spill would cost.  Variables are ranked by (total_gap_length *
// interference_degree) to surface the highest-leverage opportunities.

interface SplitCandidate {
  varname: string;
  span: number;
  interferenceCount: number;
  gaps: Array<{ start: number; end: number; length: number }>;
}

const spanThreshold = Math.max(4, Math.floor(n / 8));
const splitCandidates: SplitCandidate[] = [];

for (const v of allVars) {
  // Live range in the new schedule.
  let lrStart = n;
  let lrEnd = -1;
  for (let j = 0; j < n; j++) {
    if (newLiveIn[j].has(v) || newLiveOut[j].has(v)) {
      if (j < lrStart) lrStart = j;
      if (j > lrEnd) lrEnd = j;
    }
  }
  if (lrEnd < lrStart) continue;

  const span = lrEnd - lrStart + 1;
  if (span <= spanThreshold) continue;

  // Find contiguous gaps within [lrStart, lrEnd].
  const gaps: SplitCandidate["gaps"] = [];
  let gapStart = -1;
  for (let j = lrStart; j <= lrEnd; j++) {
    const live = newLiveIn[j].has(v) || newLiveOut[j].has(v);
    if (!live && gapStart === -1) {
      gapStart = j;
    } else if (live && gapStart !== -1) {
      gaps.push({ start: gapStart, end: j - 1, length: j - gapStart });
      gapStart = -1;
    }
  }
  if (gapStart !== -1) gaps.push({ start: gapStart, end: lrEnd, length: lrEnd - gapStart + 1 });

  if (gaps.length === 0) continue;

  const interferenceCount = newInterfDegree.get(v) ?? 0;
  splitCandidates.push({ varname: v, span, interferenceCount, gaps });
}

splitCandidates.sort((a, b) => {
  const score = (c: SplitCandidate): number => c.gaps.reduce((s, g) => s + g.length, 0) * c.interferenceCount;
  return score(b) - score(a);
});

console.log("\n=== Live-Range Splitting Candidates (in new schedule) ===");
if (splitCandidates.length === 0) {
  console.log("  None found (no long live ranges with gaps).");
} else {
  console.log(
    "  Variables ranked by (total gap length * interference degree).\n" +
      "  Splitting at gap start frees a register across the gap without extra spill cost.\n",
  );
  for (const c of splitCandidates) {
    const gapDesc = c.gaps.map((g) => `[${g.start}–${g.end}](len=${g.length})`).join("  ");
    console.log(
      `  ${c.varname.padEnd(maxVarLen)}  span=${c.span}  interf=${c.interferenceCount}  gaps: ${gapDesc}`,
    );
  }
}
