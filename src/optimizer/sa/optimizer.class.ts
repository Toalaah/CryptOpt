import { OptimizerArgs } from "@/types";
import { Optimizer } from "@/optimizer";
import { Model } from "@/model";

export class SAOptimizer extends Optimizer {
  public constructor(args: OptimizerArgs) {
    super(args);
    if (this.args.readState) {
      Model.import(this.args.readState);
    }
  }

  public optimise() {
    throw new Error(`unimplemented!`);
    return new Promise<number>((_) => {
      return 0;
    });
  }
}
