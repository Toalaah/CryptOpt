#!/usr/bin/env python3

import pandas as pd
import os
import argparse


def valid_csv_file(value):
    try:
        df = pd.read_csv(value)
        return df
    except Exception as e:
        raise argparse.ArgumentTypeError(f"failed to parse CSV: {e}")


def make_args():
    parser = argparse.ArgumentParser(
        description="Merges multiple mega CSVs into one, averaging the specified values."
    )
    parser.add_argument("--name", "-n", default="run", help="name of output file")
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="force overwrite of output file if it already exists",
    )
    parser.add_argument(
        "--group-by",
        "-g",
        type=lambda s: [str(item) for item in s.replace(" ", ",").split(",")],
        required=True,
        help="group rows to average by the following fields",
    )
    parser.add_argument(
        "--min",
        type=lambda s: [str(item) for item in s.replace(" ", ",").split(",")],
        default=[],
        help="fields to min for grouped rows",
    )
    parser.add_argument(
        "--max",
        type=lambda s: [str(item) for item in s.replace(" ", ",").split(",")],
        default=[],
        help="fields to max for grouped rows",
    )
    parser.add_argument(
        "--average",
        "-a",
        type=lambda s: [str(item) for item in s.replace(" ", ",").split(",")],
        default=[],
        help="fields to average for grouped rows",
    )
    parser.add_argument("files", nargs="+", type=valid_csv_file)
    return parser.parse_args()


if __name__ == "__main__":
    args = make_args()
    df = pd.concat(args.files)
    agg = {}
    for col in df.columns:
        if col in args.average:
            agg[col] = "mean"
        elif col in args.min:
            agg[col] = "min"
        elif col in args.max:
            agg[col] = "min"
        else:
            agg[col] = "first"

    if args.group_by:
        df = df.groupby(args.group_by, as_index=False).agg(agg)

    if os.path.exists(f"{args.name}.csv") and not args.force:
        print(
            f"File {args.name}.csv already exists. Refusing to continue without -f/--force."
        )
        exit(1)

    df.to_csv(f"{args.name}.csv")
