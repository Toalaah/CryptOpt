#!/usr/bin/env bash

RESULTS="./results-neighbors"

NEIGHBORS=(1 2 4 8 16 32)
CURVES=(curve25519 p521 p448_solinas poly1305 secp256k1_montgomery)
METHODS=(square mul)
OPTIMIZERS=(sa)

run_cryptopt() {
	optimizer="${1}"
	curve="${2}"
	method="${3}"
	neighbors="${4}"

	id=${optimizer}--${curve}--${method}--neighbors${4}
	result_dir="${RESULTS}/${id}"
	mkdir -p ${result_dir}

	extra_args=()
	if [[ "${optimizer}" == "sa" ]]; then
		extra_args=(--single)
	fi

	echo "$(date): Running: $id"
	start=$(date +%s)
	CryptOpt --optimizer ${optimizer} --curve ${curve} --method ${method} --saNumNeighbors ${neighbors} ${extra_args[@]} --resultDir "${result_dir}" >/dev/null 2>&1
	end=$(date +%s)
	runtime=$((end - start))
	echo "Took ${runtime}s"
	echo
}

for curve in ${CURVES[@]}; do
	for method in ${METHODS[@]}; do
		for neighbor in ${NEIGHBORS[@]}; do
			for optimizer in ${OPTIMIZERS[@]}; do
				run_cryptopt ${optimizer} ${curve} ${method} ${temp}
			done
		done
	done
done
