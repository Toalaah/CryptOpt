import { OptimizerArgs } from "@/types";
import { Optimizer, OptimizerResult } from "@/optimizer";
import { FileLogger, Logger } from "@/helper/Logger.class";
import { genStatistics, genStatusLine, logMutation, printStartInfo } from "@/optimizer/util";
import { resolve as pathResolve } from "path";

import {
  PRINT_EVERY,
  LOG_EVERY,
  writeString,
  analyseMeasureResult,
  padSeed,
  generateResultFilename,
  shouldProof as shouldProve,
} from "@/helper";
import globals from "@/helper/globals";
import { assemble as assembleASM, strip } from "@/assembler";
import { Paul } from "@/paul";
import { FiatBridge } from "@/bridge/fiat-bridge";
import { errorOut, ERRORS } from "@/errors";
import { execSync } from "child_process";
import { appendFileSync } from "fs";
import { sum } from "simple-statistics";
import { Model } from "@/model";
import { CHOICE } from "@/enums";
import { cauchy } from "@/paul/distributions";

export class SAOptimizer extends Optimizer {
  // Number of iterations to perform during optimization.
  private nIter: number;
  // MeasureSuite options.
  private msOpts: { batchSize: number; numBatches: number };
  // Optimizer-specific args
  private initialTemperature: number;
  private maxMutationStepSize: number; // Maximum number of "steps" a single candidate shall take. Depends also on the current temperature.
  private acceptParam: number;
  private visitParam: number;
  private stepSizeParam: number;
  private numNeighbors: number;
  private neighborSelectionFunc: NeighborSelectionFunc<number>;

  private coolingSchedule: CoolingSchedule;

  public constructor(args: OptimizerArgs) {
    super(args);

    this.nIter = this.args.evals;
    this.msOpts = { batchSize: 200, numBatches: 31 };

    this.initialTemperature = this.args.saInitialTemperature;
    this.maxMutationStepSize = Math.round(this.args.saMaxMutStepSize);
    this.acceptParam = this.args.saAcceptParam;
    this.visitParam = this.args.saVisitParam;
    this.stepSizeParam = this.args.saStepSizeParam;
    this.numNeighbors = Math.round(this.args.saNumNeighbors);
    switch (this.args.saNeighborStrategy) {
      case "uniform":
        this.neighborSelectionFunc = makeUniformNeighborSelection();
        break;
      case "greedy":
        this.neighborSelectionFunc = makeGreedyNeighborSelection();
        break;
      case "weighted":
        this.neighborSelectionFunc = makeWeigtedNeighborSelection(this.numNeighbors);
        break;
      default:
        throw new Error(`unknown neighbor proposal strategy: ${this.args.saNeighborStrategy}`);
    }
    if (this.numNeighbors === 1) {
      this.neighborSelectionFunc = (candidates: number[]) => candidates[0];
      Logger.log("using no-op neighbor strategy as numNeighbors=1");
    } else {
      Logger.log(`neighbor strategy: ${this.args.saNeighborStrategy}`);
    }
    switch (this.args.saCoolingSchedule) {
      case "exp":
        this.coolingSchedule = makeExpCoolingSchedule(this.visitParam, this.initialTemperature);
        break;
      case "lin":
        this.coolingSchedule = makeLinCoolingSchedule(this.nIter, this.visitParam, this.initialTemperature);
        break;
      case "log":
        this.coolingSchedule = makeLogCoolingSchedule(this.visitParam, this.initialTemperature);
        break;
      default:
        throw new Error(`unknown cooling schedule: ${this.args.saCoolingSchedule}`);
    }
    Logger.log(`cooling schedule: ${this.args.saCoolingSchedule}`);
  }

  private shouldAccept(currentEnergy: number, visitEnergy: number, temp: number) {
    if (visitEnergy < currentEnergy) {
      return true;
    }
    if (this.acceptParam <= 0) return false;

    const r = Math.random();
    const delta = this.acceptParam * (visitEnergy - currentEnergy);
    if (!(delta >= 0)) errorOut({ exitCode: 123, msg: "negative delta" });
    const x = (-1 * delta) / temp;
    const pr = Math.min(1, Math.exp(x));
    Logger.log(`accepting worse candidate with probability ${pr}`);
    return pr >= r;
  }

