#!/usr/bin/env python3

from pathlib import Path
import json
import numpy as np
import os
import pandas as pd
import csv
import argparse


def valid_directory(value):
    if not os.path.isdir(value):
        raise argparse.ArgumentTypeError(f"invalid directory: '{value}'")
    return value


def make_args():
    parser = argparse.ArgumentParser(
        description="Consolidate many CryptOpt runs into a mega CSV for further data analysis."
    )
    parser.add_argument("--name", "-n", default="run", help="name of output file")
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="force overwrite of output file if it already exists",
    )
    parser.add_argument("dir", type=valid_directory)
    return parser.parse_args()


def make_row(run: tuple[Path, Path, Path]) -> dict:
    d = {}
    summary_path, state_path, mutation_log = run
    with open(summary_path, "r") as f:
        summary = json.load(f)
        d["ratio"] = summary["ratio"]
        d["cycle_count_median"] = summary["cycleCount"]

        d["best_epoch_ratio_epoch"] = summary["bestEpochByRatio"]["epoch"]
        d["best_epoch_ratio_num_evals"] = summary["bestEpochByRatio"]["nEvals"]
        d["best_epoch_ratio_cycle_count"] = summary["bestEpochByRatio"]["cycleCount"]
        d["best_epoch_ratio_ratio"] = summary["bestEpochByRatio"]["ratio"]

        d["best_epoch_cycle_epoch"] = summary["bestEpochByCycle"]["epoch"]
        d["best_epoch_cycle_num_evals"] = summary["bestEpochByCycle"]["nEvals"]
        d["best_epoch_cycle_cycle_count"] = summary["bestEpochByCycle"]["cycleCount"]
        d["best_epoch_cycle_ratio"] = summary["bestEpochByCycle"]["ratio"]

        d["num_mut_d"] = summary["mutationStats"]["numMut"]["decision"]
        d["num_mut_p"] = summary["mutationStats"]["numMut"]["permutation"]
        d["num_revert_d"] = summary["mutationStats"]["numRevert"]["decision"]
        d["num_revert_p"] = summary["mutationStats"]["numRevert"]["permutation"]

        d["max_reject_streak"] = summary["mutationStats"]["maxRejectStreak"]
        d["max_accept_streak"] = summary["mutationStats"]["maxAcceptStreak"]
        d["num_rejected_evals"] = summary["mutationStats"]["numRejectedEvals"]
        d["num_accepted_evals"] = summary["mutationStats"]["numAcceptedEvals"]
        d["max_step_size"] = summary["mutationStats"]["maxMutStepSize"]
        d["avg_step_size"] = summary["mutationStats"]["avgMutStepSize"]
        d["num_unique"] = summary["mutationStats"]["numUnique"]

    with open(state_path, "r") as f:
        state = json.load(f)
        assert state["ratio"] == d["ratio"]

        d["seed"] = state["seed"]

        d["time_validate"] = state["time"]["validate"]
        d["time_generate_cryptopt"] = state["time"]["generateCryptopt"]
        d["time_generate_fiat"] = state["time"]["generateFiat"]
        d["time_total"] = (
            d["time_validate"] + d["time_generate_cryptopt"] + d["time_generate_fiat"]
        )

        d["optimizer"] = state["parsedArgs"]["optimizer"]
        d["bridge"] = state["parsedArgs"]["bridge"]
        d["curve"] = state["parsedArgs"]["curve"]
        d["method"] = state["parsedArgs"]["method"]
        d["num_evals"] = state["parsedArgs"]["evals"]
        d["symbol"] = state["parsedArgs"]["symbolname"]

        d["bets"] = state["parsedArgs"]["bets"]
        d["bet_ratio"] = state["parsedArgs"]["betRatio"]

        # These are only relevant if optimizer == 'sa'
        d["sa_initial_temperature"] = state["parsedArgs"]["saInitialTemperature"]
        d["sa_visit_param"] = state["parsedArgs"]["saVisitParam"]
        d["sa_accept_param"] = state["parsedArgs"]["saAcceptParam"]
        d["sa_neighbor_strategy"] = state["parsedArgs"]["saNeighborStrategy"]
        d["sa_num_neighbors"] = state["parsedArgs"]["saNumNeighbors"]
        d["sa_step_size_param"] = state["parsedArgs"]["saStepSizeParam"]
        d["sa_mut_step_size_max"] = state["parsedArgs"]["saMutStepSizeMax"]
        d["sa_mut_step_size_min"] = state["parsedArgs"]["saMutStepSizeMin"]
        d["sa_mut_step_size_loc"] = state["parsedArgs"]["saMutStepSizeLoc"]
        d["sa_cooling_schedule"] = state["parsedArgs"]["saCoolingSchedule"]
        d["sa_reanneal_ratio"] = state["parsedArgs"]["saReannealRatio"]
        d["sa_reanneal_frequency"] = state["parsedArgs"]["saReannealFrequency"]

    with open(mutation_log, "r") as f:
        df = pd.read_csv(f)
        mut_log = df["kept"].to_numpy()
        reject_streaks = []
        accept_streaks = []
        current_reject_streak = 0
        current_accept_streak = 0
        for kept in mut_log:
            match kept:
                case 0:
                    if current_accept_streak > 0:
                        accept_streaks.append(current_accept_streak)
                        current_accept_streak = 0
                    current_reject_streak += 1
                case 1:
                    if current_reject_streak > 0:
                        reject_streaks.append(current_reject_streak)
                        current_reject_streak = 0
                    current_accept_streak += 1
                case n:
                    raise ValueError(f"unexpected value in mutation log: {n}")
        d["num_reject_streak"] = len(reject_streaks)
        d["num_accept_streak"] = len(accept_streaks)
        d["avg_reject_streak"] = np.average(reject_streaks)
        d["avg_accept_streak"] = np.average(accept_streaks)
        pass

    return d


if __name__ == "__main__":
    args = make_args()
    results_dir = Path(args.dir)
    with_suffix = lambda path, suffix: Path(
        str(path).removesuffix("".join(path.suffixes))
    ).with_suffix(suffix)
    runs = list(
        map(
            lambda r: (
                r,
                with_suffix(r, ".json"),  # State file
                with_suffix(r, ".csv"),  # Mutation log
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
            csvfile, fieldnames=make_row(runs[0]).keys(), quoting=csv.QUOTE_MINIMAL
        )
        w.writeheader()
        for run in runs:
            w.writerow(make_row(run))

    print(f"Done. Wrote {len(runs)} rows to {args.name}.csv.")
