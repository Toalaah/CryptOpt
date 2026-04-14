#!/usr/bin/env python3

from typing import NamedTuple
from pathlib import Path
import json
import numpy as np
import os
import pandas as pd
import csv
import argparse


class Run(NamedTuple):
    summary: Path
    state_file: Path
    mutation_log: Path


def valid_directory(value):
    if not os.path.isdir(value):
        raise argparse.ArgumentTypeError(f"invalid directory: '{value}'")
    return value


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


def make_rows(run: Run) -> list[dict]:
    base_info = {}
    _, state_path, mutation_log = run
    with open(state_path, "r") as f:
        state = json.load(f)["parsedArgs"]
        base_info["curve"] = state["curve"]
        base_info["method"] = state["method"]
        base_info["num_evals"] = state["evals"]
        base_info["num_evals_scaled"] = int(
            state["evals"] * (1 - state["betRatio"] if not state["single"] else 1)
        )
        base_info["seed"] = state["seed"]

    with open(mutation_log, "r") as f:
        df = pd.read_csv(f)
        df = df[["nPerm", "nDesc", "kept", "epoch"]]
        df["step_size"] = df["nPerm"] + df["nDesc"]
        df = (
            df.groupby(["step_size"])["kept"]
            .agg(["count", "sum"])
            .reset_index()
            .set_axis(["step_size", "count", "num_accepted"], axis=1)
        )
        for key, value in base_info.items():
            df[key] = value
        df = df.sort_values(["curve", "method", "num_evals"], ignore_index=True)
        df = df.loc[
            :,
            [
                "curve",
                "method",
                "num_evals",
                "num_evals_scaled",
                "seed",
                "step_size",
                "count",
                "num_accepted",
            ],
        ]
        return df.to_dict("records")


if __name__ == "__main__":
    args = make_args()
    results_dir = Path(args.dir)
    with_suffix = lambda path, suffix: Path(
        str(path).removesuffix("".join(path.suffixes))
    ).with_suffix(suffix)
    runs = list(
        map(
            lambda summary_path: Run(
                summary_path,
                with_suffix(summary_path, ".json"),
                with_suffix(summary_path, ".csv"),
            ),
            results_dir.rglob("**/*.summary.json"),
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
            fieldnames=make_rows(runs[0])[0].keys(),
            quoting=csv.QUOTE_MINIMAL,
        )
        w.writeheader()
        for run in runs:
            w.writerows(make_rows(run))

    print(f"Done. Wrote {len(runs)} rows to {args.name}.csv.")
