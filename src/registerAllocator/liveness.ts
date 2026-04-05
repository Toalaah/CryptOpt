import { isImm, makeU64NameLimbs, matchArg, matchXD } from "@/helper";
import { Model } from "@/model";
import type { CryptOpt } from "@/types";

export interface LivenessInfo {
  // The set of vars which are live immediately *before* instruction at position i.
  liveIn: ReadonlyArray<ReadonlySet<string>>;
  // Set of vars which are live immediately *after* instruction at position i
  liveOut: ReadonlyArray<ReadonlySet<string>>;
}

export function defSetForNode(node: CryptOpt.StringOperation): Set<string> {
  const s = new Set<string>();
  for (const limb of makeU64NameLimbs(node)) {
    if (limb !== "_" && matchXD(limb)) s.add(limb);
  }
  return s;
}

function useSetForNode(
  node: CryptOpt.StringOperation,
  lookupMap: ReadonlyMap<string, number>,
  u128Names: ReadonlySet<string>,
  rematerializable: ReadonlySet<string> = new Set(),
): Set<string> {
  const s = new Set<string>();
  for (const arg of node.arguments) {
    const str = arg as string;
    if (isImm(str)) continue;
    const argMatch = matchArg(str);
    if (argMatch?.groups?.base) {
      // e.g. "arg1[0]" => base "arg1". Skip if caller-designated rematerializable.
      if (!rematerializable.has(argMatch.groups.base)) s.add(argMatch.groups.base);
      continue;
    }
    if (matchXD(str) || lookupMap.has(str)) {
      // u128 variables are tracked on limb basis in def sets. Need to expand the bare u128 name
      // to its two limbs so that the backwards pass can correctly kill the variable at its
      // definition point instead of propagating it to the start of the program.
      if (u128Names.has(str)) {
        s.add(`${str}_0`);
        s.add(`${str}_1`);
      } else {
        s.add(str);
      }
    }
  }
  // Memory-destination names like "out1[n]" require the base pointer (out1)
  // to be live, even though it appears in node.name rather than node.arguments.
  for (const nm of node.name) {
    const nmMatch = matchArg(nm as string);
    if (nmMatch?.groups?.base && !rematerializable.has(nmMatch.groups.base)) {
      s.add(nmMatch.groups.base);
    }
  }
  return s;
}

// See: https://proglang.informatik.uni-freiburg.de/teaching/compilerbau/2016ws/10-liveness.pdf
function runBackwardPass(
  n: number,
  def: Set<string>[],
  use: Set<string>[],
  liveIn: Set<string>[],
  liveOut: Set<string>[],
  from: number,
  to: number,
): void {
  for (let p = from; p >= to; p--) {
    // liveOut_p = liveIn_{p+1}
    const newOut = new Set<string>();
    if (p + 1 < n) {
      for (const v of liveIn[p + 1]) newOut.add(v);
    }

    // liveIn_p = use_p + (liveOut_p - def_p)
    const newIn = new Set<string>(use[p]);
    for (const v of newOut) {
      if (!def[p].has(v)) newIn.add(v);
    }

    // Early termination: if nothing changed above the update window, stop.
    if (p < to) {
      let unchanged = newIn.size === liveIn[p].size;
      if (unchanged) {
        for (const v of newIn) {
          if (!liveIn[p].has(v)) {
            unchanged = false;
            break;
          }
        }
      }
      if (unchanged) break;
    }

    liveOut[p] = newOut;
    liveIn[p] = newIn;
  }
}

// Liveness analysis. Reads from Model and returns a fresh result.
// TODO: cache repeated calls or if topo order did not change
export class LivenessAnalyzer {
  /**
   * @param rematerializable  Optional set of variable base names (e.g. "arg1",
   *   "out1") that are always re-materializable and should therefore not be
   *   counted as live.  They are excluded from every use set so the backward
   *   pass never treats them as occupying a register.
   */
  static computeLiveness(rematerializable: ReadonlySet<string> = new Set()): LivenessInfo {
    const nodes = Model.nodesInTopologicalOrder;
    const lookupMap = Model.nodeLookupMap;
    const nodeCount = nodes.length;
    if (nodeCount === 0) return { liveIn: [], liveOut: [] };

    // Collect the bare names of all u128 nodes.  Arguments that reference a
    // u128 variable appear as the base name (e.g. "x10004") in node.arguments,
    // but def sets track the two individual limbs ("x10004_0", "x10004_1").
    // We pass this set to useSetForNode so it can expand u128 names to limbs,
    // keeping def and use consistent and preventing a "never-killed" variable
    // from being propagated back to the start of the program.
    const u128Names = new Set<string>();
    for (const node of nodes) {
      if (node.datatype === "u128") {
        for (const nm of node.name) u128Names.add(nm as string);
      }
    }

    const def = nodes.map(defSetForNode);
    const use = nodes.map((nd) => useSetForNode(nd, lookupMap, u128Names, rematerializable));

    const liveIn: Set<string>[] = Array.from({ length: nodeCount }, () => new Set<string>());
    const liveOut: Set<string>[] = Array.from({ length: nodeCount }, () => new Set<string>());
    runBackwardPass(nodeCount, def, use, liveIn, liveOut, nodeCount - 1, 0);
    return { liveIn, liveOut };
  }
}
