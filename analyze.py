#!/usr/bin/env python3

import csv
import argparse
import os
from pathlib import Path
from statistics import mean
from time import sleep
from dataclasses import dataclass, field
import json
import subprocess


@dataclass
class Run:
    dir: Path
    asm_files: list[Path] = field(default_factory=lambda: [])
    curve: str = ""
    method: str = ""
    evals: int = 0
    seed: str = ""
    optimizer: str = ""
    coolinig_schedule: int = 0
    initial_temperature: int = 0
    visiting_distribution: int = 0
    accept_criteria: int = 0
    reanneal_strategy: int = 0

    def __repr__(self):
        return str(self.dir)

    def __post_init__(self):
        self.asm_files.extend(self.dir.rglob("*.asm"))
        json_files = list(self.dir.rglob("*.json"))
        assert len(json_files) == 1
        state_file = json_files[0]
        with open(state_file, "r") as f:
            d = json.load(f)["parsedArgs"]
            self.curve = d["curve"]
            self.method = d["method"]
            self.evals = d["evals"]
            self.seed = d["seed"]
            self.optimizer = d["optimizer"]
            self.coolinig_schedule = d["saCoolingSchedule"]
            self.initial_temperature = d["saInitialTemperature"]
            self.visiting_distribution = d["saVisitingDistribution"]
            self.accept_criteria = d["saAcceptCriteria"]
            self.reanneal_strategy = d["saReannealStrategy"]


def measure_run(run: Run):
    cycles_lib_trials: list[float] = []
    cycle_opt = -1.0
    for asm_file in run.asm_files:
        trials: list[float] = []
        for _ in range(3):
            cycles_cryptopt, cycles_lib = measure_asm(asm_file)
            cycles_lib_trials.append(cycles_lib)
            trials.append(cycles_cryptopt)
        cycles_cryptopt_mean = mean(trials)
        if cycle_opt < 0.0 or cycles_cryptopt_mean < cycle_opt:
            cycle_opt = cycles_cryptopt_mean
    return int(cycle_opt), int(mean(cycles_lib_trials))


def measure_asm(a: Path):
    env = dict(os.environ, CC="clang")
    output = subprocess.check_output(["measure.sh", a.as_posix()], env=env)
    lines = output.decode().splitlines()
    assert len(lines) == 1
    line = lines[0].split(" ")
    cycles_cryptopt = float(line[0])
    cycles_lib = float(line[1])
    return cycles_cryptopt, cycles_lib


def make_args():
    def valid_directory(value):
        if not os.path.isdir(value):
            raise argparse.ArgumentTypeError(f"invalid directory: '{value}'")
        return value

    parser = argparse.ArgumentParser()
    parser.add_argument("--name", "-n", default="analysis", help="name of output file")
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="force overwrite of output file if it already exists",
    )
    parser.add_argument("dir", type=valid_directory)
    return parser.parse_args()


if __name__ == "__main__":
    args = make_args()
    runs = list(
        map(
            lambda result: Run(dir=result),
            Path(args.dir).rglob("**/fiat/*"),
        )
    )

    if os.path.exists(f"{args.name}.csv") and not args.force:
        print(
            f"File {args.name}.csv already exists. Refusing to continue without -f/--force."
        )
        exit(1)

    with open(f"{args.name}.csv", "w") as csv_file:
        writer = csv.writer(csv_file, delimiter=",", lineterminator="\n")
        writer.writerow(
            [
                "curve",
                "method",
                "evals",
                "seed",
                "optimizer",
                "saCoolingSchedule",
                "saInitialTemperature",
                "saReannealStrategy",
                "saVisitingDistribution",
                "saAcceptCriteria",
                "cyclesOpt",
                "cyclesLib",
                "speedup",
            ]
        )
        for run in runs:
            print(f"Measuring {run}")
            cycles_opt, cycles_lib = measure_run(run)
            speedup = cycles_lib / cycles_opt
            writer.writerow(
                [
                    run.curve,
                    run.method,
                    run.evals,
                    run.seed,
                    run.optimizer,
                    run.coolinig_schedule,
                    run.initial_temperature,
                    run.reanneal_strategy,
                    run.visiting_distribution,
                    run.accept_criteria,
                    cycles_opt,
                    cycles_lib,
                    speedup,
                ]
            )
            sleep(0.25)
