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

import { execSync } from "child_process";
import { appendFileSync } from "fs";
import { resolve as pathResolve } from "path";

import { assemble } from "@/assembler";
import { FiatBridge } from "@/bridge/fiat-bridge";
import { CHOICE, FUNCTIONS } from "@/enums";
import { errorOut, ERRORS } from "@/errors";
import {
  analyseMeasureResult,
  generateResultFilename,
  LOG_EVERY,
  padSeed,
  PRINT_EVERY,
  shouldProof,
  toggleFUNCTIONS,
  writeString,
} from "@/helper";
import globals from "@/helper/globals";
import { FileLogger, Logger } from "@/helper/Logger.class";
import type { AnalyseResult, OptimizerArgs } from "@/types";

import { genStatistics, genStatusLine, logMutation, printStartInfo } from "../util";
import { Optimizer, OptimizerResult } from "@/optimizer";
import { Paul } from "@/paul";

type Arm = {
  totalReward: number;
  pulls: number;
};

export class BiasedOptimizer extends Optimizer {
  private ucbFactor: number;
  public constructor(args: OptimizerArgs) {
    super(args);
    this.ucbFactor = this.args.biasedUcbFactor;
  }

  private selectArm(arms: Record<CHOICE, Arm>): CHOICE {
    const t = arms[CHOICE.PERMUTE].pulls + arms[CHOICE.DECISION].pulls; // Total number of pulls.

    const ucb = (arm: Arm): number => {
      if (arm.pulls === 0) return Infinity;
      return Math.sqrt((2 * Math.log(t)) / arm.pulls);
    };

    const score = (arm: Arm) => {
      const avgScore = arm.totalReward / t;
      return avgScore + this.ucbFactor * ucb(arm);
    };

    const scorePermute = score(arms[CHOICE.PERMUTE]);
    const scoreDecision = score(arms[CHOICE.DECISION]);

    FileLogger.log(
      `armPerm=${JSON.stringify(arms[CHOICE.PERMUTE])} armDecision=${JSON.stringify(arms[CHOICE.DECISION])}`,
    );
    FileLogger.log(`scorePerm=${scorePermute} scoreDecision=${scoreDecision}`);

    return scorePermute >= scoreDecision ? CHOICE.PERMUTE : CHOICE.DECISION;
  }

