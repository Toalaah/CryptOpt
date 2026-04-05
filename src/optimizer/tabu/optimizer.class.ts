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

import { assemble as assembleASM, strip } from "@/assembler";
import { FiatBridge } from "@/bridge/fiat-bridge";
import { CHOICE } from "@/enums";
import { errorOut, ERRORS } from "@/errors";
import {
  analyseMeasureResult,
  generateResultFilename,
  LOG_EVERY,
  padSeed,
  PRINT_EVERY,
  shouldProof as shouldProve,
  writeString,
} from "@/helper";
import globals from "@/helper/globals";
import { Logger } from "@/helper/Logger.class";
import { Model } from "@/model";
import type { OptimizerArgs } from "@/types";

import { genStatistics, genStatusLine, logMutation, printStartInfo } from "../util";
import { Optimizer, OptimizerResult } from "@/optimizer";
import { Paul } from "@/paul";

export class TabuOptimizer extends Optimizer {
  private uniquenessGoal: number;
  public constructor(args: OptimizerArgs) {
    super(args);
    this.uniquenessGoal = this.args.tabuUniqueFactorGoal;
  }

  public optimise() {
    type Candidate = {
      asm: string;
      stacklength: number;
      choice: CHOICE;
      ninst: number;
      mutStats: { numDecision: number; numPerm: number };
    };

    const CURRENT_FUNCTION = 0 as const;
    const CANDIDATE_FUNCTION = 1 as const;
    const candidates = new Array<Candidate>(2);
    const CHECK = 2 as const;

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
    let accumulatedTimeSpentByMeasuring = 0;
    let numEvals = 0;

    let showPerSecond = "many/s";
    let perSecondCounter = 0;

    let currentRejectStreak = 0;
    let currentAcceptStreak = 0;

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
      candidates[slot].ninst = filteredInstructions.length;
      return asm;
    };

    const getCurrentUniqueFactor = () => {
      if (numEvals == 0) return 0;
      const numUnique = this.asmHashes.size;
      return numUnique / numEvals;
    };

    /**
     * Samples a neighbor and saves it into Model snaphshot `slot`. The model snapshot is saved with an `id` of `slot.toString()`. Returns the number of permutations/decisions which were made to sample the neighbor.
     */
    const sampleNeighbor = (slot: number) => {
      let asm = "";
      const currUniqueFactor = getCurrentUniqueFactor();
      if (currUniqueFactor <= this.uniquenessGoal) {
        // Ensure we add unique solution if under current threshold goal.
        while (true) {
          this.mutate({ updateStats: false });
          asm = assemble(slot);
          if (this.isNew(asm).isNew) break;
          else Model.revertLastMutation();
        }
      } else {
        this.mutate({ updateStats: false });
        asm = assemble(slot);
      }
      const wasNew = this.addToSeen(asm);
      Model.saveSnaphot(slot.toString());
      const perm = this.choice == CHOICE.PERMUTE ? 1 : 0;
      const desc = 1 - perm;
      return { perm, desc, wasNew };
    };

