#!/usr/bin/env bash

results_dir="$1"

if [[ ! -d "$results_dir" ]]; then
	echo "Bad dir: $results_dir"
	exit 1
fi

seeds_to_keep=$(
	find "$results_dir" -name '*.summary.json' |
		grep -oP 'seed[0-9]+' |
		sed 's,^seed,,' |
		tr '\n' '|' |
		sed 's,|$,,'
)

seeds_to_remove="$(find "$results_dir" -type f | grep -v -E "$seeds_to_keep")"
rm $seeds_to_remove
find "$results_dir" -name "*.pdf" -exec rm {} \;
