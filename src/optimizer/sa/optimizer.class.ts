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
import { appendFileSync, existsSync, rmSync } from "fs";
import { Measuresuite } from "measuresuite";
import { join, resolve as pathResolve } from "path";

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
  shouldProof,
  writeString,
} from "@/helper";
import globals from "@/helper/globals";
import Logger from "@/helper/Logger.class";
import { Model } from "@/model";
import { Paul, sha1Hash } from "@/paul";
import { RegisterAllocator } from "@/registerAllocator";
import { Optimizer } from "@/optimizer/optimizerFactory";
import type { AnalyseResult, OptimizerArgs } from "@/types";

import { genStatistics, genStatusLine, logMutation, printStartInfo } from "../optimizer.helper";
import { init } from "../optimizer.helper.class";
import { tmpdir } from "os";

let choice: CHOICE;

export class SAOptimizer implements Optimizer {
  private measuresuite: Measuresuite;
  private libcheckfunctionDirectory: string; // aka. /tmp/CryptOpt.cache/yolo123
  private symbolname: string;

  private initialTemperature: number;
  private acceptCriteria: AcceptCriteria;
  private coolingSchedule: CoolingSchedule;
  private visitingDistribution: VisitingDistribution;
  private reannealCriteria: ReannealCriteria;

  public getSymbolname(deleteCache = false): string {
    if (deleteCache) {
      this.cleanLibcheckfunctions();
    }
    return this.symbolname;
  }

  public constructor(private args: OptimizerArgs) {
    Paul.seed = args.seed;

    const randomString = sha1Hash(Math.ceil(Date.now() * Math.random())).toString(36);
    const cacheDir = args.cacheDir ?? tmpdir();
    this.libcheckfunctionDirectory = join(cacheDir, "CryptOpt.cache", randomString);

    const { measuresuite, symbolname } = init(this.libcheckfunctionDirectory, args);

    this.measuresuite = measuresuite;
    this.symbolname = symbolname;

    globals.convergence = [];
    globals.mutationLog = [
      "evaluation,choice,kept,stepSize,PdetailsBackForwardChosenstepsWaled,DdetailsKindNumhotNumall",
    ];
    // load a saved state if necessary
    if (args.readState) {
      Model.import(args.readState);
    }
    RegisterAllocator.options = args;

    // Set SA algorithm args
    this.initialTemperature = this.args.saInitialTemperature;

    switch (this.args.saCoolingSchedule) {
      case "lin":
        this.coolingSchedule = makeLinCoolingSchedule(this.initialTemperature, this.args.saCoolingParam);
        break;
      case "exp":
        this.coolingSchedule = makeExpCoolingSchedule(this.initialTemperature, this.args.saCoolingParam);
        break;
      case "log":
        this.coolingSchedule = makeLogCoolingSchedule(this.initialTemperature, this.args.saCoolingParam);
        break;
      case "geo":
        this.coolingSchedule = makeGeoCoolingSchedule(
          this.initialTemperature,
          this.args.saCoolingParam,
          this.args.saGeoCoolingRate,
        );
        break;
      default:
        throw new Error(`unknown cooling schedule: ${this.args.saCoolingSchedule}`);
    }

    switch (this.args.saVisitingDistribution) {
      case "gaussian":
        this.visitingDistribution = makeGaussianVisitingDistribution(this.args.saStepSizeParam);
        break;
      case "cauchy":
        this.visitingDistribution = makeCauchyVisitingDistribution(this.args.saStepSizeParam);
        break;
      case "uniform":
        this.visitingDistribution = makeUniformVisitingDistribution(this.args.saStepSizeParam);
        break;
      case "const":
        this.visitingDistribution = makeConstVisitingDistribution(this.args.saStepSizeParam);
        break;
      default:
        throw new Error(`unknown visiting distribution: ${this.args.saVisitingDistribution}`);
    }

    switch (this.args.saAcceptCriteria) {
      case "binary":
        this.acceptCriteria = makeBinaryAcceptanceCriteria(this.args.saAcceptParam);
        break;
      case "static":
        this.acceptCriteria = makeStaticAcceptanceCriteria(this.args.saAcceptParam);
        break;
      case "metropolis":
        this.acceptCriteria = makeMetropolisAcceptanceCriteria(this.args.saAcceptParam);
        break;
      default:
        throw new Error(`unknown acceptance criteria : ${this.args.saAcceptCriteria}`);
    }

    switch (this.args.saReannealStrategy) {
      case "none":
        this.reannealCriteria = makeNoOpReannealCriteria();
        break;
      default:
        throw new Error(`unknown reanneal strategy : ${this.args.saReannealStrategy}`);
    }
  }

