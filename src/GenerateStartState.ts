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
import { init } from "./optimizer/helpers";
import { join } from "path";
import { sha1Hash } from "./paul";

const args = makeArgs();
const parsedArgs = parseArgs(args);

const randomString = sha1Hash(Math.ceil(Date.now() * Math.random())).toString(36);
const libcheckfunctionDirectory = join(parsedArgs.cacheDir, "CryptOpt.cache", randomString);
init(libcheckfunctionDirectory, parsedArgs);

const state = {
  ...Model.getState(),
  parsedArgs,
};
process.stdout.write(JSON.stringify(state, null, 2));
process.stdout.write("\n");
