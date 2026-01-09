import { OptimizerArgs, SA_NEIGHBOR_STRATEGY_T } from "@/types";
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
import { assemble, strip } from "@/assembler";
import { Paul } from "@/paul";
import { FiatBridge } from "@/bridge/fiat-bridge";
import { errorOut, ERRORS } from "@/errors";
import { execSync } from "child_process";
import { appendFileSync } from "fs";
import assert from "assert";
import { each } from "lodash-es";
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
    this.initialTemperature = this.args.saInitialTemperature;

    switch (this.args.saNeighborStrategy) {
      case "uniform":
        this.neighborSelectionFunc = uniformNeighborSelection();
        break;
      case "weighted":
        if (this.args.saNumNeighbors < 0) {
          throw new Error("number of neighbors must be positive");
        } else if (this.args.saNumNeighbors === 1) {
          throw new Error("specified weighted neighbor strategy, but nonsensical neighbor count of 1");
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
    return x;
  }

  private updateBatchSize(meanRaw: number) {
    this.msOpts.batchSize = Math.ceil((Number(this.args.cyclegoal) / meanRaw) * this.msOpts.batchSize);
    this.msOpts.batchSize = Math.min(this.msOpts.batchSize, 10000);
    this.msOpts.batchSize = Math.max(this.msOpts.batchSize, 5);
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

      // Baseline, original code.
      {
        const assembleResult = assemble(this.args.resultDir);
        const code = assembleResult.code;
        const filteredInstructions = code.filter((line) => line && !line.startsWith(";") && line !== "\n");
        this.no_of_instructions = filteredInstructions.length;
        // Write initial "clean" variant.
        this.asmStrings[currentFunction] = filteredInstructions.join("\n");
      }

      // Main optimization loop.
      for (let numEvals = 0; numEvals < this.nIter; numEvals++) {
        const candidateFunction = toggleFUNCTIONS(currentFunction);
        this.mutate();
        this.currentIter = numEvals + 1;
        Logger.log(`Current round: ${this.currentIter}`);

        // Assemble current model state.
        {
          const assembleResult = assemble(this.args.resultDir);
          const filteredInstructions = strip(assembleResult.code);
          this.no_of_instructions = filteredInstructions.length;
          // Update current mutation candidate.
          this.asmStrings[candidateFunction] = filteredInstructions.join("\n");
          stacklength = assembleResult.stacklength;
        }

        // At this point both programs in asmstrings will be populated.
        each(this.asmStrings, (asm) =>
          assert(!(asm === "" || asm.includes("undefined")), "ASM string empty, big yikes."),
        );

        // Write out asm strings if in verbose mode.
        if (this.args.verbose) {
          each(this.asmStrings, (asm, fn) => {
            const fname = "current" + (fn === FUNCTIONS.F_A ? "A" : "B") + ".asm";
            writeString(pathResolve(this.libcheckfunctionDirectory, fname), asm);
          });
        }

        // Perform measurement & analysis.
        const analyseResult = (() => {
          try {
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

        const [meanrawCurrent, meanrawNew, meanrawCheck] = analyseResult.rawMedian;
        this.updateBatchSize(meanrawCheck); // Update batch size based on analysis results.

        // Decide whether we want to keep mutated candidate.
        let kept: boolean;
        if (
          (kept = this.shouldAccept(
            this.energy(meanrawCurrent),
            this.energy(meanrawNew),
            this.coolingSchedule(numEvals),
          ))
        ) {
          Logger.log("keeping mutated candidate");
          // Swap
          currentFunction = candidateFunction;
        } else {
          Logger.log("reverting mutation");
          this.revertFunction();
        }

        // Status update
        {
          const indexGood = Number(meanrawCurrent > meanrawNew);
          const indexBad = 1 - indexGood;
          const goodChunks = analyseResult.chunks[indexGood];
          const badChunks = analyseResult.chunks[indexBad];
          const choice = this.choice;
          const minRaw = Math.min(meanrawCurrent, meanrawNew);

          globals.currentRatio = meanrawCheck / minRaw;
          ratioString = globals.currentRatio.toFixed(4);

          const prevBestCycleCount = globals.bestEpoch.result?.rawMedian[0] ?? Infinity;
          if (
            /* Either best is empty. */
            globals.bestEpoch.result === null ||
            /* Or it is present and this epoch has shown improvement. */
            minRaw < prevBestCycleCount
          ) {
            globals.bestEpoch = { result: analyseResult, indexGood, epoch: numEvals };
          }

          perSecondCounter++;
          if (Date.now() - time > 1000) {
            time = Date.now();
            showPerSecond = (perSecondCounter + "/s").padStart(6);
            perSecondCounter = 0;
          }

          logMutation({ choice, kept, numEvals });

          if (numEvals % PRINT_EVERY == 0) {
            const statusline = genStatusLine({
              ...this.args,
              logComment: this.args.logComment + ` temp=${this.coolingSchedule(this.currentIter).toFixed(2)}`,
              analyseResult,
              badChunks,
              batchSize: this.msOpts.batchSize,
              choice,
              goodChunks,
              indexBad,
              indexGood,
              kept,
              no_of_instructions: this.no_of_instructions,
              numEvals,
              ratioString,
              show_per_second: showPerSecond,
              stacklength,
              symbolname: this.symbolname,
              writeout: numEvals % (this.args.evals / LOG_EVERY) === 0,
            });
            process.stdout.write(statusline);
            globals.convergence.push(ratioString);
          }
        }
      } // End of optimization loop.

      globals.time.generateCryptopt = (Date.now() - optimistaionStartDate) / 1000 - globals.time.validate;
      // Generate statistics as ASM comments.
      let statistics: string[];
      {
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
      }

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

      // Done.
      resolve(0);
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
