import { OptimizerArgs } from "@/types";
import { Optimizer } from "@/optimizer";
import { Logger } from "@/helper/Logger.class";
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

export class SAOptimizer extends Optimizer {
  // Number of iterations to perform during optimization.
  private nIter: number;
  private msOpts: { batchSize: number; numBatches: number };
  private accumulatedTimeSpentByMeasuring: number;
  // Optimizer-specific args
  private initialTemperature: number;
  private acceptParam: number;
  private visitParam: number;
  private energyParam: number;
  private numNeighbors: number;
  private neighborSelectionFunc: NeighborSelectionFunc<number>;
  private candidates: Array<{ asm: string; stacklength: number; choice: CHOICE }>;

  private coolingSchedule: CoolingSchedule;

  public constructor(args: OptimizerArgs) {
    super(args);
    this.nIter = this.args.evals;
    // MeasureSuite config
    this.msOpts = { batchSize: 200, numBatches: 31 };
    this.accumulatedTimeSpentByMeasuring = 0;

    this.acceptParam = this.args.saAcceptParam;
    this.visitParam = this.args.saVisitParam;
    this.numNeighbors = this.args.saNumNeighbors;
    this.energyParam = this.args.saEnergyParam;
    this.initialTemperature = this.args.saInitialTemperature;
    // Index 0 is current function.
    this.candidates = new Array(1 + this.numNeighbors);
    for (let i = 0; i < this.candidates.length; ++i) {
      this.candidates[i] = {
        asm: "",
        stacklength: -1,
        choice: this.choice,
      };
    }

    switch (this.args.saNeighborStrategy) {
      case "uniform":
        this.neighborSelectionFunc = makeUniformNeighborSelection(this.args.saNumNeighbors);
        break;
      case "weighted":
        this.neighborSelectionFunc = makeWeigtedNeighborSelection(this.args.saNumNeighbors);
        break;
      default:
        throw new Error(`unknown neighbor proposal strategy: ${this.args.saNeighborStrategy}`);
    }
    Logger.log(`neighbor strategy: ${this.args.saNeighborStrategy}`);

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

  private shouldAccept(currentEnergy: number, visitEnergy: number, temp: number, epoch: number) {
    if (visitEnergy < currentEnergy) {
      return true;
    }
    if (this.acceptParam <= 0) return false;
    const r = Math.random();
    const temp_step = temp / epoch; // Scale temp according to current iteration.
    const x = 1.0 - (this.acceptParam * (visitEnergy - currentEnergy)) / temp_step;
    const pr = x <= 0 ? 0 : Math.exp(Math.log(x) / this.acceptParam);
    Logger.log(`accepting worse candidate with probability ${pr}`);
    return pr >= r;
  }

  private energy(x: number): number {
    return x * this.energyParam;
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
    this.no_of_instructions = filteredInstructions.length;
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
  }

  public optimise() {
    return new Promise<number>((resolve) => {
      Logger.log("starting rls optimisation");
      printStartInfo({
        ...this.args,
        symbolname: this.symbolname,
        counter: this.measuresuite.timer,
      });
      const optimistaionStartDate = Date.now();
      const CURRENT_FUNCTION = 0 as const;
      let ratioString = "";
      let currentEpoch = 0;
      let time = Date.now();
      let showPerSecond = "many/s";
      let perSecondCounter = 0;

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

      // Before running the optimization loop, assemble the baseline program (at this point, no mutations have taken place).
      {
        this.assemble(CURRENT_FUNCTION);
        // Check for errors, if nothing happens here we are probably fine for the rest of the run.
        if (this.candidates[CURRENT_FUNCTION].asm.includes("undefined"))
          throw new Error("ASM string empty/undefined, big yikes");
      }

      const intervalHandle = setInterval(() => {
        // Mutation & candidate generation.
        {
          Model.saveSnaphot("0");
          // const old = JSON.stringify(Model.getState());
          // We need to generate a unique candidate for the number of neighbors we want to explore.
          for (let i = 1; i <= this.numNeighbors; ++i) {
            // Perform mutation && assemble current candidate.
            this.mutate();
            // assert(JSON.stringify(Model.getState()) !== old);
            // currentEpoch++;
            Model.saveSnaphot(i.toString());
            this.assemble(i);
            // Model now holds original state once again.
          }
          Model.restoreSnapshot("0");
        }

        // writeString(
        //   pathResolve(this.libcheckfunctionDirectory, `candidates.json`),
        //   JSON.stringify(this.candidates, null, 2),
        // );

        // if (this.candidates[CURRENT_FUNCTION].asm == this.candidates[1].asm) {
        //   errorOut({ exitCode: 1, msg: "bad" + currentEpoch });
        // }

        // Analysis & neighbor selection.
        const analyseResult = (() => {
          try {
            if (this.args.verbose) this.candidates.forEach((_, i) => writeASMString(i));
            const now = Date.now();
            Logger.log("comparing candidates");
            const results = this.measuresuite.measure(
              this.msOpts.batchSize,
              this.msOpts.numBatches,
              this.candidates.map((c) => c.asm),
            );

            this.accumulatedTimeSpentByMeasuring += Date.now() - now;
            Logger.log("done with measurements for current iteration");
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
        Logger.log(`analyseResult: ${JSON.stringify(analyseResult.rawMedian)}`);
        // + 1 cause index 0 is always the current ASM string.
        const neighborIdx = this.neighborSelectionFunc(meanrawNeighbors.map((x) => this.energy(x))) + 1;
        Logger.log(`chose neighbor: ${neighborIdx}`);
        const meanrawCandidate = analyseResult.rawMedian[neighborIdx];
        const meanrawCheck = analyseResult.rawMedian[analyseResult.rawMedian.length - 1];
        this.updateBatchSize(meanrawCheck);
        // this.numEvals++;

        // Decide whether we want to keep mutated candidate.
        let kept: boolean;
        if (
          (kept = this.shouldAccept(
            this.energy(meanrawCurrent),
            this.energy(meanrawCandidate),
            this.coolingSchedule(currentEpoch),
            currentEpoch,
          ))
        ) {
          Logger.log("keeping mutated candidate");
          this.candidates[CURRENT_FUNCTION].asm = this.candidates[neighborIdx].asm;
          this.candidates[CURRENT_FUNCTION].stacklength = this.candidates[neighborIdx].stacklength;
          this.candidates[CURRENT_FUNCTION].choice = this.candidates[neighborIdx].choice;
          Model.restoreSnapshot(neighborIdx.toString());
        } else {
          // Nothing needs to be done in this case, since we always pop the "current" state after exploring neighbors.
          Logger.log("keeping current");
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
              logComment: this.args.logComment + ` temp=${this.coolingSchedule(currentEpoch).toFixed(2)}`,
              analyseResult,
              badChunks,
              batchSize: this.msOpts.batchSize,
              choice: this.choice,
              goodChunks,
              indexBad,
              indexGood,
              kept,
              no_of_instructions: this.no_of_instructions,
              numEvals: currentEpoch,
              ratioString,
              show_per_second: showPerSecond,
              stacklength: this.candidates[CURRENT_FUNCTION].stacklength,
              symbolname: this.symbolname,
              writeout: currentEpoch % (this.args.evals / LOG_EVERY) === 0,
            });
            process.stdout.write(statusline);
            globals.convergence.push(ratioString);
          }
        } // End statistics

        currentEpoch++;
        // Start cleanup
        {
          if (currentEpoch >= this.nIter) {
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

function makeLinCoolingSchedule(nIter: number, visitParam: number, initialTemp: number): CoolingSchedule {
  return (t: number) => {
    const factor = clamp(t / nIter, 0, 1);
    return initialTemp * (1 - factor) * visitParam;
  };
}

function makeLogCoolingSchedule(visitParam: number, initialTemp: number): CoolingSchedule {
  const visit = 2.62;
  const t1 = visit - visitParam;
  return (t: number) => {
    const a = Math.log(t1 * t);
    const temp = initialTemp / a;
    return temp < 0 ? 0 : temp;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

type CoolingSchedule = (n: number) => number;

function makeUniformNeighborSelection(n: number): NeighborSelectionFunc<number> {
  if (n !== 1) throw new Error("number of neighbors must be 1 when using uniform neighbor strategy");
  return (candidates: number[]) => Paul.chooseBetween(candidates.length);
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
