#!/usr/bin/env python3

import sys
from pathlib import Path
import subprocess
import json
import statistics
import pandas as pd
from typing import Literal
from dataclasses import dataclass


def percentage_improvement(x, y):
    return (x - y) / y * 100


def get_asm_file_from_state_file(state_file: Path):
    with open(state_file, "r") as f:
        data = json.load(f)
        ratio = data["ratio"]
        suffix = "_ratio" + str(round(ratio * 10000)).zfill(5)
        return state_file.with_name(state_file.stem + suffix).with_suffix(".asm")


def run_ms(sa: Path, rls: Path, n: int = 3):
    cycles_sa = []
    cycles_rls = []
    for _ in range(n):
        output = subprocess.check_output(
            ["ms", sa.as_posix(), rls.as_posix(), "-n", "100", "-c"]
        )
        data = json.loads(output)
        cycles_sa.extend(data["cycles"][0])
        cycles_rls.extend(data["cycles"][1])
    return cycles_sa, cycles_rls


def get_run_data(summary: Path):
    @dataclass
    class Data:
        state_file: Path
        asm_file: Path
        curve: str
        method: str
        optimizer: Literal["rls", "sa"]
        symbol: str
        evals: int
        ratio: float
        best_ratio: float
        best_cycle: float
        cycle: float

    run = Path(str(summary).removesuffix("".join(summary.suffixes))).with_suffix(
        ".json"
    )

    best_ratio = 0.0
    best_cycle = 0.0
    cycle = 0.0

    with open(summary, "r") as f:
        d = json.load(f)
        best_ratio = d["bestEpochByRatio"]["ratio"]
        best_cycle = d["bestEpochByCycle"]["cycleCount"]
        cycle = d["cycleCount"]

    with open(run, "r") as f:
        d = json.load(f)
        data = Data(
            state_file=run,
            asm_file=get_asm_file_from_state_file(run),
            curve=d["parsedArgs"]["curve"],
            method=d["parsedArgs"]["method"],
            symbol=d["parsedArgs"]["symbolname"],
            optimizer=d["parsedArgs"]["optimizer"],
            evals=d["parsedArgs"]["evals"],
            ratio=d["ratio"],
            best_ratio=best_ratio,
            best_cycle=best_cycle,
            cycle=cycle,
        )
    return data


if len(sys.argv) < 2:
    print(f"Usage: {sys.argv[0]} DIR")
    exit(0)

res_dir = sys.argv[1]
results_dir = Path(res_dir)
runs = map(
    lambda r: get_run_data(r),
    results_dir.rglob("**/*.summary.json"),
)

df = pd.DataFrame(runs)
grouped = df.sort_values(["evals", "optimizer"]).groupby(["evals", "curve", "method"])

data = []
for grp, runs in grouped:
    assert len(runs) == 2
    rls_run, sa_run = runs.iloc[0], runs.iloc[1]
    assert rls_run["optimizer"] == "rls" and sa_run["optimizer"] == "sa"
    ratio_rls, ratio_sa = rls_run["ratio"], sa_run["ratio"]
    evals, curve, method = grp
    cycles_sa, cycles_rls = run_ms(sa_run["asm_file"], rls_run["asm_file"])
    data.append(
        {
            "evals": evals,
            "curve": curve,
            "method": method,
            "ratio_rls": ratio_rls,
            "ratio_sa": ratio_sa,
            "ratio_improvement": percentage_improvement(ratio_sa, ratio_rls),
            "best_ratio_improvement": percentage_improvement(
                sa_run["best_ratio"],
                rls_run["best_ratio"],
            ),
            "cycle_improvement": percentage_improvement(
                sa_run["cycle"], rls_run["cycle"]
            ),
            "best_cycle_improvement": percentage_improvement(
                sa_run["best_cycle"],
                rls_run["best_cycle"],
            ),
            "cycles_rls": rls_run["cycle"],
            "cycles_sa": sa_run["cycle"],
            # Validation stats.
            "cycles_rls_validate": statistics.mean(cycles_rls),
            "cycles_sa_validate": statistics.mean(cycles_sa),
            "mean_relative_improvement_validate": percentage_improvement(
                statistics.mean(cycles_sa),
                statistics.mean(cycles_rls),
            ),
            "geo_mean_relative_improvement_validate": percentage_improvement(
                statistics.geometric_mean(cycles_sa),
                statistics.geometric_mean(cycles_rls),
            ),
            "median_relative_improvement_validate": percentage_improvement(
                statistics.median(cycles_sa),
                statistics.median(cycles_rls),
            ),
        }
    )

pd.DataFrame(data).to_csv("compare-rls-sa.csv", index=False)
