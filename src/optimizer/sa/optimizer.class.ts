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
import { tmpdir } from "os";
import { join, resolve as pathResolve } from "path";

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
import Logger from "@/helper/Logger.class";
import { Model } from "@/model";
import { Paul, sha1Hash } from "@/paul";
import { RegisterAllocator } from "@/registerAllocator";
import { Optimizer } from "@/optimizer/optimizerFactory";
import type { AnalyseResult, OptimizerArgs } from "@/types";

import { genStatistics, genStatusLine, logMutation, printStartInfo } from "../optimizer.helper";
import { init } from "../optimizer.helper.class";

let choice: CHOICE;

export class SAOptimizer implements Optimizer {
  private measuresuite: Measuresuite;
  private libcheckfunctionDirectory: string; // aka. /tmp/CryptOpt.cache/yolo123
  private symbolname: string;

  private initialTemperature: number;
  private acceptParam: number;
  private coolingSchedule: CoolingSchedule;
  private visitingDistribution: VisitingDistribution;

  public getSymbolname(deleteCache = false): string {
    if (deleteCache) {
      this.cleanLibcheckfunctions();
    }
    return this.symbolname;
  }

  public constructor(private args: OptimizerArgs) {
    Paul.seed = args.seed;

    const randomString = sha1Hash(Math.ceil(Date.now() * Math.random())).toString(36);
    this.libcheckfunctionDirectory = join(tmpdir(), "CryptOpt.cache", randomString);

    const { measuresuite, symbolname } = init(this.libcheckfunctionDirectory, args);

    this.measuresuite = measuresuite;
    this.symbolname = symbolname;

    globals.convergence = [];
    globals.mutationLog = [
      "evaluation,choice,kept,PdetailsBackForwardChosenstepsWaled,DdetailsKindNumhotNumall",
    ];
    // load a saved state if necessary
    if (args.readState) {
      Model.import(args.readState);
    }
    RegisterAllocator.options = args;

    // Set SA algorithm args
    this.initialTemperature = this.args.saInitialTemperature;
    this.acceptParam = this.args.saAcceptParam;
    switch (this.args.saCoolingSchedule) {
      case "lin":
        this.coolingSchedule = makeLinCoolingSchedule(this.initialTemperature);
        break;
      case "log":
        this.coolingSchedule = makeLogCoolingSchedule(this.initialTemperature);
        break;
      case "geo":
        this.coolingSchedule = makeGeoCoolingSchedule(this.initialTemperature, this.args.saGeoCoolingRate);
        break;
      default:
        throw new Error(`unknown cooling schedule: ${this.args.saCoolingSchedule}`);
    }
    switch (this.args.saVisitingDistribution) {
      case "gaussian":
        this.visitingDistribution = makeGaussianVisitingDistribution(this.args.saStepSizeParam);
        break;
      case "cauchy":
        this.visitingDistribution = makeLogCoolingSchedule(this.args.saStepSizeParam);
        break;
      case "boltzmann":
        this.visitingDistribution = makeBoltzmanVisitingDistribution(this.args.saStepSizeParam);
        break;
      default:
        throw new Error(`unknown visiting distribution: ${this.args.saVisitingDistribution}`);
    }
  }

  private no_of_instructions = -1;
  private asmStrings: { [k in FUNCTIONS]: string } = {
    [FUNCTIONS.F_A]: "",
    [FUNCTIONS.F_B]: "",
  };
  private numMut: { [id: string]: number } = {
    permutation: 0,
    decision: 0,
  };
  private numRevert: { [id: string]: number } = {
    permutation: 0,
    decision: 0,
  };

