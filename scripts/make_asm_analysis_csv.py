#!/usr/bin/env python3

from typing import NamedTuple
from pathlib import Path
import json
import os
import csv
import argparse
import subprocess


class Run(NamedTuple):
    state_file: Path


def valid_directory(value):
    if not os.path.isdir(value):
        raise argparse.ArgumentTypeError(f"invalid directory: '{value}'")
    return value


def measure_asm_cycle(asm_file: Path):
    output = subprocess.check_output(
        ["node", "./dist/CountCycle.js", asm_file.as_posix()]
    )
    return float(output.decode().split()[0])


def measure_asm_instruction_count(asm_file: Path):
    # Subtract three for labels and global symbol attributes.
    return len(open(asm_file.as_posix(), "r").readlines()) - 3


def measure_asm_stack_size(asm_file: Path):
    with open(asm_file, "r") as f:
        for line in f:
            if line.startswith("sub rsp, "):
                return int(line.split(", ")[1])
    return 0


def measure_mov_instruction_count(asm_file: Path):
    n = 0
    with open(asm_file, "r") as f:
        for line in f:
            if any(line.startswith(inst) for inst in ["mov", "xchg"]):
                n += 1
    return n


def measure_asm_spill_count(asm_file: Path):
    spill_count = 0
    with open(asm_file, "r") as f:
        for line in f:
            if "spilling" in line:
                spill_count += 1
    return spill_count


def make_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", "-n", default="run", help="name of output file")
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="force overwrite of output file if it already exists",
    )
    parser.add_argument("dir", type=valid_directory)
    return parser.parse_args()


def make_row(run: Run) -> dict:
    base_info = {}
    state_path = run[0]
    with open(state_path, "r") as f:
        state = json.load(f)["parsedArgs"]
        base_info["scheduling_algorihtm"] = state["schedulingAlgorithm"]
        base_info["curve"] = state["curve"]
        base_info["method"] = state["method"]
        base_info["seed"] = state["seed"]
    asm_path = state_path.with_suffix(".asm")
    base_info["cycles"] = measure_asm_cycle(asm_path)
    base_info["instruction_count"] = measure_asm_instruction_count(asm_path)
    base_info["stack_size"] = measure_asm_stack_size(asm_path)
    base_info["spills"] = measure_asm_spill_count(asm_path)
    base_info["num_movs"] = measure_mov_instruction_count(asm_path)
    return base_info


if __name__ == "__main__":
    args = make_args()

    results_dir = Path(args.dir)
    runs = list(
        map(
            lambda state_path: Run(state_path),
            results_dir.rglob("**/*.json"),
        )
    )

    if not runs:
        print("No runs found. Empty results dir?")
        exit(0)

    if os.path.exists(f"{args.name}.csv") and not args.force:
        print(
            f"File {args.name}.csv already exists. Refusing to continue without -f/--force."
        )
        exit(1)

    with open(f"{args.name}.csv", "w", newline="") as csvfile:
        w = csv.DictWriter(
            csvfile,
            fieldnames=make_row(runs[0]).keys(),
            quoting=csv.QUOTE_MINIMAL,
        )
        w.writeheader()
        for run in runs:
            print(f"Measuring {run}")
            w.writerow(make_row(run))

    print(f"Done. Wrote {len(runs)} rows to {args.name}.csv.")
