function createNDArray(shape: number[], sampler: () => number, depth: number = 0): any[] {
  const dim = shape[depth];
  const arr = new Array(dim);

  if (depth === shape.length - 1) {
    for (let i = 0; i < dim; i++) {
      arr[i] = sampler();
    }
  } else {
    for (let i = 0; i < dim; i++) {
      arr[i] = createNDArray(shape, sampler, depth + 1);
    }
  }

  return arr;
}

function makeSampleScalar(params?: { loc?: number; scale?: number }) {
  const { loc = 0, scale = 1 } = params ?? {};
  const sampleScalar = (): number => {
    const u = Math.random(); // U ~ Uniform(0,1)
    return loc + scale * Math.tan(Math.PI * (u - 0.5));
  };
  return sampleScalar;
}

function cauchyRvs(params?: { loc?: number; scale?: number; size?: null }): number;
function cauchyRvs(params: { loc?: number; scale?: number; size?: number }): number[];
function cauchyRvs(params: { loc?: number; scale?: number; size?: number[] }): any[];
function cauchyRvs<T extends number | number[] | null>(params?: {
  loc?: number;
  scale?: number;
  size?: T;
}): T {
  const { loc = 0, scale = 1, size = null } = params ?? {};
  if (scale <= 0) {
    throw new Error("scale must be > 0");
  }

  const sampleScalar = makeSampleScalar({ loc, scale });
  if (size === null) {
    // Scalar output
    return sampleScalar() as T;
  }

  if (typeof size === "number") {
    // 1D array
    return Array.from({ length: size }, sampleScalar) as T;
  }

  if (Array.isArray(size)) {
    // N-dimensional array
    return createNDArray(size, sampleScalar) as T;
  }

  throw new Error("Invalid size parameter");
}

export { cauchyRvs as cauchy };
