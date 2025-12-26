import { OptimizerArgs } from "@/types";
import { Measuresuite } from "measuresuite";
import { Optimizer } from "@/optimizer";

export class SAOptimizer implements Optimizer {
  private measuresuite: Measuresuite;
  private symbolname: string;
  public getSymbolname(_: boolean): string {
    return this.symbolname;
  }

  public constructor(private args: OptimizerArgs) {
    throw new Error(`unimplemented!`);
  }

  public optimise() {
    return new Promise<number>((_) => {
      return 0;
    });
  }
}
