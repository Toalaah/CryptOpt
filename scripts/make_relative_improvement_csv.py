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


def run_ms(sa: Path, rls: Path):
    output = subprocess.check_output(
        ["ms", rls.as_posix(), sa.as_posix(), "-n", "100", "-c"]
    )
    data = json.loads(output)
    cycles_sa, cycles_rls = data["cycles"]
    return cycles_sa, cycles_rls


def get_run_data(run: Path):
    @dataclass
    class Data:
        state_file: Path
        asm_file: Path
        curve: str
        method: str
        optimizer: Literal["rls", "sa"]
        symbol: str
        evals: int

    with open(run, "r") as f:
        data = json.load(f)
        return Data(
            state_file=run,
            asm_file=get_asm_file_from_state_file(run),
            curve=data["parsedArgs"]["curve"],
            method=data["parsedArgs"]["method"],
            symbol=data["parsedArgs"]["symbolname"],
            optimizer=data["parsedArgs"]["optimizer"],
            evals=data["parsedArgs"]["evals"],
        )


if len(sys.argv) < 2:
    print(f"Usage: {sys.argv[0]} DIR")
    exit(0)

res_dir = sys.argv[1]
results_dir = Path(res_dir)
runs = map(
    lambda r: get_run_data(
        Path(str(r).removesuffix("".join(r.suffixes))).with_suffix(".json")
    ),
    results_dir.rglob("**/*.summary.json"),
)

df = pd.DataFrame(runs)
grouped = df.sort_values(["evals", "optimizer"]).groupby(["evals", "curve", "method"])

data = []
for grp, runs in grouped:
    assert len(runs) == 2
    rls_run, sa_run = runs.iloc[0], runs.iloc[1]
    assert rls_run["optimizer"] == "rls" and sa_run["optimizer"] == "sa"
    evals, curve, method = grp
    cycles_sa, cycles_rls = run_ms(rls_run["asm_file"], sa_run["asm_file"])
    percentage_improvement(statistics.median(cycles_rls), statistics.median(cycles_sa))
    data.append(
        {
            "evals": evals,
            "curve": curve,
            "method": method,
            "cycles_rls": statistics.mean(cycles_rls),
            "cycles_sa": statistics.mean(cycles_sa),
            "mean_relative_improvement": percentage_improvement(
                statistics.mean(cycles_rls), statistics.mean(cycles_sa)
            ),
            "geo_mean_relative_improvement": percentage_improvement(
                statistics.geometric_mean(cycles_rls),
                statistics.geometric_mean(cycles_sa),
            ),
            "median_relative_improvement": percentage_improvement(
                statistics.median(cycles_rls), statistics.median(cycles_sa)
            ),
        }
    )

pd.DataFrame(data).to_csv("out.csv", index=False)
