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

import { OptimizerArgs } from "@/types";
import Logger from "@/helper/Logger.class";
import { Paul, sha1Hash } from "@/paul";
import { existsSync, rmSync } from "fs";
import { Measuresuite } from "measuresuite";
import { tmpdir } from "os";
import { join } from "path";
import { init } from "./helpers";
import { Model } from "@/model";
import { CHOICE, FUNCTIONS } from "@/enums";
import globals from "@/helper/globals";
import { RegisterAllocator } from "@/registerAllocator";
import { errorOut, ERRORS } from "@/errors";
import { writeString } from "@/helper";

export abstract class Optimizer {
  protected symbolname: string;
  protected no_of_instructions: number;
  protected libcheckfunctionDirectory: string;
  protected measuresuite: Measuresuite;
  protected numMut: { [id: string]: number } = {
    permutation: 0,
    decision: 0,
  };
  protected numRevert: { [id: string]: number } = {
    permutation: 0,
    decision: 0,
  };

  protected asmStrings: { [k in FUNCTIONS]: string } = {
    [FUNCTIONS.F_A]: "",
    [FUNCTIONS.F_B]: "",
  };

  protected choice: CHOICE;

  protected handleMeasurementError(e: any): never {
    const isIncorrect = e instanceof Error && e.message.includes("tested_incorrect");
    const isInvalid = e instanceof Error && e.message.includes("could not be assembled");
    if (isInvalid || isIncorrect) {
      writeString(join(this.args.resultDir, "tested_incorrect_A.asm"), this.asmStrings[FUNCTIONS.F_A]);
      writeString(join(this.args.resultDir, "tested_incorrect_B.asm"), this.asmStrings[FUNCTIONS.F_B]);
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

  public constructor(protected args: OptimizerArgs) {
    const { seed } = args;
    Paul.seed = seed;
    const randomString = sha1Hash(Math.ceil(Date.now() * Math.random())).toString(36);
    this.libcheckfunctionDirectory = join(tmpdir(), "CryptOpt.cache", randomString);
    const { measuresuite, symbolname } = init(this.libcheckfunctionDirectory, args);
    this.measuresuite = measuresuite;
    this.symbolname = symbolname;
    this.choice = CHOICE.PERMUTE;
    this.no_of_instructions = -1;
    // load a saved state if necessary
    if (args.readState) {
      Model.import(args.readState);
    }

    globals.convergence = [];
    globals.mutationLog = [
      "evaluation,choice,kept,PdetailsBackForwardChosenstepsWaled,DdetailsKindNumhotNumall",
    ];
    RegisterAllocator.options = args;
  }

  public abstract optimise(): Promise<number>;
  public getMutationStats(): {
    numMut: { permutation: number; decision: number };
    numRevert: { permutation: number; decision: number };
  } {
    return {
      numMut: {
        decision: this.numMut.decision,
        permutation: this.numMut.permutation,
      },
      numRevert: {
        decision: this.numRevert.decision,
        permutation: this.numRevert.permutation,
      },
    };
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
        Logger.log(`Removing lib check functions in '${this.libcheckfunctionDirectory}'`);
        rmSync(this.libcheckfunctionDirectory, { recursive: true });
        Logger.log(`removed ${this.libcheckfunctionDirectory}`);
      } catch (e) {
        console.error(e);
        throw e;
      }
    }
  }

  protected revertFunction = (): void => {};

  protected mutate(random: boolean = false): void {
    if (random) {
      this.choice = Paul.pick([CHOICE.PERMUTE, CHOICE.DECISION]);
    }
    Logger.log("Mutationalita");
    switch (this.choice) {
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
          this.choice = CHOICE.PERMUTE;
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
}
