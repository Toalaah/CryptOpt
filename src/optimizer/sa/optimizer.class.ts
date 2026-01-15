import { OptimizerArgs } from "@/types";
import { Optimizer } from "@/optimizer";
import Logger from "@/helper/Logger.class";
import { genStatistics, genStatusLine, logMutation, printStartInfo } from "@/optimizer/util";
import { FUNCTIONS } from "@/enums";
import { resolve as pathResolve } from "path";

import {
  PRINT_EVERY,
  LOG_EVERY,
  writeString,
  analyseMeasureResult,
  padSeed,
  generateResultFilename,
  shouldProof as shouldProve,
  toggleFUNCTIONS,
} from "@/helper";
import globals from "@/helper/globals";
import { assemble as assembleASM, strip } from "@/assembler";
import { Paul } from "@/paul";
import { FiatBridge } from "@/bridge/fiat-bridge";
import { errorOut, ERRORS } from "@/errors";
import { execSync } from "child_process";
import { appendFileSync } from "fs";
import { sum } from "simple-statistics";

export class SAOptimizer extends Optimizer {
  // Number of iterations to perform during optimization.
  private nIter: number;
  private currentIter: number;
  private msOpts: { batchSize: number; numBatches: number };
  private accumulatedTimeSpentByMeasuring: number;
  // Optimizer-specific args
  private initialTemperature: number;
  private acceptParam: number;
  private visitParam: number;
  private energyParam: number;
  private neighborSelectionFunc: NeighborSelectionFunc<number>;

  private coolingSchedule: CoolingSchedule;

