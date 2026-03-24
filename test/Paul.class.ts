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

import { describe, expect, it, vi } from "vitest";

import { C_DI_SPILL_LOCATION, DECISION_IDENTIFIER } from "@/enums";
import { BIAS, Paul } from "@/paul";
import type { CryptOpt } from "@/types";

describe("Paul", () => {
  describe("Paul:choose<T>", () => {
    it("should delimbify before choosing", () => {
      Paul.currentInstruction = {
        name: ["x15"],
        datatype: "u128",
        operation: "mulx",
        decisions: {
          [DECISION_IDENTIFIER.DI_SPILL_LOCATION]: [
            0,
            [C_DI_SPILL_LOCATION.C_DI_MEM, C_DI_SPILL_LOCATION.C_DI_XMM_REG],
          ],
          di_choose_arg: [1, ["x14", "x13"]],
        },
        decisionsHot: ["di_choose_arg"],
        arguments: ["x14", "x13"],
      } as CryptOpt.DynArgument;

      const arr = ["x14_0", "x13_0"];
      const choice = Paul.chooseArg(arr);
      expect(choice).toEqual("x13_0");
    });
  });
  describe("chooseBetween: biased", () => {
    let limit = Math.pow(10, 5);
    Paul.seed = 101;
    let left = 0,
      right = 0;
    const r = new Array<number>(limit);
    const min = 5;
    const max = 53;
    const delta = Math.abs(min - max);
    const cutoff = min + delta / 2;
    for (let n = 0; n <= limit; n++) {
      const s = Paul.chooseBetween(max, min, BIAS.REVERSE_BELL);
      r[n] = s;
      if (s < cutoff) {
        left += s; // node would be moved more to the start <<<<
      } else {
        right += s; // node would be moved more to the end >>>>>
      }
    }
    limit /= 2;
    // console.log({ neg: left, pos: right, n: left / limit, p: right / limit });
    it("should calculate correct", () => {
      expect(left / limit).toBeLessThan(min + delta / 5);
      expect(right / limit).toBeGreaterThan(max - delta / 5);
    });
  });

  describe("uniform", () => {
    it("should return values in [0, 1]", () => {
      Paul.seed = 42;
      for (let i = 0; i < 1000; i++) {
        const v = Paul.uniform();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    it("should have mean close to 0.5", () => {
      Paul.seed = 42;
      const N = 10_000;
      let sum = 0;
      for (let i = 0; i < N; i++) sum += Paul.uniform();
      const mean = sum / N;
      // For a uniform [0,1], std dev = 1/sqrt(12) ≈ 0.289, std error ≈ 0.00289
      // Allow ±5 standard errors as tolerance
      expect(mean).toBeGreaterThan(0.485);
      expect(mean).toBeLessThan(0.515);
    });

    it("should pass a chi-squared uniformity test", () => {
      Paul.seed = 123;
      const N = 10_000;
      const k = 10; // bins over [0, 1]
      const bins = new Array<number>(k).fill(0);
      for (let i = 0; i < N; i++) {
        const v = Paul.uniform();
        const bin = Math.min(Math.floor(v * k), k - 1);
        bins[bin]++;
      }
      const expected = N / k;
      const chi2 = bins.reduce((acc, obs) => acc + (obs - expected) ** 2 / expected, 0);
      // chi2(9 dof) critical value at 0.001 significance level is ~27.88
      expect(chi2).toBeLessThan(27.88);
    });
  });

  describe("chooseWithProbabilities", () => {
    it("should throw on probabilities that don't sum to 1", () => {
      expect(() => Paul.chooseWithProbabilities([0.5, 0.3])).toThrow("invalid probabily distribution");
      expect(() => Paul.chooseWithProbabilities([0.1])).toThrow("invalid probabily distribution");
      expect(() => Paul.chooseWithProbabilities([])).toThrow("invalid probabily distribution");
    });

    it("should return 0 for a single-element distribution [1.0]", () => {
      expect(Paul.chooseWithProbabilities([1.0])).toBe(0);
    });

    it("should return a valid index", () => {
      const probs = [0.25, 0.25, 0.25, 0.25];
      for (let i = 0; i < 100; i++) {
        const idx = Paul.chooseWithProbabilities(probs);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(probs.length);
      }
    });

    it("should select index according to cumulative probability", () => {
      const spy = vi.spyOn(Math, "random");
      const probs = [0.2, 0.3, 0.5];

      // random=0.1 falls in first bucket [0, 0.2)
      spy.mockReturnValue(0.1);
      expect(Paul.chooseWithProbabilities(probs)).toBe(0);

      // random=0.2 lands exactly at boundary -> first bucket (0.2 - 0.2 = 0 <= 0)
      spy.mockReturnValue(0.2);
      expect(Paul.chooseWithProbabilities(probs)).toBe(0);

      // random=0.3 falls in second bucket [0.2, 0.5)
      spy.mockReturnValue(0.3);
      expect(Paul.chooseWithProbabilities(probs)).toBe(1);

      // random=0.5 lands exactly at second boundary -> second bucket
      spy.mockReturnValue(0.5);
      expect(Paul.chooseWithProbabilities(probs)).toBe(1);

      // random=0.51 falls in third bucket [0.5, 1.0)
      spy.mockReturnValue(0.51);
      expect(Paul.chooseWithProbabilities(probs)).toBe(2);

      // random=0.99 falls in third bucket
      spy.mockReturnValue(0.99);
      expect(Paul.chooseWithProbabilities(probs)).toBe(2);

      spy.mockRestore();
    });

    it("should respect skewed distributions", () => {
      const spy = vi.spyOn(Math, "random");
      const probs = [0.9, 0.05, 0.05];

      // Almost any low random value should select index 0
      spy.mockReturnValue(0.89);
      expect(Paul.chooseWithProbabilities(probs)).toBe(0);

      // Just past 0.9 should select index 1
      spy.mockReturnValue(0.91);
      expect(Paul.chooseWithProbabilities(probs)).toBe(1);

      // Near 1.0 should select index 2
      spy.mockReturnValue(0.96);
      expect(Paul.chooseWithProbabilities(probs)).toBe(2);

      spy.mockRestore();
    });
  });
});