    return new Promise<OptimizerResult>((resolve) => {
      const optimistaionStartDate = Date.now();
      let time = Date.now();
      printStartInfo({
        ...this.args,
        symbolname: this.objective.getSymbolname(),
        counter: this.objective.getCounter(),
      });

      // Before running the optimization loop, assemble the baseline program (at this point, no mutations have taken place).
      {
        const asm = assemble(CURRENT_FUNCTION);
        this.addToSeen(asm);
        // Check for errors, if nothing happens here we are probably fine for the rest of the run.
        if (asm.includes("undefined"))
          errorOut({ msg: "ASM string empty/undefined, big yikes", exitCode: 1 });
      }

      const intervalHandle = setInterval(() => {
        let wasNewCandidate = false;
        // Mutation & candidate generation.
        {
          Model.saveSnaphot("current");
          const { perm, desc, wasNew } = sampleNeighbor(CANDIDATE_FUNCTION);
          wasNewCandidate = wasNew;
          candidates[CANDIDATE_FUNCTION].mutStats.numPerm = perm;
          candidates[CANDIDATE_FUNCTION].mutStats.numDecision = desc;
          this.mutationStats.numMut.permutation += perm;
          this.mutationStats.numMut.decision += desc;
          candidates[CANDIDATE_FUNCTION].choice = this.choice;
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

        const batchSize = this.objective.batchSize;
        const numBatches = this.objective.numBatches;

        const meanrawCurrent = analyseResult.rawMedian[CURRENT_FUNCTION];
        const meanrawCandidate = analyseResult.rawMedian[CANDIDATE_FUNCTION];
        const meanrawCheck = analyseResult.rawMedian[CHECK];

        // Decide whether we want to keep mutated candidate.
        let kept: boolean;
        if (meanrawCandidate <= meanrawCurrent) {
          this.mutationStats.numAcceptedEvals++;
          Logger.log("kept mutation");
          kept = true;

          this.mutationStats.numAcceptedEvals++;
          currentRejectStreak = 0;
          currentAcceptStreak++;
          this.mutationStats.maxAcceptStreak = Math.max(
            this.mutationStats.maxAcceptStreak,
            currentAcceptStreak,
          );

          candidates[CURRENT_FUNCTION].asm = candidates[CANDIDATE_FUNCTION].asm;
          candidates[CURRENT_FUNCTION].stacklength = candidates[CANDIDATE_FUNCTION].stacklength;
          candidates[CURRENT_FUNCTION].choice = candidates[CANDIDATE_FUNCTION].choice;
          candidates[CURRENT_FUNCTION].ninst = candidates[CANDIDATE_FUNCTION].ninst;
          this.no_of_instructions = candidates[CANDIDATE_FUNCTION].ninst;
          Model.restoreSnapshot(CANDIDATE_FUNCTION.toString());
        } else {
          kept = false;

          this.mutationStats.numRejectedEvals++;
          currentAcceptStreak = 0;
          currentRejectStreak++;
          this.mutationStats.maxRejectStreak = Math.max(
            this.mutationStats.maxRejectStreak,
            currentRejectStreak,
          );
          this.choice = candidates[CANDIDATE_FUNCTION].choice;
          this.mutationStats.numRevert.permutation += candidates[CANDIDATE_FUNCTION].mutStats.numPerm;
          this.mutationStats.numRevert.decision += candidates[CANDIDATE_FUNCTION].mutStats.numDecision;
        }

        let currentCycleCount: number;
        // Start statistics & status update.
        {
          const indexGood = kept ? CANDIDATE_FUNCTION : CURRENT_FUNCTION;
          const indexBad = kept ? CURRENT_FUNCTION : CANDIDATE_FUNCTION;
          const goodChunks = analyseResult.chunks[indexGood];
          const badChunks = analyseResult.chunks[indexBad];
          const minRaw = Math.min(meanrawCurrent, meanrawCandidate);

          const currentRatio = meanrawCheck / minRaw;
          currentCycleCount = analyseResult.batchSizeScaledrawMedian[indexGood];
          globals.currentRatio = currentRatio;

          // Update globals w.r.t best ratios/cycle counts.
          {
            if (currentRatio > globals.bestEpochByRatio.ratio) {
              // Check if we found new PB this epoch.
              globals.bestEpochByRatio.epoch = numEvals;
              globals.bestEpochByRatio.nEvals = numEvals;
              globals.bestEpochByRatio.ratio = currentRatio;
              globals.bestEpochByRatio.cycleCount = currentCycleCount;
            }

            if (currentCycleCount < globals.bestEpochByCycle.cycleCount) {
              globals.bestEpochByCycle.result = analyseResult;
              globals.bestEpochByCycle.indexGood = indexGood;
              globals.bestEpochByCycle.epoch = numEvals;
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
            epoch: numEvals,
            nDesc: candidates[CANDIDATE_FUNCTION].mutStats.numDecision,
            nPerm: candidates[CANDIDATE_FUNCTION].mutStats.numPerm,
            ratio: currentRatio,
          });

          if (numEvals % PRINT_EVERY == 0) {
            const statusline = genStatusLine({
              ...this.args,
              logComment: this.args.logComment,
              analyseResult,
              badChunks,
              batchSize,
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
              writeout: numEvals % (this.args.evals / LOG_EVERY) === 0,
            });
            process.stdout.write(statusline);
            globals.convergence.push(ratioString);
          }
        } // End statistics

        // Increase  Number of evaluations taken.
        numEvals++;

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

            ratioString = globals.currentRatio.toFixed(4);
            globals.convergence.push(ratioString);

            this.mutationStats.avgMutStepSize =
              (this.mutationStats.numMut.decision + this.mutationStats.numMut.permutation) / numEvals;

            const counter = this.objective.getCounter();
            statistics = genStatistics({
              paddedSeed,
              ratioString,
              evals: this.args.evals,
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
                  .concat(candidates[CURRENT_FUNCTION].asm)
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
            this.objective.cleanup();
            resolve({
              ratio: globals.currentRatio,
              cycleCount: currentCycleCount,
              numEvals: numEvals,
            });
          }
        } // End cleanup
      }, 0);
    });
  }
}