  private no_of_instructions = -1;

  private numMut: { [id: string]: number } = {
    permutation: 0,
    decision: 0,
  };
  private numRevert: { [id: string]: number } = {
    permutation: 0,
    decision: 0,
  };

  /** you usually don't want to mess with @param random.
   * mutate should not be called from outside with @param random=false*/
  private mutate(random = true): CHOICE {
    if (random) {
      choice = Paul.pick([CHOICE.PERMUTE, CHOICE.DECISION]);
    }
    Logger.log("Mutationalita");
    switch (choice) {
      case CHOICE.PERMUTE: {
        Model.mutatePermutation();
        this.numMut.permutation++;
        break;
      }
      case CHOICE.DECISION: {
        const hasHappend = Model.mutateDecision();
        if (!hasHappend) {
          // this is the case, if there is no hot decisions.
          choice = CHOICE.PERMUTE;
          this.mutate(false);
          return choice;
        }
        this.numMut.decision++;
      }
    }

    return choice;
  }

  private mutateMulti(stepSize: number) {
    let allMuts = { [CHOICE.DECISION]: 0, [CHOICE.PERMUTE]: 0 };
    for (let i = 0; i < stepSize; ++i) {
      const choice = this.mutate();
      allMuts[choice]++;
    }
    return allMuts;
  }

