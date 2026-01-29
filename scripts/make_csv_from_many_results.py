#!/usr/bin/env python3

from pathlib import Path
import json
import os
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


def make_row(run: tuple[Path, Path]) -> dict:
    d = {}
    summary_path, state_path = run
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
        d["betRatio"] = state["parsedArgs"]["betRatio"]

        # These are only relevant if optimizer == 'sa'
        d["sa_initial_temperature"] = state["parsedArgs"]["saInitialTemperature"]
        d["sa_visit_param"] = state["parsedArgs"]["saVisitParam"]
        d["sa_accept_param"] = state["parsedArgs"]["saAcceptParam"]
        d["sa_neighbor_strategy"] = state["parsedArgs"]["saNeighborStrategy"]
        d["sa_num_neighbors"] = state["parsedArgs"]["saNumNeighbors"]
        d["sa_step_size_param"] = state["parsedArgs"]["saStepSizeParam"]
        d["sa_max_mut_step_size"] = state["parsedArgs"]["saMaxMutStepSize"]
        d["sa_cooling_schedule"] = state["parsedArgs"]["saCoolingSchedule"]

    return d


if __name__ == "__main__":
    args = make_args()
    results_dir = Path(args.dir)
    runs = list(
        map(
            lambda r: (
                r,
                Path(str(r).removesuffix("".join(r.suffixes))).with_suffix(".json"),
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