  private revertFunction = (): void => {
    /**intentionally blank */
  };
  /** you usually don't want to mess with @param random.
   * mutate should not be called from outside with @param random=false*/
  private mutate(random = true): void {
    if (random) {
      choice = Paul.pick([CHOICE.PERMUTE, CHOICE.DECISION]);
    }
    Logger.log("Mutationalita");
    switch (choice) {
      case CHOICE.PERMUTE: {
        Model.mutatePermutation();
        this.revertFunction = () => {
          this.numRevert.permutation++;
          Model.revertLastMutation();
        };
        this.numMut.permutation++;
        break;
      }
      case CHOICE.DECISION: {
        const hasHappend = Model.mutateDecision();
        if (!hasHappend) {
          // this is the case, if there is no hot decisions.
          choice = CHOICE.PERMUTE;
          this.mutate(false);
          return;
        }
        this.revertFunction = () => {
          this.numRevert.decision++;
          Model.revertLastMutation();
        };

        this.numMut.decision++;
      }
    }
  }

  public optimise() {
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

      const optimistaionStartDate = Date.now();
      let accumulatedTimeSpentByMeasuring = 0;

      let currentNameOfTheFunctionThatHasTheMutation = FUNCTIONS.F_A;
      let time = Date.now();
      let show_per_second = "many/s";
      let per_second_counter = 0;

      // Actual optimization loop starts here.
      const intervalHandle = setInterval(() => {
        let temperature = this.coolingSchedule(numEvals);
        if (temperature < 0) errorOut({ exitCode: 123, msg: "temperature < 0" });

        if (numEvals > 0) {
          // not first eval, thus we want to mutate.
          this.mutate();
        }

        Logger.log("assembling");
        const { code, stacklength } = assemble(this.args.resultDir);

        Logger.log("now we have the current string in the object, filtering");
        const filteredInstructions = code.filter((line) => line && !line.startsWith(";") && line !== "\n");
        this.no_of_instructions = filteredInstructions.length;

        // and depening on the silent-opt use filtered or the verbose ones for the string
        if (this.args.verbose) {
          const c = code.join("\n");
          writeString(pathResolve(this.libcheckfunctionDirectory, "current.asm"), c);
          this.asmStrings[currentNameOfTheFunctionThatHasTheMutation] = c;
        } else {
          this.asmStrings[currentNameOfTheFunctionThatHasTheMutation] = filteredInstructions.join("\n");
        }

        // check if this was the first round
        if (numEvals == 0) {
          // then point to fB and continue, write first
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
          //else, it was not the first round, we need to measure

          const now_measure = Date.now();

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
            // here we need the barriers
            const results = this.measuresuite.measure(batchSize, numBatches, [
              this.asmStrings[FUNCTIONS.F_A],
              this.asmStrings[FUNCTIONS.F_B],
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
                this.asmStrings[FUNCTIONS.F_A],
              );
              writeString(
                join(this.args.resultDir, "tested_incorrect_B.asm"),
                this.asmStrings[FUNCTIONS.F_B],
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
            writeString(join(this.args.resultDir, "generic_error_A.asm"), this.asmStrings[FUNCTIONS.F_A]);
            writeString(join(this.args.resultDir, "generic_error_B.asm"), this.asmStrings[FUNCTIONS.F_B]);
            errorOut(ERRORS.measureGeneric);
          }

          const [meanrawA, meanrawB, meanrawCheck] = analyseResult.rawMedian;

          batchSize = Math.ceil((Number(this.args.cyclegoal) / meanrawCheck) * batchSize);
          // We want to limit for some corner cases.
          batchSize = Math.min(batchSize, 10000);
          batchSize = Math.max(batchSize, 5);

          const currentFunctionIsA = () => currentNameOfTheFunctionThatHasTheMutation === FUNCTIONS.F_A;

          Logger.log(currentFunctionIsA() ? "New".padEnd(10) : "New".padStart(10));

          let kept: boolean;

          if (
            // A is not worse and A is new
            (meanrawA <= meanrawB && currentFunctionIsA()) ||
            // or B is not worse and B is new
            (meanrawA >= meanrawB && !currentFunctionIsA())
          ) {
            Logger.log("kept    mutation");
            kept = true;
            currentNameOfTheFunctionThatHasTheMutation = toggleFUNCTIONS(
              currentNameOfTheFunctionThatHasTheMutation,
            );
          } else {
            // revert
            kept = false;
            this.revertFunction();
          }
          const indexGood = Number(meanrawA > meanrawB);
          const indexBad = 1 - indexGood;
          globals.currentRatio = meanrawCheck / Math.min(meanrawB, meanrawA);

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

          logMutation({ choice, kept, numEvals });
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

          if (numEvals >= this.args.evals) {
            // DONE WITH OPTIMISING WRITE EVERYTHING TO DISK AND EXIT.
            globals.time.generateCryptopt =
              (Date.now() - optimistaionStartDate) / 1000 - globals.time.validate;
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

            const [asmFile, mutationsCsvFile] = generateResultFilename(
              { ...this.args, symbolname: this.symbolname },
              [`_ratio${ratioString.replace(".", "")}.asm`, `.csv`],
            );

            // write best found solution with headers
            // flip, because we want the last accepted, not the last mutated.
            const flipped = toggleFUNCTIONS(currentNameOfTheFunctionThatHasTheMutation);

            writeString(
              asmFile,
              ["SECTION .text", `\tGLOBAL ${this.symbolname}`, `${this.symbolname}:`]
                .concat(this.asmStrings[flipped])
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
        }
      }, 0);
    });
  }

  // Metropolis-Hastings.
  private shouldAccept(currentEnergy: number, visitEnergy: number, temperature: number) {
    if (visitEnergy <= currentEnergy) {
      return true;
    }
    const energyDelta = visitEnergy - currentEnergy;
    const pr = Math.min(1, Math.exp(energyDelta / temperature));
    const u = Paul.uniform();
    return u < pr;
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

function makeExpCoolingSchedule(visitParam: number, initialTemp: number): CoolingSchedule {
  const a = visitParam - 1;
  const t1 = Math.expm1(a * Math.log(2.0)); // 2^a - 1
  return (t: number) => {
    const s = t + 2.0;
    const t2 = Math.expm1(a * Math.log(s)); // (t+2)^a - 1
    return (initialTemp * t1) / t2;
  };
}

function makeLinCoolingSchedule(initialTemp: number): CoolingSchedule {
  return (step: number) => {
    return initialTemp / (1 + step);
  };
}

function makeLogCoolingSchedule(initialTemp: number): CoolingSchedule {
  return (step: number) => {
    const a = Math.log(step + 1);
    const b = initialTemp / a;
    return b;
  };
}

function makeGeoCoolingSchedule(initialTemp: number, alpha: number): CoolingSchedule {
  if (!(alpha > 0 && alpha < 1)) throw new Error("invalid alpha");
  return (step: number) => {
    const a = Math.pow(alpha, step);
    return initialTemp * a;
  };
}

type VisitingDistribution = (temperature: number) => number;

function makeGaussianVisitingDistribution(stepSizeParam: number): VisitingDistribution {
  return (temperature: number) => {
    let n = Paul.sampleGaussian(0, stepSizeParam); // Sample from normal distribution centered at 0 with scale controlled by step size.
    n = Math.abs(n); // Make positive.
    n = Math.round(n); // Round to nearest integer (we can only take discrete mutation step sizes).
    n = Math.min(1, n); // Ensure at least one step.
    return n;
  };
}

function makeCauchyVisitingDistribution(stepSizeParam: number): VisitingDistribution {
  return (temperature: number) => {
    let n = Paul.sampleCauchy(0, stepSizeParam); // Sample from cauchy distribution centered at 0 with scale controlled by step size.
    n = Math.abs(n); // Make positive.
    n = Math.round(n); // Round to nearest integer (we can only take discrete mutation step sizes).
    n = Math.min(1, n); // Ensure at least one step.
    return n;
  };
}

function makeBoltzmanVisitingDistribution(stepSizeParam: number): VisitingDistribution {
  return (temperature: number) => {
    const scale = stepSizeParam * Math.sqrt(Math.max(temperature, 1e-12)); // Dynamic scale dependent on temperature.
    let n = Paul.sampleGaussian(0, scale); // Sample from normal distribution centered at 0 with scale controlled by step size.
    n = Math.abs(n); // Make positive.
    n = Math.round(n); // Round to nearest integer (we can only take discrete mutation step sizes).
    n = Math.min(1, n); // Ensure at least one step.
    return n;
  };
}