  public optimise() {
    return new Promise<OptimizerResult>((resolve) => {
      Logger.log("starting biased (UCB1 bandit) optimisation");
      printStartInfo({
        ...this.args,
        symbolname: this.symbolname,
        counter: this.measuresuite.timer,
      });

      let batchSize = 200;
      const numBatches = 31;
      let ratioString = "";
      let numEvals = 0;

      const optimisationStartDate = Date.now();
      let accumulatedTimeSpentByMeasuring = 0;

      let currentNameOfTheFunctionThatHasTheMutation = FUNCTIONS.F_A;
      let time = Date.now();
      let show_per_second = "many/s";
      let per_second_counter = 0;

      let currentAcceptStreak = 0;
      let currentRejectStreak = 0;

      // UCB1 bandit state — one arm per mutation type.
      // Initialise with one virtual pull each so UCB1 is well-defined from epoch 1.
      const arms: Record<CHOICE, Arm> = {
        [CHOICE.PERMUTE]: { totalReward: 0, pulls: 1 },
        [CHOICE.DECISION]: { totalReward: 0, pulls: 1 },
      };

      const intervalHandle = setInterval(() => {
        const currentEpoch = numEvals;
        let wasNewCandidate = false;

        if (numEvals > 0) {
          // Select arm via UCB1, then mutate.
          this.choice = this.selectArm(arms);
          this.mutate({ random: false, updateStats: true });
        }

        Logger.log("assembling");
        const { code, stacklength } = assemble(this.args.resultDir);

        Logger.log("now we have the current string in the object, filtering");
        const filteredInstructions = code.filter((line) => line && !line.startsWith(";") && line !== "\n");
        this.no_of_instructions = filteredInstructions.length;

        if (this.args.verbose) {
          const c = code.join("\n");
          writeString(pathResolve(this.libcheckfunctionDirectory, "current.asm"), c);
          wasNewCandidate = this.addToSeen(c);
          this.asmStrings[currentNameOfTheFunctionThatHasTheMutation] = c;
        } else {
          const c = filteredInstructions.join("\n");
          wasNewCandidate = this.addToSeen(c);
          this.asmStrings[currentNameOfTheFunctionThatHasTheMutation] = c;
        }

        if (numEvals == 0) {
          // First round: assemble baseline into F_A, then point to F_B.
          if (this.asmStrings[FUNCTIONS.F_A].includes("undefined")) {
            const p = pathResolve(this.libcheckfunctionDirectory, "with_undefined.asm");
            writeString(p, this.asmStrings[FUNCTIONS.F_A]);
            const e = `\n\n\nNah... we dont want undefined; wrote ${p}, plx fix. \n\n\n`;
            console.error(e);
            throw new Error(e);
          }
          currentNameOfTheFunctionThatHasTheMutation = FUNCTIONS.F_B;
          numEvals++;
        } else {
          // Subsequent rounds: measure and decide.
          let analyseResult: AnalyseResult | undefined;
          try {
            Logger.log("let the measurements begin!");
            if (this.args.verbose) {
              writeString(
                pathResolve(this.libcheckfunctionDirectory, "currentA.asm"),
                this.asmStrings[FUNCTIONS.F_A],
              );
              writeString(
                pathResolve(this.libcheckfunctionDirectory, "currentB.asm"),
                this.asmStrings[FUNCTIONS.F_B],
              );
            }
            const now_measure = Date.now();
            const results = this.measuresuite.measure(batchSize, numBatches, [
              this.asmStrings[FUNCTIONS.F_A],
              this.asmStrings[FUNCTIONS.F_B],
            ]);
            accumulatedTimeSpentByMeasuring += Date.now() - now_measure;
            Logger.log("well done guys. The results are in!");

            analyseResult = analyseMeasureResult(results, { batchSize, resultDir: this.args.resultDir });
          } catch (e) {
            this.handleMeasurementError(e);
          }

          const [meanrawA, meanrawB, meanrawCheck] = analyseResult!.rawMedian;

          batchSize = Math.ceil((Number(this.args.cyclegoal) / meanrawCheck) * batchSize);
          batchSize = Math.min(batchSize, 10000);
          batchSize = Math.max(batchSize, 5);

          const currentFunctionIsA = () => currentNameOfTheFunctionThatHasTheMutation === FUNCTIONS.F_A;

          Logger.log(currentFunctionIsA() ? "New".padEnd(10) : "New".padStart(10));

          let kept: boolean;

          if (
            (meanrawA <= meanrawB && currentFunctionIsA()) ||
            (meanrawA >= meanrawB && !currentFunctionIsA())
          ) {
            Logger.log("kept    mutation");
            kept = true;

            this.mutationStats.numAcceptedEvals++;
            currentRejectStreak = 0;
            currentAcceptStreak++;
            this.mutationStats.maxAcceptStreak = Math.max(
              this.mutationStats.maxAcceptStreak,
              currentAcceptStreak,
            );

            currentNameOfTheFunctionThatHasTheMutation = toggleFUNCTIONS(
              currentNameOfTheFunctionThatHasTheMutation,
            );
          } else {
            kept = false;

            this.mutationStats.numRejectedEvals++;
            currentAcceptStreak = 0;
            currentRejectStreak++;
            this.mutationStats.maxRejectStreak = Math.max(
              this.mutationStats.maxRejectStreak,
              currentRejectStreak,
            );
            this.revertFunction();
          }

          const indexGood = Number(meanrawA > meanrawB);
          const indexBad = 1 - indexGood;
          const minRaw = Math.min(meanrawB, meanrawA);
          const currentRatio = meanrawCheck / minRaw;
          const currentCycleCount = analyseResult!.batchSizeScaledrawMedian[indexGood];
          const goodChunks = analyseResult!.chunks[indexGood];
          const badChunks = analyseResult!.chunks[indexBad];

          // Update arms (favor if also kept, but still give non-zero reward if shown improvement). TODO: figit with these factors.
          {
            let reward = 0;
            const improvement = (currentRatio - globals.currentRatio) / globals.currentRatio;
            if (kept && improvement > 0) {
              reward = improvement * 4;
            } else if (improvement > 0) {
              reward = improvement * 2;
            }
            arms[this.choice].pulls++;
            arms[this.choice].totalReward += reward;
          }

          globals.currentRatio = currentRatio;
          // --- end bandit update ---

          // Update globals w.r.t best ratios/cycle counts.
          {
            if (currentRatio > globals.bestEpochByRatio.ratio) {
              globals.bestEpochByRatio.epoch = currentEpoch;
              globals.bestEpochByRatio.nEvals = numEvals;
              globals.bestEpochByRatio.ratio = currentRatio;
              globals.bestEpochByRatio.cycleCount = currentCycleCount;
            }

            if (currentCycleCount < globals.bestEpochByCycle.cycleCount) {
              globals.bestEpochByCycle.result = analyseResult!;
              globals.bestEpochByCycle.indexGood = indexGood;
              globals.bestEpochByCycle.epoch = currentEpoch;
              globals.bestEpochByCycle.ratio = currentRatio;
              globals.bestEpochByCycle.nEvals = numEvals;
              globals.bestEpochByCycle.cycleCount = currentCycleCount;
            }
          }

          ratioString = globals.currentRatio.toFixed(4);

          per_second_counter++;
          if (Date.now() - time > 1000) {
            time = Date.now();
            show_per_second = (per_second_counter + "/s").padStart(6);
            per_second_counter = 0;
          }

          const choice = this.choice;
          logMutation({ choice, kept, wasNewCandidate, numEvals, epoch: currentEpoch, ratio: currentRatio });

          if (numEvals % PRINT_EVERY == 0) {
            const writeout = numEvals % (this.args.evals / LOG_EVERY) === 0;

            const statusline = genStatusLine({
              ...this.args,
              analyseResult: analyseResult!,
              badChunks,
              batchSize,
              choice,
              goodChunks,
              indexBad,
              indexGood,
              kept,
              no_of_instructions: this.no_of_instructions,
              numEvals,
              ratioString,
              show_per_second,
              stacklength,
              symbolname: this.symbolname,
              writeout,
            });
            process.stdout.write(statusline);
            globals.convergence.push(ratioString);
          }

          numEvals++;

          if (numEvals >= this.args.evals) {
            // Done. Write results.
            globals.time.generateCryptopt =
              (Date.now() - optimisationStartDate) / 1000 - globals.time.validate;
            clearInterval(intervalHandle);

            Logger.log("writing current asm");
            const elapsed = Date.now() - optimisationStartDate;
            const paddedSeed = padSeed(Paul.initialSeed);

            const statistics = genStatistics({
              paddedSeed,
              ratioString,
              evals: this.args.evals,
              elapsed,
              batchSize,
              numBatches,
              acc: accumulatedTimeSpentByMeasuring,
              numRevert: this.mutationStats.numRevert,
              numMut: this.mutationStats.numMut,
              counter: this.measuresuite.timer,
              framePointer: this.args.framePointer,
              memoryConstraints: this.args.memoryConstraints,
              cyclegoal: this.args.cyclegoal,
            });
            Logger.log(statistics);

            const [asmFile, mutationsCsvFile] = generateResultFilename(
              { ...this.args, symbolname: this.symbolname },
              [`_ratio${ratioString.replace(".", "")}.asm`, `.csv`],
            );

            // Write the last accepted solution (not the last mutated).
            const flipped = toggleFUNCTIONS(currentNameOfTheFunctionThatHasTheMutation);

            writeString(
              asmFile,
              ["SECTION .text", `\tGLOBAL ${this.symbolname}`, `${this.symbolname}:`]
                .concat(this.asmStrings[flipped])
                .concat(statistics)
                .join("\n"),
            );

            writeString(mutationsCsvFile, globals.mutationLog.join("\n"));

            if (shouldProof(this.args)) {
              const proofCmd = FiatBridge.buildProofCommand(this.args.curve, this.args.method, asmFile);
              Logger.log(`proofing that asm correct with '${proofCmd}'`);
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

            Logger.log("done with that current piece of assembly code.");
            this.cleanLibcheckfunctions();
            const v = this.measuresuite.destroy();
            Logger.log(`Wonderful. Done with my work. Destroyed measuresuite (${v}). Time for lunch.`);

            resolve({
              ratio: currentRatio,
              cycleCount: currentCycleCount,
              numEvals,
            });
          }
        }
      }, 0);
    });
  }
}
