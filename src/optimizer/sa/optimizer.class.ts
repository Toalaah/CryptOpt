import { OptimizerArgs } from "@/types";
import { Measuresuite } from "measuresuite";
import { Optimizer } from "@/optimizer";
import { Paul, sha1Hash } from "@/paul";
import { tmpdir } from "os";
import { join } from "path";
import { Model } from "@/model";
import { init } from "@/optimizer/helpers";

export class SAOptimizer implements Optimizer {
  private measuresuite: Measuresuite;
  private libcheckfunctionDirectory: string;
  private symbolname: string;
  public getSymbolname(_: boolean): string {
    return this.symbolname;
  }

  public constructor(private args: OptimizerArgs) {
    Paul.seed = args.seed;

    const randomString = sha1Hash(Math.ceil(Date.now() * Math.random())).toString(36);
    this.libcheckfunctionDirectory = join(tmpdir(), "CryptOpt.cache", randomString);

    const { measuresuite, symbolname } = init(this.libcheckfunctionDirectory, args);

    this.measuresuite = measuresuite;
    this.symbolname = symbolname;

    if (args.readState) {
      Model.import(args.readState);
    }
  }

  public optimise() {
    throw new Error(`unimplemented!`);
    return new Promise<number>((_) => {
      return 0;
    });
  }
}
