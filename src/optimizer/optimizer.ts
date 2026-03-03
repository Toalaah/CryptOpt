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

import { asm, OptimizerArgs } from "@/types";
import { Logger } from "@/helper/Logger.class";
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
import { createHash } from "crypto";

export type OptimizerResult = {
  ratio: number;
  cycleCount: number;
  numEvals: number;
};

export type MutationStats = {
  numMut: { permutation: number; decision: number };
  numRevert: { permutation: number; decision: number };

  maxRejectStreak: number;
  maxAcceptStreak: number;
  numRejectedEvals: number;
  numAcceptedEvals: number;
  numUnique: number;

  maxMutStepSize: number;
  avgMutStepSize: number;
};

export abstract class Optimizer {
  protected symbolname: string;
  protected no_of_instructions: number;
  protected libcheckfunctionDirectory: string;
  protected measuresuite: Measuresuite;
  protected mutationStats: MutationStats;

  protected asmStrings: { [k in FUNCTIONS]: string } = {
    [FUNCTIONS.F_A]: "",
    [FUNCTIONS.F_B]: "",
  };

  protected choice: CHOICE;

  protected asmHashes: Set<string>;

  protected isNew(asm: asm) {
    const hash = createHash("md5").update(asm).digest("hex");
    return !this.asmHashes.has(hash);
  }

  protected addToSeen(asm: asm) {
    const sBefore = this.asmHashes.size;
    this.asmHashes.add(createHash("md5").update(asm).digest("hex"));
    this.mutationStats.numUnique = this.asmHashes.size;
    return sBefore < this.asmHashes.size;
  }

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
    this.asmHashes = new Set<string>();

    this.mutationStats = {
      numMut: { permutation: 0, decision: 0 },
      numRevert: { permutation: 0, decision: 0 },

      maxRejectStreak: 0,
      maxAcceptStreak: 0,
      numRejectedEvals: 0,
      numAcceptedEvals: 0,
      numUnique: 0,

      maxMutStepSize: 1,
      avgMutStepSize: 1,
    };

    globals.convergence = [];
    globals.mutationLog = [
      "epoch,evaluation,nPerm,nDesc,choice,kept,newCandidate,PdetailsBackForwardChosenstepsWaled,DdetailsKindNumhotNumall,ratio",
    ];
    globals.bestEpochByRatio = { ratio: 0, epoch: 0, nEvals: 0, cycleCount: 0 };
    globals.bestEpochByCycle = {
      result: null,
      epoch: 0,
      nEvals: 0,
      indexGood: 0,
      cycleCount: Infinity,
      ratio: 0,
    };
    globals.currentRatio = 1;

    this.no_of_instructions = -1;
    // load a saved state if necessary
    if (args.readState) {
      Model.restoreFromFile(args.readState);
    }

    RegisterAllocator.options = args;
    this.choice = CHOICE.PERMUTE;
  }

  public abstract optimise(): Promise<OptimizerResult>;
  public getMutationStats(): MutationStats {
    return this.mutationStats;
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

  protected mutateBatch(n: number): { perm: number; decision: number } {
    let perm = 0;
    let decision = 0;
    for (let i = 0; i < n; i++) {
      this.choice = Paul.pick([CHOICE.PERMUTE, CHOICE.DECISION]);
      switch (this.choice) {
        case CHOICE.PERMUTE: {
          Model.mutatePermutation();
          perm++;
          break;
        }
        case CHOICE.DECISION: {
          const hasHappend = Model.mutateDecision();
          if (hasHappend) {
            decision++;
          } else {
            this.choice = CHOICE.PERMUTE;
            Model.mutatePermutation();
            perm++;
          }
          break;
        }
      }
    }
    return { perm, decision };
  }

  protected mutate(
    a: { random?: boolean; updateStats?: boolean } = { random: true, updateStats: true },
  ): void {
    const random = a.random ?? true;
    const updateStats = a.updateStats ?? true;
    if (random) {
      this.choice = Paul.pick([CHOICE.PERMUTE, CHOICE.DECISION]);
    }
    Logger.log("Mutationalita");
    switch (this.choice) {
      case CHOICE.PERMUTE: {
        Model.mutatePermutation();
        this.revertFunction = () => {
          if (updateStats) this.mutationStats.numRevert.permutation++;
          Model.revertLastMutation();
        };
        if (updateStats) this.mutationStats.numMut.permutation++;
        break;
      }
      case CHOICE.DECISION: {
        const hasHappend = Model.mutateDecision();
        if (!hasHappend) {
          // this is the case, if there is no hot decisions.
          this.choice = CHOICE.PERMUTE;
          this.mutate({ random: false, updateStats });
          return;
        }
        this.revertFunction = () => {
          if (updateStats) this.mutationStats.numRevert.decision++;
          Model.revertLastMutation();
        };
        if (updateStats) this.mutationStats.numMut.decision++;
      }
    }
  }
}
