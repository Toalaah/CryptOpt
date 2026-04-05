import { Register } from "@/enums";
import { CALLING_CONVENTION_REGISTER_ORDER } from "@/helper/constants";
import { makeU64NameLimbs, matchXD } from "@/helper";
import { Model } from "@/model";

import type { LivenessInfo } from "./liveness";

export interface InterferenceGraph {
  // store nodes via adjacency set
  adj: Map<string, Set<string>>;
  // Helper for degree of each node, could infer from adj matrix
  degree: Map<string, number>;
  // Precolored base names (e.g rdi,rsi)
  precolored: Set<string>;
  // Precolored variables
  precoloredReg: Map<string, Register>;
}

function addEdge(graph: InterferenceGraph, u: string, v: string): void {
  if (u === v) return;
  if (!graph.adj.has(u)) {
    graph.adj.set(u, new Set());
    graph.degree.set(u, 0);
  }
  if (!graph.adj.has(v)) {
    graph.adj.set(v, new Set());
    graph.degree.set(v, 0);
  }
  if (!graph.adj.get(u)!.has(v)) {
    graph.adj.get(u)!.add(v);
    graph.adj.get(v)!.add(u);
    graph.degree.set(u, graph.degree.get(u)! + 1);
    graph.degree.set(v, graph.degree.get(v)! + 1);
  }
}

/**
 * Build an interference graph from liveness information.
 *
 * Two variables interfere if they are simultaneously live at any program
 * point, which means they cannot share a register.
 *
 * Additionally, co-defined outputs of multi-output instructions (e.g. mulx
 * producing both a high and a low result) are forced to interfere with each
 * other, since they are defined at the same point and cannot occupy the same
 * destination register.
 */
export function buildInterferenceGraph(liveness: LivenessInfo): InterferenceGraph {
  const graph: InterferenceGraph = {
    adj: new Map(),
    degree: new Map(),
    precolored: new Set(),
    precoloredReg: new Map(),
  };

  // Register method-parameter base pointers as precolored nodes.
  // Convention: returns params come first, then argument params (see Model).
  const ccRegs = [...CALLING_CONVENTION_REGISTER_ORDER];
  for (const param of Model.methodParameters) {
    const reg = ccRegs.shift();
    if (!reg) break;
    graph.precolored.add(param.name);
    graph.precoloredReg.set(param.name, reg);
    if (!graph.adj.has(param.name)) {
      graph.adj.set(param.name, new Set());
      graph.degree.set(param.name, 0);
    }
  }

  const nodes = Model.nodesInTopologicalOrder;
  const n = nodes.length;

  for (let p = 0; p < n; p++) {
    const node = nodes[p];

    // Collect register-allocated names defined at this instruction
    const defs: string[] = [];
    for (const limb of makeU64NameLimbs(node)) {
      if (limb !== "_" && matchXD(limb)) {
        defs.push(limb);
        if (!graph.adj.has(limb)) {
          graph.adj.set(limb, new Set());
          graph.degree.set(limb, 0);
        }
      }
    }

    // Each def interferes with everything live after this instruction
    for (const d of defs) {
      for (const v of liveness.liveOut[p]) {
        addEdge(graph, d, v);
      }
    }

    // Co-defined outputs interfere with each other (e.g. mulx hi/lo)
    for (let i = 0; i < defs.length - 1; i++) {
      for (let j = i + 1; j < defs.length; j++) {
        addEdge(graph, defs[i], defs[j]);
      }
    }
  }

  // Ensure all liveness-mentioned variables have graph entries
  for (let p = 0; p < n; p++) {
    for (const v of liveness.liveIn[p]) {
      if (!graph.adj.has(v)) {
        graph.adj.set(v, new Set());
        graph.degree.set(v, 0);
      }
    }
    for (const v of liveness.liveOut[p]) {
      if (!graph.adj.has(v)) {
        graph.adj.set(v, new Set());
        graph.degree.set(v, 0);
      }
    }
  }

  return graph;
}