  private energy(x: number): number {
    return x;
  }

  private updateBatchSize(meanRaw: number) {
    this.msOpts.batchSize = Math.ceil((Number(this.args.cyclegoal) / meanRaw) * this.msOpts.batchSize);
    this.msOpts.batchSize = Math.min(this.msOpts.batchSize, 10000);
    this.msOpts.batchSize = Math.max(this.msOpts.batchSize, 5);
  }

  public optimise() {
    type Candidate = { asm: string; stacklength: number; choice: CHOICE; ninst: number };
    type State = { asm: string; ratio: number; cycleCount: number };
    // Initialize candidate slots (index 0 is current function, hence the +1).
    const candidates = new Array<Candidate>(1 + this.numNeighbors);
    for (let i = 0; i < candidates.length; ++i) {
      candidates[i] = {
        asm: "",
        stacklength: -1,
        choice: this.choice,
        ninst: -1,
      };
    }
    const CURRENT_FUNCTION = 0 as const;
    let ratioString = "";
    let accumulatedTimeSpentByMeasuring = 0;
    let numEvals = 0; // NB: numEvals does not necessarily == iteration loop, as multiple neighbors implies multiple evaluations per loop.
    let currentEpoch = 0;
    let xBest: State = { asm: "", ratio: -1, cycleCount: -1 }; // Add slot for storing the best result we see.
    let temperature = 0;
    let showPerSecond = "many/s";
    let perSecondCounter = 0;

    // Various helpers used in main optimization loop below.

    /**
     * Updates best result.
     */
    const updateBest = (state: State) => {
      // Could also filter by raw cycle count here, may have to experiment with what actually delivers better results.
      if (state.ratio < xBest.ratio) return;
      xBest.asm = state.asm;
      xBest.ratio = state.ratio;
      xBest.cycleCount = state.cycleCount;
    };

    /**
     * Samples a neighbor and saves it into `slot`. The model snapshot is saved with an `id` of `slot.toString()`.
     */
    const sampleNeighbor = (slot: number, temp: number) => {
      const numMuts = (() => {
        const scaledTemp = temp / this.stepSizeParam;
        // Use Cauchy-Lorentz distribution, allows for occasional long tails to explore the search space more rapidly.
        const n = Math.round(cauchy({ loc: 1, scale: scaledTemp }));
        if (this.maxMutationStepSize <= 0) return Math.max(n, 1);
        return clamp(n, 1, this.maxMutationStepSize);
      })();
      FileLogger.log(`sampled neighbor ${slot} with step size of ${numMuts}`);
      for (let i = 0; i < numMuts; ++i) this.mutate();
      Model.saveSnaphot(slot.toString());
    };

    /**
     * Assembles and saves the current model into `slot`.
     */
    const assemble = (slot: number) => {
      Logger.log("assembling");
      const assembleResult = assembleASM(this.args.resultDir);
      const code = assembleResult.code;
      const filteredInstructions = strip(code);
      if (slot === 0) this.no_of_instructions = filteredInstructions.length;
      const asm = (() => {
        switch (this.args.verbose) {
          case true:
            const c = code.join("\n");
            writeString(pathResolve(this.libcheckfunctionDirectory, `current${slot}.asm`), c);
            return c;
          case false:
            return filteredInstructions.join("\n");
        }
      })();
      candidates[slot].asm = asm;
      candidates[slot].stacklength = assembleResult.stacklength;
      candidates[slot].choice = this.choice;
      candidates[slot].ninst = filteredInstructions.length;
    };

    return new Promise<OptimizerResult>((resolve) => {
      FileLogger.log("starting rls optimisation");
      const optimistaionStartDate = Date.now();
      let time = Date.now();
      printStartInfo({
        ...this.args,
        symbolname: this.symbolname,
        counter: this.measuresuite.timer,
      });

      // Before running the optimization loop, assemble the baseline program (at this point, no mutations have taken place).
      {
        assemble(CURRENT_FUNCTION);
        // Check for errors, if nothing happens here we are probably fine for the rest of the run.
        if (candidates[CURRENT_FUNCTION].asm.includes("undefined"))
          errorOut({ msg: "ASM string empty/undefined, big yikes", exitCode: 1 });
      }

      const intervalHandle = setInterval(() => {
        temperature = this.coolingSchedule(currentEpoch);
        FileLogger.log(`epoch ${currentEpoch}, temp=${temperature}`);

        // Mutation & candidate generation.
        {
          Model.saveSnaphot("current");
          for (let i = 1; i <= this.numNeighbors; ++i) {
            sampleNeighbor(i, temperature);
            assemble(i);
            numEvals++;
            Model.restoreSnapshot("current");
          }
        }

        // Perform measurements.
        const analyseResult = (() => {
          try {
            if (this.args.verbose)
              candidates.forEach((_, i) =>
                writeString(
                  pathResolve(this.libcheckfunctionDirectory, `current${i}.asm`),
                  candidates[i].asm,
                ),
              );
            FileLogger.log("comparing candidates");
            const now_measure = Date.now();
            const results = this.measuresuite.measure(
              this.msOpts.batchSize,
              this.msOpts.numBatches,
              candidates.map((c) => c.asm),
            );
            accumulatedTimeSpentByMeasuring += Date.now() - now_measure;
            FileLogger.log("done with measurements for current iteration");
            return analyseMeasureResult(results, {
              batchSize: this.msOpts.batchSize,
              resultDir: this.args.resultDir,
            });
          } catch (e) {
            this.handleMeasurementError(e);
          }
        })();

        FileLogger.log(`analyseResult: ${JSON.stringify(analyseResult.rawMedian)}`);
        const meanrawCurrent = analyseResult.rawMedian[CURRENT_FUNCTION];
        const meanrawNeighbors = analyseResult.rawMedian.slice(1, analyseResult.rawMedian.length - 1);
        // + 1 cause index 0 is always the current ASM string.
        const neighborIdx = this.neighborSelectionFunc(meanrawNeighbors.map((x) => this.energy(x))) + 1;
        FileLogger.log(`chose neighbor: ${neighborIdx}`);
        const meanrawCandidate = analyseResult.rawMedian[neighborIdx];
        const meanrawCheck = analyseResult.rawMedian[analyseResult.rawMedian.length - 1];

        // Update batch size & best result.
        this.updateBatchSize(meanrawCheck);
        for (let i = 0; i < analyseResult.rawMedian.length - 1; ++i) {
          const res = analyseResult.rawMedian[i];
          const ratio = meanrawCheck / res;
          const cycleCount = analyseResult.batchSizeScaledrawMedian[i];
          updateBest({ asm: candidates[i].asm, ratio, cycleCount });
        }

        // Decide whether we want to keep mutated candidate.
        let kept: boolean;
        if (
          (kept = this.shouldAccept(this.energy(meanrawCurrent), this.energy(meanrawCandidate), temperature))
        ) {
          FileLogger.log(`keeping mutated candidate ${neighborIdx}`);
          candidates[CURRENT_FUNCTION].asm = candidates[neighborIdx].asm;
          candidates[CURRENT_FUNCTION].stacklength = candidates[neighborIdx].stacklength;
          candidates[CURRENT_FUNCTION].choice = candidates[neighborIdx].choice;
          candidates[CURRENT_FUNCTION].ninst = candidates[neighborIdx].ninst;
          this.no_of_instructions = candidates[neighborIdx].ninst;
          Model.restoreSnapshot(neighborIdx.toString());
        } else {
          // Nothing needs to be done in this case, since we always pop the "current" state after exploring neighbors.
          FileLogger.log("keeping current");
          // Use rejected candidate's choice here. TODO: does this even make sense to track in such a way if we perform multiple mutations? Might be more useful to just update a counter...
          this.choice = candidates[neighborIdx].choice;
          this.updateNumRevert(this.choice);
        }

        // Start statistics & status update.
        {
          const indexGood = kept ? neighborIdx : 0;
          const indexBad = kept ? 0 : neighborIdx;
          const goodChunks = analyseResult.chunks[indexGood];
          const badChunks = analyseResult.chunks[indexBad];
          const minRaw = Math.min(meanrawCurrent, meanrawCandidate);

          const currentRatio = meanrawCheck / minRaw;
          const currentCycleCount = analyseResult.batchSizeScaledrawMedian[indexGood];
          globals.currentRatio = currentRatio;

          // Update globals w.r.t best ratios/cycle counts.
          {
            if (currentRatio >= globals.bestEpochByRatio.ratio) {
              // Check if we found new PB this epoch.
              globals.bestEpochByRatio.epoch = currentEpoch;
              globals.bestEpochByRatio.nEvals = numEvals;
              globals.bestEpochByRatio.ratio = currentRatio;
              globals.bestEpochByRatio.cycleCount = currentCycleCount;
            }

            if (currentCycleCount < globals.bestEpochByCycle.cycleCount) {
              globals.bestEpochByCycle = {
                result: analyseResult,
                indexGood,
                epoch: currentEpoch,
                ratio: currentRatio,
                nEvals: numEvals,
                cycleCount: currentCycleCount,
              };
            }
          }

          ratioString = globals.currentRatio.toFixed(4);
          perSecondCounter++;
          if (Date.now() - time > 1000) {
            time = Date.now();
            showPerSecond = (perSecondCounter + "/s").padStart(6);
            perSecondCounter = 0;
          }

          logMutation({ choice: this.choice, kept, numEvals: numEvals, epoch: currentEpoch });

          if (currentEpoch % PRINT_EVERY == 0) {
            const statusline = genStatusLine({
              ...this.args,
              logComment: this.args.logComment + ` temp=${temperature.toFixed(2)}`,
              analyseResult,
              badChunks,
              batchSize: this.msOpts.batchSize,
              choice: this.choice,
              goodChunks,
              indexBad,
              indexGood,
              kept,
              no_of_instructions: this.no_of_instructions,
              numEvals,
              ratioString,
              show_per_second: showPerSecond,
              stacklength: candidates[CURRENT_FUNCTION].stacklength,
              symbolname: this.symbolname,
              writeout: currentEpoch % (this.nIter / LOG_EVERY) === 0,
            });
            process.stdout.write(statusline);
            globals.convergence.push(ratioString);
          }
        } // End statistics

        currentEpoch++;
        // Start cleanup
        {
          if (numEvals >= this.nIter) {
            globals.time.generateCryptopt =
              (Date.now() - optimistaionStartDate) / 1000 - globals.time.validate;
            clearInterval(intervalHandle);
            // Generate statistics as ASM comments.
            let statistics: string[];
            const elapsed = Date.now() - optimistaionStartDate;
            const paddedSeed = padSeed(Paul.initialSeed);

            globals.currentRatio = xBest.ratio;
            ratioString = globals.currentRatio.toFixed(4);
            globals.convergence.push(ratioString);

            statistics = genStatistics({
              paddedSeed,
              ratioString,
              evals: this.nIter,
              elapsed,
              batchSize: this.msOpts.batchSize,
              numBatches: this.msOpts.numBatches,
              acc: accumulatedTimeSpentByMeasuring,
              numRevert: this.numRevert,
              numMut: this.numMut,
              counter: this.measuresuite.timer,
              framePointer: this.args.framePointer,
              memoryConstraints: this.args.memoryConstraints,
              cyclegoal: this.args.cyclegoal,
            });
            Logger.log(statistics);

            // Generate filenames for final results.
            const [asmFile, mutationsCsvFile] = generateResultFilename(
              { ...this.args, symbolname: this.symbolname },
              [`_ratio${ratioString.replace(".", "")}.asm`, `.csv`],
            );
            // Write out the final optimized assembly program, mutation log, & statistics.
            {
              writeString(
                asmFile,
                ["SECTION .text", `\tGLOBAL ${this.symbolname}`, `${this.symbolname}:`]
                  .concat(xBest.asm)
                  .concat(statistics)
                  .join("\n"),
              );

              writeString(mutationsCsvFile, globals.mutationLog.join("\n"));
            }

            // Optionally prove correctness via fiat.
            {
              if (shouldProve(this.args)) {
                const proofCmd = FiatBridge.buildProofCommand(this.args.curve, this.args.method, asmFile);
                Logger.log(`proving that asm is correct with '${proofCmd}'`);
                try {
                  const now = Date.now();
                  execSync(proofCmd, { shell: "/usr/bin/bash" });
                  const timeForValidation = (Date.now() - now) / 1000;
                  appendFileSync(asmFile, `\n; validated in ${timeForValidation}s\n`);
                  globals.time.validate += timeForValidation;
                } catch (e) {
                  console.error(`tried to prove correct. didnt work. I tried ${proofCmd}`);
                  errorOut(ERRORS.proofUnsuccessful);
                }
              }
            }
            Logger.log("done with that current price of assembly code.");
            if (!this.args.verbose) this.cleanLibcheckfunctions();
            const v = this.measuresuite.destroy();
            Logger.log(`Wonderful. Done with my work. Destroyed measuresuite (${v}). Time for lunch.`);
            resolve({ ratio: xBest.ratio, cycleCount: xBest.cycleCount });
          }
        } // End cleanup
      }, 0);
    });
  }
}

