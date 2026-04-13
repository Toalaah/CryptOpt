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

import { makeArgs, parseArgs } from "@/helper";
import { Model } from "@/model";

import { Assembler, strip } from "./assembler";
import { OptimizerFactory } from "./optimizer";
import { readFileSync } from "fs";
import { CryptOpt } from "./types";
import { resolve } from "path";

const eargs = makeArgs().option("writeState", {
  default: false,
  boolean: true,
  alias: "w",
  describe: "Output state file after assembling",
});

const parsedArgsFromCli = parseArgs<{ writeState: boolean }>(eargs);

let parsedArgs = parsedArgsFromCli;
const dynamicOperationOrdering = parsedArgs.dynamicOperationOrdering;
if (!parsedArgs.readState) {
  console.error(`Must pass state file to assemble with --readState`);
  process.exit(1);
}

const stateFile: CryptOpt.StateFile = JSON.parse(readFileSync(parsedArgs.readState).toString());
if (stateFile.parsedArgs) parsedArgs = stateFile.parsedArgs;
if (parsedArgs.resultDir == "") parsedArgs.resultDir = resolve(process.cwd(), "results");

// Set assembler options (uses original cli args, not those parsed from readState)
Assembler.options = { dynamicOperationOrdering };

const symbolname = OptimizerFactory.make(parsedArgs).getSymbolname(true);

Model.restore(stateFile);
const { code } = Assembler.assemble(parsedArgs.resultDir);
process.stdout.write(
  strip(["SECTION .text", `\tGLOBAL ${symbolname}`, `${symbolname}:`].concat(code)).join("\n"),
);

if (parsedArgsFromCli.writeState) {
  process.stderr.write("Wrote state!\n");
  Model.persist("assembled.json", parsedArgs);
}
