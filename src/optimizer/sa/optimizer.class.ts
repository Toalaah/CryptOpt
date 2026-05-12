import { OptimizerArgs } from "@/types";
import { Optimizer, OptimizerResult } from "@/optimizer";
import { FileLogger, Logger } from "@/helper/Logger.class";
import { genStatistics, genStatusLine, logMutation, printStartInfo } from "@/optimizer/util";
import { resolve as pathResolve } from "path";

import {
  PRINT_EVERY,
  LOG_EVERY,
  writeString,
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
import { Model } from "@/model";
import { CHOICE } from "@/enums";
import { cauchy } from "@/paul/distributions";

export class SAOptimizer extends Optimizer {
  private nIter: number;
  private acceptParam: number;
  private visitParam: number;
  private stepSizeParam: number;

  private initialTemperature: number;
  private reannealThreshold: number;

  private mutationStepSizeMin: number; // Min number of "steps" a single candidate shall take. Depends also on the current temperature.
  private mutationStepSizeMax: number; // Maximum number of "steps" a single candidate shall take. Depends also on the current temperature.
  private mutationStepSizeLoc: number; // Center of distribution. This should really never *not* be 1, honestly.

  private coolingSchedule: CoolingSchedule;

  public constructor(args: OptimizerArgs) {
    super(args);

    this.nIter = this.args.evals;
    this.acceptParam = this.args.saAcceptParam;
    this.visitParam = this.args.saVisitParam;
    this.stepSizeParam = this.args.saStepSizeParam;

    this.initialTemperature = this.args.saInitialTemperature;
    if (this.initialTemperature <= 0) throw new Error(`initial temperature must be positive`);

    this.mutationStepSizeLoc = Math.round(this.args.saMutStepSizeLoc);
    this.mutationStepSizeMin = Math.round(this.args.saMutStepSizeMin);
    this.mutationStepSizeMax = Math.round(this.args.saMutStepSizeMax);
    if (this.mutationStepSizeMin > this.mutationStepSizeMax)
      throw new Error(`min mut step size must be <= max mutstepsize`);
    if (
      this.mutationStepSizeLoc > this.mutationStepSizeMax ||
      this.mutationStepSizeLoc < this.mutationStepSizeMin
    )
      throw new Error(`loc mut step size must be between min and max mutstepsize`);

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

    this.reannealThreshold = this.args.saReannealBaseThreshold;
  }

  private shouldAccept(currentEnergy: number, visitEnergy: number, temp: number) {
    if (visitEnergy < currentEnergy) {
      return true;
    }
    if (this.acceptParam <= 0) return false;

    const r = Paul.uniform();
    const delta = (visitEnergy - currentEnergy) / this.acceptParam;
    if (!(delta >= 0)) errorOut({ exitCode: 123, msg: "negative delta" });
    const x = (-1 * delta) / temp;
    const pr = Math.min(1, Math.exp(x));
    FileLogger.log(`accepting worse candidate with probability ${pr}`);
    return pr >= r;
  }

  // Likely we will never have to make crazy adjustments here, but we still use this identity function to make potential future refactoring easy.
  private energy(x: number): number {
    return x;
  }

  public optimise() {
    type State = { asm: string; ratio: number; cycleCount: number };
    type Candidate = {
      asm: string;
      stacklength: number;
      choice: CHOICE;
      ninst: number;
      mutStats: { numDecision: number; numPerm: number };
    };
    const CURRENT_FUNCTION = 0 as const;
    const CANDIDATE_FUNCTION = 1 as const;
    const CHECK = 2 as const;
    const candidates = new Array<Candidate>(2);
    for (let i = 0; i < candidates.length; ++i) {
      candidates[i] = {
        asm: "",
        stacklength: -1,
        choice: this.choice,
        ninst: -1,
        mutStats: {
          numDecision: 0,
          numPerm: 0,
        },
      };
    }

    let ratioString = "";
    let numEvals = 0;
    let temperature = 0;

    let xBestRatio: State = { asm: "", ratio: 0, cycleCount: Infinity }; // Add slot for storing the best result we see.
    let xBestCycle: State = { asm: "", ratio: 0, cycleCount: Infinity }; // Add slot for storing the best result we see.
    let current: State = { asm: "", ratio: 0, cycleCount: 0 };

    let showPerSecond = "many/s";
    let perSecondCounter = 0;

    let currentAcceptStreak = 0;
    let currentRejectStreak = 0;

    // Used to track how/when we should reanneal.
    let annealingIndex = 0;
    let currentAnnealingCycleThreshold = this.reannealThreshold;
    let currentStalenessThreshold = this.reannealThreshold;
    let epochsSinceLastBestImprovement = 0;

    // Various helpers used in main optimization loop below.

    const assemble = (slot: number): { asm: string; wasNew: boolean } => {
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
      const wasNew = this.addToSeen(asm);
      candidates[slot].asm = asm;
      candidates[slot].stacklength = assembleResult.stacklength;
      candidates[slot].ninst = filteredInstructions.length;
      return { asm, wasNew };
    };

    /**
     * Determines when the optimization loop should end.
     */
    const shouldStop = () => numEvals >= this.nIter;

    const shouldReanneal = () => {
      if (annealingIndex < currentAnnealingCycleThreshold) return false;
      return epochsSinceLastBestImprovement >= currentStalenessThreshold;
    };

    /**
     * Updates best results. Returns true if best was improved, else false.
     */
    const updateBest = (state: State) => {
      let didUpdate = false;
      if (state.ratio >= xBestRatio.ratio) {
        xBestRatio.asm = state.asm;
        xBestRatio.ratio = state.ratio;
        xBestRatio.cycleCount = state.cycleCount;
        // didUpdate = true;
      }
      if (state.cycleCount <= xBestCycle.cycleCount) {
        xBestCycle.asm = state.asm;
        xBestCycle.ratio = state.ratio;
        xBestCycle.cycleCount = state.cycleCount;
        didUpdate = true;
      }
      return didUpdate;
    };

    /**
     * Samples a neighbor and saves it into Model snaphshot `slot`. The model snapshot is saved with an `id` of `slot.toString()`. Returns the number of permutations/decisions which were made to sample the neighbor.
     */
    const sampleNeighbor = (slot: number, temp: number) => {
      const numMuts = (() => {
        const scaledTemp = temp * this.stepSizeParam;
        // Use Cauchy-Lorentz distribution, allows for occasional long tails to explore the search space more rapidly.
        const n = Math.abs(Math.round(cauchy({ loc: this.mutationStepSizeLoc, scale: scaledTemp })));
        const clamped = clamp(n, this.mutationStepSizeMin, this.mutationStepSizeMax);
        // if (clamped > this.mutationStats.maxMutStepSize) this.mutationStats.maxMutStepSize = clamped;
        Logger.log(
          `sampled neighbor ${slot} with step size of ${n} (clamped=${clamped}) (scale=${scaledTemp}, loc=${this.mutationStepSizeLoc})`,
        );
        return clamped;
      })();
      const mutResult = this.mutateBatch(numMuts);
      Model.saveSnaphot(slot.toString());
      return mutResult;
    };

    return new Promise<OptimizerResult>((resolve) => {
      Logger.log("starting sa optimisation");
      printStartInfo({
        ...this.args,
        symbolname: this.objective.getSymbolname(),
        counter: this.objective.getCounter(),
      });

      const optimistaionStartDate = Date.now();
      let time = Date.now();
      let accumulatedTimeSpentByMeasuring = 0;

      // Before running the optimization loop, assemble the baseline program (at this point, no mutations have taken place).
      {
        const { asm } = assemble(CURRENT_FUNCTION);
        // Check for errors, if nothing happens here we are probably fine for the rest of the run.
        if (asm.includes("undefined"))
          errorOut({ msg: "ASM string empty/undefined, big yikes", exitCode: 1 });
      }

      const intervalHandle = setInterval(() => {
        temperature = this.coolingSchedule(annealingIndex) * Math.pow(0.9, this.mutationStats.numReanneals);
        let wasNewCandidate = false;
        const currentEpoch = numEvals;
        if (temperature <= 0) errorOut({ exitCode: 123, msg: "temperature <= 0" });
        Logger.log(`epoch ${currentEpoch}, temp=${temperature}`);

        // Mutation & candidate generation.
        {
          Model.saveSnaphot("current");
          const { perm, decision } = sampleNeighbor(CANDIDATE_FUNCTION, temperature);
          const { asm, wasNew } = assemble(CANDIDATE_FUNCTION);
          wasNewCandidate = wasNew;
          candidates[CANDIDATE_FUNCTION].mutStats.numPerm = perm;
          candidates[CANDIDATE_FUNCTION].mutStats.numDecision = decision;
          candidates[CANDIDATE_FUNCTION].asm = asm;
          candidates[CANDIDATE_FUNCTION].choice = this.choice;
          this.mutationStats.numMut.permutation += perm;
          this.mutationStats.numMut.decision += decision;
          Model.restoreSnapshot("current");
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
            const now_measure = Date.now();
            const analyseResult = this.objective.measure(candidates.map((c) => c.asm));
            accumulatedTimeSpentByMeasuring += Date.now() - now_measure;
            return analyseResult;
          } catch (e) {
            this.handleMeasurementError(e);
          }
        })();

        const meanrawCurrent = analyseResult.rawMedian[CURRENT_FUNCTION];
        const meanrawCandidate = analyseResult.rawMedian[CANDIDATE_FUNCTION];
        const meanrawCheck = analyseResult.rawMedian[CHECK];

        let didUpdateBest = false;
        for (let i = 0; i < analyseResult.rawMedian.length - 1; ++i) {
          const res = analyseResult.rawMedian[i];
          const ratio = meanrawCheck / res;
          const cycleCount = analyseResult.batchSizeScaledrawMedian[i];
          const improved = updateBest({ asm: candidates[i].asm, ratio, cycleCount });
          if (improved) didUpdateBest = true;
        }
        if (didUpdateBest) {
          epochsSinceLastBestImprovement = 0;
        } else {
          epochsSinceLastBestImprovement++;
        }

        // Decide whether we want to keep mutated candidate.
        let kept: boolean;
        if (
          (kept = this.shouldAccept(this.energy(meanrawCurrent), this.energy(meanrawCandidate), temperature))
        ) {
          Logger.log("kept mutation");
          this.mutationStats.numAcceptedEvals++;
          currentRejectStreak = 0;
          this.mutationStats.maxAcceptStreak = Math.max(
            this.mutationStats.maxAcceptStreak,
            ++currentAcceptStreak,
          );
          candidates[CURRENT_FUNCTION].asm = candidates[CANDIDATE_FUNCTION].asm;
          candidates[CURRENT_FUNCTION].stacklength = candidates[CANDIDATE_FUNCTION].stacklength;
          candidates[CURRENT_FUNCTION].choice = candidates[CANDIDATE_FUNCTION].choice;
          candidates[CURRENT_FUNCTION].ninst = candidates[CANDIDATE_FUNCTION].ninst;
          this.no_of_instructions = candidates[CANDIDATE_FUNCTION].ninst;
          Model.restoreSnapshot(CANDIDATE_FUNCTION.toString());
          if (didUpdateBest) {
            Model.saveSnaphot("best");
          }
        } else {
          Logger.log("keeping current");
          this.mutationStats.numRejectedEvals++;
          currentAcceptStreak = 0;
          this.mutationStats.maxRejectStreak = Math.max(
            this.mutationStats.maxRejectStreak,
            ++currentRejectStreak,
          );
          // Nothing needs to be done in this case, since we always pop the "current" state after exploring neighbors.
          // Use rejected candidate's choice here. TODO: does this even make sense to track in such a way if we perform multiple mutations? Might be more useful to just update a counter...
          this.choice = candidates[CANDIDATE_FUNCTION].choice;
          this.mutationStats.numRevert.permutation += candidates[CANDIDATE_FUNCTION].mutStats.numPerm;
          this.mutationStats.numRevert.decision += candidates[CANDIDATE_FUNCTION].mutStats.numDecision;
        }

        // Start statistics & status update.
        {
          const indexGood = kept ? CANDIDATE_FUNCTION : CURRENT_FUNCTION;
          const indexBad = kept ? CURRENT_FUNCTION : CANDIDATE_FUNCTION;
          const goodChunks = analyseResult.chunks[indexGood];
          const badChunks = analyseResult.chunks[indexBad];
          const minRaw = Math.min(meanrawCurrent, meanrawCandidate);

          const currentRatio = meanrawCheck / minRaw;
          const currentCycleCount = analyseResult.batchSizeScaledrawMedian[indexGood];
          current.asm = candidates[CURRENT_FUNCTION].asm;
          current.ratio = currentRatio;
          current.cycleCount = currentCycleCount;
          globals.currentRatio = currentRatio;

          // Update globals w.r.t best ratios/cycle counts.
          {
            if (currentRatio > globals.bestEpochByRatio.ratio) {
              // Check if we found new PB this epoch.
              globals.bestEpochByRatio.epoch = currentEpoch;
              globals.bestEpochByRatio.nEvals = numEvals;
              globals.bestEpochByRatio.ratio = currentRatio;
              globals.bestEpochByRatio.cycleCount = currentCycleCount;
            }

            if (currentCycleCount < globals.bestEpochByCycle.cycleCount) {
              globals.bestEpochByCycle.result = analyseResult;
              globals.bestEpochByCycle.indexGood = indexGood;
              globals.bestEpochByCycle.epoch = currentEpoch;
              globals.bestEpochByCycle.ratio = currentRatio;
              globals.bestEpochByCycle.nEvals = numEvals;
              globals.bestEpochByCycle.cycleCount = currentCycleCount;
            }
          }

          ratioString = globals.currentRatio.toFixed(4);
          perSecondCounter++;
          if (Date.now() - time > 1000) {
            time = Date.now();
            showPerSecond = (perSecondCounter + "/s").padStart(6);
            perSecondCounter = 0;
          }

          logMutation({
            choice: this.choice,
            kept,
            wasNewCandidate,
            numEvals: numEvals,
            epoch: currentEpoch,
            nDesc: candidates[CANDIDATE_FUNCTION].mutStats.numDecision,
            nPerm: candidates[CANDIDATE_FUNCTION].mutStats.numPerm,
            temp: temperature,
            ratio: currentRatio,
          });

          if (currentEpoch % PRINT_EVERY == 0) {
            const statusline = genStatusLine({
              ...this.args,
              logComment: this.args.logComment + ` temp=${temperature.toFixed(2)}`,
              analyseResult,
              badChunks,
              batchSize: this.objective.batchSize,
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

        numEvals++;
        annealingIndex++;

        // Determine whether to re-anneal.
        if (shouldReanneal()) {
          Logger.log(`reannealing`);
          this.mutationStats.numReanneals++;
          annealingIndex = 0;
          epochsSinceLastBestImprovement = 0;
          currentAnnealingCycleThreshold *= 2;
          // currentStalenessThreshold *= 2;
        }

        if (numEvals % 100 == 0) {
          Logger.log("retesting best");
          const res = this.objective.measure([xBestCycle.asm]);
          xBestCycle.cycleCount = res.batchSizeScaledrawMedian[0];
        }

        // Start cleanup
        {
          if (shouldStop()) {
            globals.time.generateCryptopt =
              (Date.now() - optimistaionStartDate) / 1000 - globals.time.validate;
            clearInterval(intervalHandle);
            // Generate statistics as ASM comments.
            let statistics: string[];
            const elapsed = Date.now() - optimistaionStartDate;
            const paddedSeed = padSeed(Paul.initialSeed);
            Model.restoreSnapshot("best");

            let final = current;
            const finalAsm = final.asm;
            const finalRatio = final.ratio;
            const finalCycle = final.cycleCount;

            globals.currentRatio = finalRatio;
            ratioString = globals.currentRatio.toFixed(4);
            globals.convergence.push(ratioString);

            this.mutationStats.avgMutStepSize =
              (this.mutationStats.numMut.decision + this.mutationStats.numMut.permutation) / currentEpoch;

            const numBatches = this.objective.numBatches;
            const batchSize = this.objective.batchSize;
            const counter = this.objective.getCounter();
            statistics = genStatistics({
              paddedSeed,
              ratioString,
              evals: this.nIter,
              elapsed,
              batchSize,
              numBatches,
              acc: accumulatedTimeSpentByMeasuring,
              numRevert: this.mutationStats.numRevert,
              numMut: this.mutationStats.numMut,
              counter,
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
                  .concat(finalAsm)
                  .concat(statistics)
                  .join("\n"),
              );

              writeString(mutationsCsvFile, globals.mutationLog.join("\n"));

              // Also write out the global best.
              {
                const [xBestRatioAsmFile, xBestCycleAsmFile] = generateResultFilename(
                  { ...this.args, symbolname: this.symbolname },
                  [
                    `_ratio${xBestRatio.ratio.toFixed(4).replace(".", "")}_best_ratio.asm`,
                    `_ratio${xBestCycle.ratio.toFixed(4).replace(".", "")}_best_cycle.asm`,
                  ],
                );
                writeString(
                  xBestRatioAsmFile,
                  ["SECTION .text", `\tGLOBAL ${this.symbolname}`, `${this.symbolname}:`]
                    .concat(xBestRatio.asm)
                    .concat(statistics)
                    .join("\n"),
                );
                writeString(
                  xBestCycleAsmFile,
                  ["SECTION .text", `\tGLOBAL ${this.symbolname}`, `${this.symbolname}:`]
                    .concat(xBestCycle.asm)
                    .concat(statistics)
                    .join("\n"),
                );
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
              this.objective.cleanup();
              resolve({
                ratio: finalRatio,
                cycleCount: finalCycle,
                numEvals: currentEpoch,
              });
            }
          }
        } // End cleanup
      }, 0);
    });
  }
}

type CoolingSchedule = (n: number) => number;

function makeExpCoolingSchedule(visitParam: number, initialTemp: number): CoolingSchedule {
  const a = visitParam - 1;
  const t1 = Math.expm1(a * Math.log(2.0)); // 2^a - 1
  return (t: number) => {
    const s = t + 2.0;
    const t2 = Math.expm1(a * Math.log(s)); // (t+2)^a - 1
    return (initialTemp * t1) / t2;
  };
}

function makeLinCoolingSchedule(nEval: number, visitParam: number, initialTemp: number): CoolingSchedule {
  return (t: number) => {
    const factor = clamp((t * visitParam) / nEval, 0, 1);
    return initialTemp * (1 - factor);
  };
}

function makeLogCoolingSchedule(visitParam: number, initialTemp: number): CoolingSchedule {
  return (t: number) => {
    const a = Math.log(visitParam * t + Math.E);
    const temp = initialTemp / a;
    return temp < 0 ? 0 : temp;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
