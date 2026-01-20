import { OptimizerArgs } from "@/types";
import { Optimizer } from "@/optimizer";
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
import assert from "assert";

export class SAOptimizer extends Optimizer {
  // Number of iterations to perform during optimization.
  private msOpts: { batchSize: number; numBatches: number };
  private accumulatedTimeSpentByMeasuring: number;
  // Optimizer-specific args
  private initialTemperature: number;
  private maxMutationStepSize: number; // Maximum number of "steps" a single candidate shall take. Depends also on the current temperature.
  private acceptParam: number;
  private visitParam: number;
  private stepSizeParam: number;
  private numNeighbors: number;
  private neighborSelectionFunc: NeighborSelectionFunc<number>;
  private candidates: Array<{ asm: string; stacklength: number; choice: CHOICE; ninst: number }>;

  private coolingSchedule: CoolingSchedule;

  public constructor(args: OptimizerArgs) {
    super(args);
    // MeasureSuite config
    this.msOpts = { batchSize: 200, numBatches: 31 };
    this.accumulatedTimeSpentByMeasuring = 0;

    this.acceptParam = this.args.saAcceptParam;
    this.visitParam = this.args.saVisitParam;
    this.stepSizeParam = this.args.saStepSizeParam;
    this.numNeighbors = Math.round(this.args.saNumNeighbors);
    this.maxMutationStepSize = Math.round(this.args.saMaxMutStepSize);
    this.initialTemperature = this.args.saInitialTemperature;
    // Index 0 is current function.
    this.candidates = new Array(1 + this.numNeighbors);
    for (let i = 0; i < this.candidates.length; ++i) {
      this.candidates[i] = {
        asm: "",
        stacklength: -1,
        choice: this.choice,
        ninst: -1,
      };
    }

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
        this.coolingSchedule = makeLinCoolingSchedule(
          this.args.evals,
          this.visitParam,
          this.initialTemperature,
        );
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

  /**
   * Assembles and saves the current model into `slot`.
   */
  private assemble(slot: number) {
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
    this.candidates[slot].asm = asm;
    this.candidates[slot].stacklength = assembleResult.stacklength;
    this.candidates[slot].choice = this.choice;
    this.candidates[slot].ninst = filteredInstructions.length;
  }

  public optimise() {
    /**
     * Writes candidate `i`'s ASM to file.
     */
    const writeASMString = (slot: number) => {
      writeString(
        pathResolve(this.libcheckfunctionDirectory, `current${slot}.asm`),
        // pathResolve(this.libcheckfunctionDirectory, `current${id(slot)}.asm`),
        this.candidates[slot].asm,
      );
    };

    /**
     * Samples a neighbor and saves it into `slot`. The model snapshot is saved with an `id` of `slot.toString()`.
     */
    const sampleNeighbor = (slot: number, temp: number) => {
      const numMuts = (() => {
        const scaledTemp = temp / this.stepSizeParam;
        const n = Math.round(cauchy({ loc: 1, scale: scaledTemp }));
        if (this.maxMutationStepSize <= 0) return Math.max(n, 1);
        return clamp(n, 1, this.maxMutationStepSize);
      })();
      FileLogger.log(`sampled neighbor ${slot} with step size of ${numMuts}`);
      for (let i = 0; i < numMuts; ++i) this.mutate();
      Model.saveSnaphot(slot.toString());
      this.assemble(slot);
    };

    return new Promise<number>((resolve) => {
      FileLogger.log("starting rls optimisation");
      printStartInfo({
        ...this.args,
        symbolname: this.symbolname,
        counter: this.measuresuite.timer,
      });
      const optimistaionStartDate = Date.now();
      const CURRENT_FUNCTION = 0 as const;
      let ratioString = "";
      let numEvals = 0;
      let currentEpoch = 0;
      let time = Date.now();
      let temp = 0;
      let showPerSecond = "many/s";
      let perSecondCounter = 0;

      // Before running the optimization loop, assemble the baseline program (at this point, no mutations have taken place).
      {
        this.assemble(CURRENT_FUNCTION);
        // Check for errors, if nothing happens here we are probably fine for the rest of the run.
        if (this.candidates[CURRENT_FUNCTION].asm.includes("undefined"))
          throw new Error("ASM string empty/undefined, big yikes");
      }

      const intervalHandle = setInterval(() => {
        temp = this.coolingSchedule(currentEpoch);
        FileLogger.log(`epoch ${currentEpoch}, temp=${temp}`);

        // Mutation & candidate generation.
        {
          Model.saveSnaphot("0");
          for (let i = 1; i <= this.numNeighbors; ++i) {
            sampleNeighbor(i, temp);
            numEvals++;
            Model.restoreSnapshot("0");
          }
        }

        // Analysis & neighbor selection.
        const analyseResult = (() => {
          try {
            if (this.args.verbose) this.candidates.forEach((_, i) => writeASMString(i));
            const now = Date.now();
            FileLogger.log("comparing candidates");
            const results = this.measuresuite.measure(
              this.msOpts.batchSize,
              this.msOpts.numBatches,
              this.candidates.map((c) => c.asm),
            );

            this.accumulatedTimeSpentByMeasuring += Date.now() - now;
            FileLogger.log("done with measurements for current iteration");
            return analyseMeasureResult(results, {
              batchSize: this.msOpts.batchSize,
              resultDir: this.args.resultDir,
            });
          } catch (e) {
            this.handleMeasurementError(e);
          }
        })();

        const meanrawCurrent = analyseResult.rawMedian[CURRENT_FUNCTION];
        const meanrawNeighbors = analyseResult.rawMedian.slice(1, analyseResult.rawMedian.length - 1);
        FileLogger.log(`analyseResult: ${JSON.stringify(analyseResult.rawMedian)}`);
        // + 1 cause index 0 is always the current ASM string.
        const neighborIdx = this.neighborSelectionFunc(meanrawNeighbors.map((x) => this.energy(x))) + 1;
        FileLogger.log(`chose neighbor: ${neighborIdx}`);
        const meanrawCandidate = analyseResult.rawMedian[neighborIdx];
        const meanrawCheck = analyseResult.rawMedian[analyseResult.rawMedian.length - 1];
        this.updateBatchSize(meanrawCheck);

        // Decide whether we want to keep mutated candidate.
        let kept: boolean;
        if ((kept = this.shouldAccept(this.energy(meanrawCurrent), this.energy(meanrawCandidate), temp))) {
          FileLogger.log(`keeping mutated candidate ${neighborIdx}`);
          this.candidates[CURRENT_FUNCTION].asm = this.candidates[neighborIdx].asm;
          this.candidates[CURRENT_FUNCTION].stacklength = this.candidates[neighborIdx].stacklength;
          this.candidates[CURRENT_FUNCTION].choice = this.candidates[neighborIdx].choice;
          this.candidates[CURRENT_FUNCTION].ninst = this.candidates[neighborIdx].ninst;
          Model.restoreSnapshot(neighborIdx.toString());
        } else {
          // Nothing needs to be done in this case, since we always pop the "current" state after exploring neighbors.
          FileLogger.log("keeping current");
          this.choice = this.candidates[neighborIdx].choice;
          this.updateNumRevert(this.choice);
        }

        // Start statistics & status update.
        {
          const indexGood = kept ? neighborIdx : 0;
          const indexBad = kept ? 0 : neighborIdx;
          const goodChunks = analyseResult.chunks[indexGood];
          const badChunks = analyseResult.chunks[indexBad];
          const minRaw = Math.min(meanrawCurrent, meanrawCandidate);

          globals.currentRatio = meanrawCheck / minRaw;
          ratioString = globals.currentRatio.toFixed(4);

          perSecondCounter++;
          if (Date.now() - time > 1000) {
            time = Date.now();
            showPerSecond = (perSecondCounter + "/s").padStart(6);
            perSecondCounter = 0;
          }

          logMutation({ choice: this.choice, kept, numEvals: currentEpoch });

          const prevBestCycleCount = globals.bestEpoch.result?.rawMedian[0] ?? Infinity;
          if (
            /* Either best is empty. */
            globals.bestEpoch.result === null ||
            /* Or it is present and this epoch has shown improvement. */
            minRaw < prevBestCycleCount
          ) {
            globals.bestEpoch = { result: analyseResult, indexGood, epoch: currentEpoch };
          }

          if (currentEpoch % PRINT_EVERY == 0) {
            const statusline = genStatusLine({
              ...this.args,
              logComment: this.args.logComment + ` temp=${temp.toFixed(2)}`,
              analyseResult,
              badChunks,
              batchSize: this.msOpts.batchSize,
              choice: this.choice,
              goodChunks,
              indexBad,
              indexGood,
              kept,
              no_of_instructions: this.no_of_instructions,
              numEvals: numEvals,
              ratioString,
              show_per_second: showPerSecond,
              stacklength: this.candidates[CURRENT_FUNCTION].stacklength,
              symbolname: this.symbolname,
              writeout: numEvals % (this.args.evals / LOG_EVERY) === 0,
            });
            process.stdout.write(statusline);
            globals.convergence.push(ratioString);
          }
        } // End statistics

        currentEpoch++;
        // Start cleanup
        {
          if (numEvals >= this.args.evals) {
            globals.time.generateCryptopt =
              (Date.now() - optimistaionStartDate) / 1000 - globals.time.validate;
            clearInterval(intervalHandle);
            // Generate statistics as ASM comments.
            let statistics: string[];
            const elapsed = Date.now() - optimistaionStartDate;
            const paddedSeed = padSeed(Paul.initialSeed);
            statistics = genStatistics({
              paddedSeed,
              ratioString,
              evals: this.args.evals,
              elapsed,
              batchSize: this.msOpts.batchSize,
              numBatches: this.msOpts.numBatches,
              acc: this.accumulatedTimeSpentByMeasuring,
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
                  .concat(this.candidates[CURRENT_FUNCTION].asm)
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
            resolve(0);
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
