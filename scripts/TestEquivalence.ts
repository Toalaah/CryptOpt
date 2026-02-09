import { assemble, strip } from "@/assembler";
import { CHOICE } from "@/enums";
import { execSync } from "child_process";
import { parsedArgs as parsedArgsFromCli, writeString } from "@/helper";
import { Model } from "@/model";
import { Paul } from "@/paul";
import { RegisterAllocator } from "@/registerAllocator";
import { join, resolve as pathResolve, resolve } from "path";
import { init } from "@/optimizer/helpers";

const parsedArgs = parsedArgsFromCli;

function buildMsCheckCommand(asmFile: string, symbolname: string) {
  const sharedObjectFilename = resolve(
    ".cryptopt",
    `libcheckfunctions-s${parsedArgs.seed}-b${parsedArgs.bridge}-p${process.pid}.so`,
  );
  const cmd = ["ms", asmFile, sharedObjectFilename, "-c", "-s", symbolname];
  return cmd.join(" ");
}

function mutate(choice?: CHOICE): CHOICE {
  choice = choice ?? Paul.pick([CHOICE.PERMUTE, CHOICE.DECISION]);
  switch (choice) {
    case CHOICE.PERMUTE: {
      Model.mutatePermutation();
      break;
    }
    case CHOICE.DECISION: {
      let numTries = 0;
      while (!Model.mutateDecision()) {
        if (++numTries > 10) throw new Error("failed to mutate decision");
      }
      break;
    }
  }
  return choice;
}

const { seed } = parsedArgs;
Paul.seed = seed;
RegisterAllocator.options = parsedArgs;

// Turn off debug messages.
const log = console.log;
console.log = () => {};

// Initialize bridge + model.
const libcheckfunctionDirectory = join(".cryptopt");
const { measuresuite, symbolname } = init(libcheckfunctionDirectory, parsedArgs);

// Assemble model into asm and write to file.
const { code } = assemble(parsedArgs.resultDir);
const asmFilePath = pathResolve(libcheckfunctionDirectory, "current.asm");

// Perform some mutations.
for (let i = 0; i < 1000; ++i) {
  mutate();
}

writeString(
  asmFilePath,
  strip(["SECTION .text", `\tGLOBAL ${symbolname}`, `${symbolname}:`].concat(code)).join("\n"),
);

console.log = log;
const proofCmd = buildMsCheckCommand(asmFilePath, symbolname);
console.log(`proving that asm correct with '${proofCmd}'`);
let exitCode = 0;
try {
  const output = execSync(proofCmd, { shell: "/usr/bin/bash" }).toString().split("\n");
  const res = output[output.length - 1];
  const parsed = JSON.parse(res);
  exitCode = parsed.stats.incorrect > 0 ? 1 : 0;
} catch (e) {
  console.error(`tried to prove correct. didnt work. I tried ${proofCmd}`);
  console.error(e.stdout.toString());
  exitCode = 1;
}
measuresuite.destroy();
process.exit(exitCode);