  public constructor(args: OptimizerArgs) {
    super(args);
    this.nIter = this.args.evals;
    this.currentIter = 0;
    // measuresuite config
    this.msOpts = { batchSize: 200, numBatches: 31 };
    this.accumulatedTimeSpentByMeasuring = 0;

    this.acceptParam = this.args.saAcceptParam;
    this.visitParam = this.args.saVisitParam;
    this.energyParam = this.args.saEnergyParam;
    this.initialTemperature = this.args.saInitialTemperature;

    switch (this.args.saNeighborStrategy) {
      case "uniform":
        this.neighborSelectionFunc = uniformNeighborSelection();
        break;
      case "weighted":
        if (this.args.saNumNeighbors < 0) {
          throw new Error("number of neighbors must be positive");
        } else if (this.args.saNumNeighbors === 1) {
          throw new Error(
            "specified weighted neighbor strategy, but provided nonsensical neighbor count of 1",
          );
        } else {
          this.neighborSelectionFunc = weigtedNeighborSelection(this.args.saNumNeighbors);
        }
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

  private shouldAccept(currentEnergy: number, visitEnergy: number, temp: number) {
    const r = Math.random();
    if (visitEnergy < currentEnergy) {
      return true;
    }
    const temp_step = temp / this.currentIter; // Scale temp according to current iteration.
    const x = 1.0 - (this.acceptParam * (visitEnergy - currentEnergy)) / temp_step;
    const pr = x <= 0 ? 0 : Math.exp(Math.log(x) / this.acceptParam);
    Logger.log(`accepting worse candidate with probability ${pr}`);
    return pr >= r;
  }

  // private shouldAcceptClassic(currentEnergy: number, visitEnergy: number, temp: number) {
  //   const r = Math.random();
  //   if (visitEnergy < currentEnergy) {
  //     return true;
  //   }
  //   const x = visitEnergy - currentEnergy;
  //   const pr = Math.exp(-x / temp);
  //   assert(0 < pr && pr <= 1);
  //   Logger.log(`accepting worse candidate with probability ${pr}`);
  //   return pr >= r;
  // }

  // TODO: should this be somehow scaled?
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
  private assemble(slot: FUNCTIONS) {
    Logger.log("assembling");
    const assembleResult = assembleASM(this.args.resultDir);
    const code = assembleResult.code;
    const filteredInstructions = strip(code);
    this.no_of_instructions = filteredInstructions.length;
    switch (this.args.verbose) {
      case true:
        const c = code.join("\n");
        writeString(pathResolve(this.libcheckfunctionDirectory, "current.asm"), c);
        this.asmStrings[slot] = c;
        break;
      case false:
        this.asmStrings[slot] = filteredInstructions.join("\n");
        break;
    }
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
      let ratioString = "";

      let currentFunction = FUNCTIONS.F_A;

      let stacklength = 0;
      let time = Date.now();
      let showPerSecond = "many/s";
      let perSecondCounter = 0;
      const writeASM = (slot: FUNCTIONS) =>
        writeString(
          pathResolve(this.libcheckfunctionDirectory, `current${slot === FUNCTIONS.F_A ? "A" : "B"}.asm`),
          this.asmStrings[slot],
        );

      // Before running the optimization loop, assemble the baseline program (at this point, no mutations have taken place).
      {
        this.assemble(currentFunction);
        // Check for errors, if nothing happens here we are probably fine for the rest of the run.
        if (this.asmStrings[currentFunction].includes("undefined"))
          throw new Error("ASM string empty/undefined, big yikes");
      }

      const intervalHandle = setInterval(() => {
        const candidateFunction = toggleFUNCTIONS(currentFunction);

        // Perform mutation && assemble current candidate.
        this.mutate();
        this.assemble(candidateFunction);

        const analyseResult = (() => {
          try {
            if (this.args.verbose) {
              writeASM(currentFunction);
              writeASM(candidateFunction);
            }
            const now = Date.now();
            Logger.log("comparing candidates");
            const results = this.measuresuite.measure(this.msOpts.batchSize, this.msOpts.numBatches, [
              this.asmStrings[currentFunction],
              this.asmStrings[candidateFunction],
            ]);
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

        const [meanrawCurrent, meanrawCandidate, meanrawCheck] = analyseResult.rawMedian;
        this.updateBatchSize(meanrawCheck); // Update batch size based on analysis results.

        // Decide whether we want to keep mutated candidate.
        let kept: boolean;
        if (
          (kept = this.shouldAccept(
            this.energy(meanrawCurrent),
            this.energy(meanrawCandidate),
            this.coolingSchedule(this.currentIter),
          ))
        ) {
          Logger.log("keeping mutated candidate");
          currentFunction = candidateFunction;
        } else {
          Logger.log("reverting mutation");
          this.revertFunction();
        }

        // Start statistics & status update.
        {
          const indexGood = Number(meanrawCurrent > meanrawCandidate);
          const indexBad = 1 - indexGood;
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

          logMutation({ choice: this.choice, kept, numEvals: this.currentIter });

          const prevBestCycleCount = globals.bestEpoch.result?.rawMedian[0] ?? Infinity;
          if (
            /* Either best is empty. */
            globals.bestEpoch.result === null ||
            /* Or it is present and this epoch has shown improvement. */
            minRaw < prevBestCycleCount
          ) {
            globals.bestEpoch = { result: analyseResult, indexGood, epoch: this.currentIter };
          }

          if (this.currentIter % PRINT_EVERY == 0) {
            const statusline = genStatusLine({
              ...this.args,
              logComment: this.args.logComment + ` temp=${this.coolingSchedule(this.currentIter).toFixed(2)}`,
              analyseResult,
              badChunks,
              batchSize: this.msOpts.batchSize,
              choice: this.choice,
              goodChunks,
              indexBad,
              indexGood,
              kept,
              no_of_instructions: this.no_of_instructions,
              numEvals: this.currentIter,
              ratioString,
              show_per_second: showPerSecond,
              stacklength,
              symbolname: this.symbolname,
              writeout: this.currentIter % (this.args.evals / LOG_EVERY) === 0,
            });
            process.stdout.write(statusline);
            globals.convergence.push(ratioString);
          }
        } // End statistics

        this.currentIter++;
        // Start cleanup
        {
          if (this.currentIter >= this.nIter) {
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
              // write best found solution with headers
              // flip, because we want the last accepted, not the last mutated.
              const flipped = toggleFUNCTIONS(currentFunction);

              writeString(
                asmFile,
                ["SECTION .text", `\tGLOBAL ${this.symbolname}`, `${this.symbolname}:`]
                  .concat(this.asmStrings[flipped])
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
            this.cleanLibcheckfunctions();
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

function uniformNeighborSelection(): NeighborSelectionFunc<number> {
  return (candidates: number[]) => candidates[Paul.chooseBetween(candidates.length)];
}

function weigtedNeighborSelection(n: number): NeighborSelectionFunc<number> {
  if (n < 2) throw new Error(`invalid neighbor size: ${n}`);
  const normalizingFactor = 1 / (n - 1);

  return (candidates: number[]) => {
    const totalEnergy = sum(candidates);
    const probabilities = new Array<number>(n);
    for (let i = 0; i < candidates.length; ++i) {
      const energy = candidates[i];
      probabilities[i] = normalizingFactor * (1 - energy / totalEnergy);
    }
    const idx = Paul.chooseWithProbabilities(probabilities);
    return candidates[idx];
  };
}

type NeighborSelectionFunc<T> = (neighbors: T[]) => T;
