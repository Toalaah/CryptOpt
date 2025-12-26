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

export abstract class Optimizer {
  protected symbolname: string;
  protected libcheckfunctionDirectory: string;
  protected measuresuite: Measuresuite;

  public constructor(protected args: OptimizerArgs) {
    const { seed } = args;
    Paul.seed = seed;
    const randomString = sha1Hash(Math.ceil(Date.now() * Math.random())).toString(36);
    this.libcheckfunctionDirectory = join(tmpdir(), "CryptOpt.cache", randomString);
    const { measuresuite, symbolname } = init(this.libcheckfunctionDirectory, args);
    this.measuresuite = measuresuite;
    this.symbolname = symbolname;
  }

  public abstract optimise(): Promise<number>;

  public getSymbolname(deleteCache: boolean = false) {
    if (deleteCache) {
      this.cleanLibcheckfunctions();
    }
    return this.symbolname;
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
