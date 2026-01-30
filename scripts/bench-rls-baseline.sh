#!/usr/bin/env bash

set -euo pipefail

RESULTS="./results-rls-baseline"

CURVES=(curve25519 p521 p448_solinas poly1305 secp256k1_montgomery)
METHODS=(square mul)
OPTIMIZERS=(rls)
EVALS=(1000 2000 3000 5000 10000 20000)

run_cryptopt() {
	curve="${1}"
	method="${2}"
	optimizer="${3}"
	evals="${4}"

	id=${optimizer}--${curve}--${method}--evals${evals}
	result_dir="${RESULTS}/${id}"
	mkdir -p ${result_dir}

	extra_args=()
	if [[ "${optimizer}" == "sa" ]]; then
		extra_args=(--single)
	fi

	echo "$(date): Running: $id"
	start=$(date +%s)
	CryptOpt --optimizer ${optimizer} --curve ${curve} --method ${method} --evals ${evals} ${extra_args[@]} --resultDir "${result_dir}" >/dev/null 2>&1
	end=$(date +%s)
	runtime=$((end - start))
	echo "Took ${runtime}s"
	echo
}

for curve in ${CURVES[@]}; do
	for method in ${METHODS[@]}; do
		for optimizer in ${OPTIMIZERS[@]}; do
			for evals in ${EVALS[@]}; do
				run_cryptopt ${curve} ${method} ${optimizer} ${evals}
			done
		done
	done
done
