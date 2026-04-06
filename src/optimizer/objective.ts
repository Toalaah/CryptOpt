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

import { AnalyseResult, OptimizerArgs } from "@/types";
import { Measuresuite } from "measuresuite";
import { join } from "path";
import { init, makeSharedObjectFilename } from "./helpers";
import { sha1Hash } from "@/paul";
import { errorOut, ERRORS } from "@/errors";
import { analyseMeasureResult, analyseMeasureResult2 } from "@/helper";
import { existsSync, readFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { Logger } from "@/helper/Logger.class";

export type Counter = "PMC" | "RDTSCP" | "SIM";

export abstract class Objective {
  public batchSize: number = 1;
  public numBatches: number = 1;
  protected libcheckfunctionDirectory: string;
  protected symbolname: string;

  public constructor(
    protected args: OptimizerArgs,
    initialize: boolean = true,
  ) {
    const randomString = sha1Hash(Math.ceil(Date.now() * Math.random())).toString(36);
    this.libcheckfunctionDirectory = join(args.cacheDir, "CryptOpt.cache", randomString);
    if (initialize) {
      const { symbolname } = init(this.libcheckfunctionDirectory, args);
      this.symbolname = symbolname;
    } else {
      this.symbolname = "";
    }
  }

  public abstract measure(functions: string[]): AnalyseResult;
  public abstract getCounter(): Counter;
  public cleanup() {}

  public getLibcheckfunctionDirectory() {
    return this.libcheckfunctionDirectory;
  }

  public getSymbolname(deleteCache: boolean = false) {
    if (deleteCache) {
      this.cleanLibcheckfunctions();
    }
    return this.symbolname;
  }

  protected cleanLibcheckfunctions() {
    if (existsSync(this.libcheckfunctionDirectory)) {
      try {
        rmSync(this.libcheckfunctionDirectory, { recursive: true });
      } catch (e) {
        console.error(e);
        throw e;
      }
    }
  }

  protected updateBatchSize(meanrawCheck: number) {
    this.batchSize = Math.ceil((Number(this.args.cyclegoal) / meanrawCheck) * this.batchSize);
    this.batchSize = Math.min(this.batchSize, 10000);
    this.batchSize = Math.max(this.batchSize, 5);
  }
}

export class ObjectiveFactory {
  public static make(args: OptimizerArgs): Objective {
    switch (args.measureStrategy) {
      case "measuresuite":
        return new MeasureSuiteObjective(args);
      case "llvm":
        return new LLVMObjective(args);
      default:
        throw new Error(`unknown objective function measure strategy: ${args.optimizer}`);
    }
  }
}

export type SummaryView = {
  BlockRThroughput: number;
  DispatchWidth: number;
  IPC: number;
  Instructions: number;
  Iterations: number;
  TotalCyles: number;
  TotaluOps: number;
  uOpsPerCycle: number;
};

export class LLVMObjective extends Objective {
  private checkResult: SummaryView;

  public constructor(args: OptimizerArgs) {
    super(args);
    Logger.log("construct llvm objective");
    const checkPath = join(this.libcheckfunctionDirectory, makeSharedObjectFilename(args, "asm"));
    const checkAsm = readFileSync(checkPath).toString();
    this.checkResult = this.runMCA(checkAsm);
    Logger.log(`done run mca llvm objective: ${JSON.stringify(this.checkResult)}`);
  }

  public getLibcheckfunctionDirectory(): string {
    return this.libcheckfunctionDirectory;
  }

  public getCounter(): Counter {
    return "SIM";
  }

  private runMCA(asm: string) {
    const cleanedASM =
      ".intel_syntax noprefix\n" + asm.replaceAll(";", "#").replaceAll("byte [", "byte ptr [");
    const result = spawnSync("llvm-mca", ["-json"], { input: cleanedASM });
    if (result.status != 0) {
      console.error("measure returned with error status.");
      errorOut(ERRORS.measureCannotAnalyze);
    }
    const data = JSON.parse(result.stdout.toString()).CodeRegions[0].SummaryView as SummaryView;
    return data;
  }

  public measure(functions: string[]): AnalyseResult {
    const results = functions.map(this.runMCA);
    results.push(this.checkResult);
    const analysis = analyseMeasureResult2(results, {
      batchSize: this.batchSize,
      resultDir: this.args.resultDir,
    });

    if (!analysis) {
      console.error("analysis returned, but results is nullish. TSNH.");
      errorOut(ERRORS.measureCannotAnalyze);
    }

    const meanrawCheck = analysis.rawMedian[analysis.rawMedian.length - 1];
    this.updateBatchSize(meanrawCheck);
    return analysis;
  }
}

export class MeasureSuiteObjective extends Objective {
  private measuresuite: Measuresuite;

  public constructor(args: OptimizerArgs) {
    super(args, false);
    const { measuresuite, symbolname } = init(this.libcheckfunctionDirectory, args);
    this.measuresuite = measuresuite;
    this.symbolname = symbolname;
    this.batchSize = 200;
    this.numBatches = 31;
  }

  public measure(functions: string[]): AnalyseResult {
    const results = this.measuresuite.measure(this.batchSize, this.numBatches, functions);
    if (!results) {
      console.error("measure returned, but results is nullish. TSNH.");
      errorOut(ERRORS.measureCannotAnalyze);
    }

    const analysis = analyseMeasureResult(results, {
      batchSize: this.batchSize,
      resultDir: this.args.resultDir,
    });

    if (!analysis) {
      console.error("analysis returned, but results is nullish. TSNH.");
      errorOut(ERRORS.measureCannotAnalyze);
    }

    const meanrawCheck = analysis.rawMedian[analysis.rawMedian.length - 1];
    this.updateBatchSize(meanrawCheck);
    return analysis;
  }

  public getCounter() {
    return this.measuresuite.timer;
  }

  public cleanup() {
    this.measuresuite.destroy();
    this.cleanLibcheckfunctions();
  }
}