function makeExpCoolingSchedule(visitParam: number, initialTemp: number): CoolingSchedule {
  const a = visitParam - 1;
  const t1 = Math.expm1(a * Math.log(2.0));

  return (t: number) => {
    const s = t + 2.0;
    const t2 = Math.expm1(a * Math.log(s));
    return (initialTemp * t1) / t2;
  };
}

function makeLinCoolingSchedule(nEval: number, visitParam: number, initialTemp: number): CoolingSchedule {
  return (t: number) => {
    const factor = clamp(t / nEval, 0, 1);
    return initialTemp * (1 - factor) * visitParam;
  };
}

function makeLogCoolingSchedule(visitParam: number, initialTemp: number): CoolingSchedule {
  const visit = 2.62;
  const t1 = visit - visitParam;
  return (t: number) => {
    const a = Math.log(t1 * (t + 1));
    const temp = initialTemp / a;
    return temp < 0 ? 0 : temp;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

type CoolingSchedule = (n: number) => number;

function makeUniformNeighborSelection(): NeighborSelectionFunc<number> {
  return (candidates: number[]) => Paul.chooseBetween(candidates.length);
}

function makeGreedyNeighborSelection(): NeighborSelectionFunc<number> {
  return (candidates: number[]) => candidates.indexOf(Math.min(...candidates));
}

function makeWeigtedNeighborSelection(n: number): NeighborSelectionFunc<number> {
  if (n < 0) {
    throw new Error("number of neighbors must be positive");
  } else if (n === 1) {
    throw new Error("specified weighted neighbor strategy, but provided nonsensical neighbor count of 1");
  }

  const normalizingFactor = 1 / (n - 1);

  return (candidates: number[]) => {
    const totalEnergy = sum(candidates);
    const probabilities = new Array<number>(n);
    for (let i = 0; i < candidates.length; ++i) {
      const energy = candidates[i];
      probabilities[i] = normalizingFactor * (1 - energy / totalEnergy);
    }
    Logger.log(JSON.stringify({ candidates, totalEnergy, probabilities }));
    const idx = Paul.chooseWithProbabilities(probabilities);
    return idx;
  };
}

/**
 * NeighborSelectionFunc takes a set of candidate energy values and returns the index `i` of the chosen neighbor as determined by the underlying algorithm.
 */
type NeighborSelectionFunc<T> = (neighbors: T[]) => number;