  public optimise() {
    type Candidate = {
      asm: string;
      stacklength: number;
      length: number;
    };

    type SaveState = {
      asm: string;
      cycleCount: number;
      epoch: number;
      ratio: number;
    };

    const CURRENT_FUNCTION = 0 as const;
    const CANDIDATE_FUNCTION = 1 as const;
    const candidates = new Array<Candidate>(2);
    for (let i = 0; i < candidates.length; ++i) {
      candidates[i] = { asm: "", stacklength: -1, length: -1 };
    }

    const assemble = (slot: number) => {
      Logger.log("assembling");
      const assembleResult = assembleASM(this.args.resultDir);
      const code = assembleResult.code;
      const filteredInstructions = strip(code);
      const slotId = slot == CURRENT_FUNCTION ? "A" : "B";
      const asm = (() => {
        switch (this.args.verbose) {
          case true:
            const c = code.join("\n");
            writeString(pathResolve(this.libcheckfunctionDirectory, `current${slotId}.asm`), c);
            return c;
          case false:
            return filteredInstructions.join("\n");
        }
      })();
      candidates[slot].asm = asm;
      candidates[slot].stacklength = assembleResult.stacklength;
      candidates[slot].length = filteredInstructions.length;
    };

    // Initialize best states.
    let bestStateCycle: SaveState = {
      asm: "",
      cycleCount: Infinity,
      epoch: 0,
      ratio: 1,
    };

    let bestStateRatio: SaveState = {
      asm: "",
      cycleCount: Infinity,
      epoch: 0,
      ratio: 0,
    };

    const updateBestState = (asm: string, cycleCount: number, epoch: number, ratio: number) => {
      if (cycleCount <= bestStateCycle.cycleCount) {
        bestStateCycle.asm = asm;
        bestStateCycle.cycleCount = cycleCount;
        bestStateCycle.epoch = epoch;
        bestStateCycle.ratio = ratio;
        return true;
      }
      if (ratio >= bestStateRatio.ratio) {
        bestStateRatio.asm = asm;
        bestStateRatio.cycleCount = cycleCount;
        bestStateRatio.epoch = epoch;
        bestStateRatio.ratio = ratio;
        return true;
      }
      return false;
    };

    const sampleNeighbor = (slot: number, stepSize: number) => {
      const nMuts = this.mutateMulti(stepSize);
      assemble(slot);
      return nMuts;
    };

    return new Promise<number>((resolve) => {
      Logger.log("starting sa optimisation");
      printStartInfo({
        ...this.args,
        symbolname: this.symbolname,
        counter: this.measuresuite.timer,
      });
      let batchSize = 200;
      const numBatches = 31;
      let ratioString = "";
      let numEvals = 0;
      let temperatureIndex = 0;

      const optimistaionStartDate = Date.now();
      let accumulatedTimeSpentByMeasuring = 0;

      let time = Date.now();
      let show_per_second = "many/s";
      let per_second_counter = 0;

      // Before running the optimization loop, assemble the baseline program (at this point, no mutations have taken place).
      {
        assemble(CURRENT_FUNCTION);
        const { asm, stacklength, length } = candidates[CURRENT_FUNCTION];
        // Check for errors, if nothing happens here we are probably fine for the rest of the run.
        if (asm === "" || stacklength === -1 || length === -1 || asm.includes("undefined"))
          errorOut({ msg: "ASM string empty/undefined, big yikes", exitCode: 1 });
        this.no_of_instructions = length;
        // Best state is initally set to initial state.
        bestStateCycle.asm = asm;
        bestStateRatio.asm = asm;
      }

      // Actual optimization loop starts here.
      const intervalHandle = setInterval(() => {
        Logger.log(`sa: new round ${numEvals}`);
        let temperature = this.coolingSchedule(temperatureIndex);
        if (Math.sign(temperature) < 0) errorOut({ exitCode: 123, msg: "negative temperature" });

        // Always save current state before sampling.
        Model.saveSnaphot(CURRENT_FUNCTION.toString());
        // Current model state is now mutated variant.

        const stepSize = this.visitingDistribution(temperature);
        Logger.log(`sa: temperature ${temperature} step size ${stepSize}`);
        const nMuts = sampleNeighbor(CANDIDATE_FUNCTION, stepSize);

        const now_measure = Date.now();

        let analyseResult: AnalyseResult | undefined;
        try {
          Logger.log("let the measurements begin!");
          // here we need the barriers
          const results = this.measuresuite.measure(batchSize, numBatches, [
            candidates[CURRENT_FUNCTION].asm,
            candidates[CANDIDATE_FUNCTION].asm,
          ]);
          Logger.log("well done guys. The results are in!");

          accumulatedTimeSpentByMeasuring += Date.now() - now_measure;

          analyseResult = analyseMeasureResult(results, { batchSize, resultDir: this.args.resultDir });

          //TODO increase numBatches, if the times have a big stddeviation
          //TODO change batchSize if the avg number is batchSize *= avg(times)/goal ; goal=10000 cycles
        } catch (e) {
          const isIncorrect = e instanceof Error && e.message.includes("tested_incorrect");
          const isInvalid = e instanceof Error && e.message.includes("could not be assembled");
          if (isInvalid || isIncorrect) {
            writeString(
              join(this.args.resultDir, "tested_incorrect_A.asm"),
              candidates[CURRENT_FUNCTION].asm,
            );
            writeString(
              join(this.args.resultDir, "tested_incorrect_B.asm"),
              candidates[CANDIDATE_FUNCTION].asm,
            );
            writeString(
              join(this.args.resultDir, "tested_incorrect.json"),
              JSON.stringify({
                nodes: Model.nodesInTopologicalOrder,
              }),
            );
          }

          if (isIncorrect) {
            errorOut(ERRORS.measureIncorrect);
          }
          if (isInvalid) {
            errorOut(ERRORS.measureInvalid);
          }
          writeString(join(this.args.resultDir, "generic_error_A.asm"), candidates[CURRENT_FUNCTION].asm);
          writeString(join(this.args.resultDir, "generic_error_B.asm"), candidates[CANDIDATE_FUNCTION].asm);
          errorOut(ERRORS.measureGeneric);
        }

        const [meanrawCurrent, meanrawCandidate, meanrawCheck] = analyseResult.rawMedian;

        batchSize = Math.ceil((Number(this.args.cyclegoal) / meanrawCheck) * batchSize);
        // We want to limit for some corner cases.
        batchSize = Math.min(batchSize, 10000);
        batchSize = Math.max(batchSize, 5);
        let kept: boolean;
        let wasBest: boolean;
        const shouldAccept = this.acceptCriteria(meanrawCurrent, meanrawCandidate, temperature);
        if (shouldAccept) {
          // After mutation, model state is currently already the mutated variant. In that case, there is nothing to do except set the current solution's ASM to the candidate.
          // No need to save snapshot to "current" as we will do that first thing in the next round.
          Logger.log("kept mutation");
          kept = true;
          candidates[CURRENT_FUNCTION].asm = candidates[CANDIDATE_FUNCTION].asm;
          candidates[CURRENT_FUNCTION].stacklength = candidates[CANDIDATE_FUNCTION].stacklength;
          candidates[CURRENT_FUNCTION].length = candidates[CANDIDATE_FUNCTION].length;
          this.no_of_instructions = candidates[CANDIDATE_FUNCTION].length;
          wasBest = updateBestState(
            candidates[CURRENT_FUNCTION].asm,
            meanrawCandidate,
            numEvals,
            meanrawCheck / meanrawCandidate,
          );
        } else {
          // revert
          kept = false;
          // Pop back to previous model state.
          Model.restoreSnapshot(CURRENT_FUNCTION.toString());
          this.numRevert.permutation += nMuts[CHOICE.PERMUTE];
          this.numRevert.decision += nMuts[CHOICE.DECISION];
        }
        const indexGood = kept ? CANDIDATE_FUNCTION : CURRENT_FUNCTION;
        const indexBad = kept ? CURRENT_FUNCTION : CANDIDATE_FUNCTION;
        globals.currentRatio = meanrawCheck / Math.min(meanrawCandidate, meanrawCurrent);
        const stacklength = candidates[indexGood].stacklength;

        const goodChunks = analyseResult.chunks[indexGood];
        const badChunks = analyseResult.chunks[indexBad];

        ratioString = globals.currentRatio /*aka: new ratio*/
          .toFixed(4);

        per_second_counter++;
        if (Date.now() - time > 1000) {
          time = Date.now();
          show_per_second = (per_second_counter + "/s").padStart(6);
          per_second_counter = 0;
        }

        logMutation({ choice, kept, numEvals, stepSize });
        if (numEvals % PRINT_EVERY == 0) {
          // print every 10th eval
          // a line every 5% (also to logfile) also write the asm when
          const writeout = numEvals % (this.args.evals / LOG_EVERY) === 0;

          const statusline = genStatusLine({
            ...this.args,
            analyseResult,
            logComment: this.args.logComment + ` temp=${temperature.toFixed(2)}`,
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

        // Increase  Number of evaluations taken.
        numEvals++;
        // Also the temperature index
        temperatureIndex++;

        const shouldReanneal = this.reannealCriteria();
        if (shouldReanneal) {
          // Do nothing for now.
        }

        if (numEvals >= this.args.evals) {
          // DONE WITH OPTIMISING WRITE EVERYTHING TO DISK AND EXIT.
          globals.time.generateCryptopt = (Date.now() - optimistaionStartDate) / 1000 - globals.time.validate;
          clearInterval(intervalHandle);

          Logger.log("writing current asm");
          const elapsed = Date.now() - optimistaionStartDate;
          const paddedSeed = padSeed(Paul.initialSeed);

          const statistics = genStatistics({
            paddedSeed,
            ratioString,
            evals: this.args.evals,
            elapsed,
            batchSize,
            numBatches,
            acc: accumulatedTimeSpentByMeasuring,
            numRevert: this.numRevert,
            numMut: this.numMut,
            counter: this.measuresuite.timer,
            framePointer: this.args.framePointer,
            memoryConstraints: this.args.memoryConstraints,
            cyclegoal: this.args.cyclegoal,
          });
          Logger.log(statistics);

          const [asmFile, asmFileBestCycle, asmFileBestRatio, mutationsCsvFile] = generateResultFilename(
            { ...this.args, symbolname: this.symbolname },
            [
              `_ratio${ratioString.replace(".", "")}.asm`,
              `_ratio${bestStateCycle.ratio.toFixed(4).replace(".", "")}_epoch${bestStateCycle.epoch}_best-cycle.asm`,
              `_ratio${bestStateRatio.ratio.toFixed(4).replace(".", "")}_epoch${bestStateRatio.epoch}_best-ratio.asm`,
              `.csv`,
            ],
          );

          // write best found solutions with headers

          writeString(
            asmFile,
            ["SECTION .text", `\tGLOBAL ${this.symbolname}`, `${this.symbolname}:`]
              .concat(candidates[CURRENT_FUNCTION].asm)
              .concat(statistics)
              .join("\n"),
          );

          writeString(
            asmFileBestCycle,
            ["SECTION .text", `\tGLOBAL ${this.symbolname}`, `${this.symbolname}:`]
              .concat(bestStateCycle.asm)
              .concat(statistics)
              .join("\n"),
          );

          writeString(
            asmFileBestRatio,
            ["SECTION .text", `\tGLOBAL ${this.symbolname}`, `${this.symbolname}:`]
              .concat(bestStateRatio.asm)
              .concat(statistics)
              .join("\n"),
          );

          // writing the CSV
          writeString(mutationsCsvFile, globals.mutationLog.join("\n"));

          if (shouldProof(this.args)) {
            // and proof correct
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
          Logger.log("done with that current price of assembly code.");
          this.cleanLibcheckfunctions();
          const v = this.measuresuite.destroy();
          Logger.log(`Wonderful. Done with my work. Destroyed measuresuite (${v}). Time for lunch.`);

          resolve(0);
        }
      }, 0);
    });
  }

  private cleanLibcheckfunctions() {
    if (existsSync(this.libcheckfunctionDirectory)) {
      try {
        Logger.log(`Removing lib check functions in '${this.libcheckfunctionDirectory}'`);
        rmSync(this.libcheckfunctionDirectory, { recursive: true });
        Logger.log(`removed ${this.libcheckfunctionDirectory}`);
      } catch (e) {
        console.error(e);
        throw e;
      }
    }
  }
}

type CoolingSchedule = (n: number) => number;

function makeExpCoolingSchedule(initialTemp: number, _: number): CoolingSchedule {
  const visitParam = 1.8;
  const a = visitParam - 1;
  const t1 = Math.expm1(a * Math.log(2.0)); // 2^a - 1
  return (t: number) => {
    const s = t + 2.0;
    const t2 = Math.expm1(a * Math.log(s)); // (t+2)^a - 1
    return (initialTemp * t1) / t2;
  };
}

function makeLinCoolingSchedule(initialTemp: number, coolingParam: number): CoolingSchedule {
  return (step: number) => {
    const scaledStep = step / coolingParam;
    return initialTemp / (1 + scaledStep);
  };
}

function makeLogCoolingSchedule(initialTemp: number, coolingParam: number): CoolingSchedule {
  return (step: number) => {
    const scaledStep = step / coolingParam;
    const a = Math.log(scaledStep + Math.E);
    const b = initialTemp / a;
    return b;
  };
}

function makeGeoCoolingSchedule(initialTemp: number, coolingParam: number, alpha: number): CoolingSchedule {
  if (!(alpha > 0 && alpha < 1)) throw new Error("invalid alpha");
  return (step: number) => {
    const scaledStep = step / coolingParam;
    const a = Math.pow(alpha, scaledStep);
    return initialTemp * a;
  };
}

type VisitingDistribution = (temperature: number) => number;

function makeConstVisitingDistribution(stepSizeParam: number): VisitingDistribution {
  return (_: number) => 1 + Math.round(stepSizeParam);
}

function makeUniformVisitingDistribution(stepSizeParam: number): VisitingDistribution {
  return (temperature: number) => {
    const lo = 1;
    const hi = Math.max(1, Math.round(stepSizeParam * temperature));
    // Paul.chooseBetween picks x from lo <= x < hi. Add 1 so we get uniform from [lo, hi].
    return Paul.chooseBetween(lo, hi + 1);
  };
}

function makeGaussianVisitingDistribution(stepSizeParam: number): VisitingDistribution {
  return (temperature: number) => {
    let n = Paul.sampleGaussian(0, stepSizeParam * temperature); // Sample from normal distribution centered at 0 with scale controlled by step size.
    n = Math.abs(n); // Make positive.
    n = Math.round(n); // Round to nearest integer (we can only take discrete mutation step sizes).
    n = 1 + n;
    return n;
  };
}

function makeCauchyVisitingDistribution(stepSizeParam: number): VisitingDistribution {
  return (temperature: number) => {
    let n = Paul.sampleCauchy(0, stepSizeParam * temperature); // Sample from cauchy distribution centered at 0 with scale controlled by step size.
    n = Math.abs(n); // Make positive.
    n = Math.round(n); // Round to nearest integer (we can only take discrete mutation step sizes).
    n = 1 + n; // Ensure at least one step.
    return n;
  };
}

type AcceptCriteria = (energyCurrent: number, energyVisit: number, temperature: number) => boolean;

function makeBinaryAcceptanceCriteria(_: number): AcceptCriteria {
  return (energyCurrent: number, energyVisit: number, _: number) => {
    Logger.log(
      `sa: current energy ${energyCurrent} visit energy ${energyVisit} ratio ${energyVisit / energyCurrent} diff ${energyVisit - energyCurrent}`,
    );
    return energyVisit <= energyCurrent;
  };
}

function makeStaticAcceptanceCriteria(acceptParam: number): AcceptCriteria {
  return (energyCurrent: number, energyVisit: number, _: number) => {
    if (energyVisit <= energyCurrent) {
      return true;
    }
    const u = Paul.uniform();
    return u < acceptParam;
  };
}

// Metropolis-hastings criteria.
function makeMetropolisAcceptanceCriteria(acceptParam: number): AcceptCriteria {
  return (energyCurrent: number, energyVisit: number, temperature: number) => {
    if (energyVisit <= energyCurrent) {
      return true;
    }
    const energyDelta = (energyVisit - energyCurrent) / acceptParam;
    const pr = Math.min(1, Math.exp(-energyDelta / temperature));
    Logger.log(
      `sa: current energy ${energyCurrent} visit energy ${energyVisit} ratio ${energyVisit / energyCurrent} diff ${energyDelta} accepting with prob ${pr}`,
    );
    const u = Paul.uniform();
    return u <= pr;
  };
}

type ReannealCriteria = () => boolean;

function makeNoOpReannealCriteria(): ReannealCriteria {
  return () => false;
}
