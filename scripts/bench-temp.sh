#!/usr/bin/env bash

RESULTS="./results-temp"

TEMPS=(1000 2000 5000 10000 20000 30000 50000 70000 100000)
CURVES=(curve25519 p521 p448_solinas poly1305 secp256k1_montgomery)
METHODS=(square mul)
OPTIMIZERS=(sa)

run_cryptopt() {
	optimizer="${1}"
	curve="${2}"
	method="${3}"
	temp="${4}"

	id=${optimizer}--${curve}--${method}--temp${temp}
	result_dir="${RESULTS}/${id}"
	mkdir -p ${result_dir}

	extra_args=()
	if [[ "${optimizer}" == "sa" ]]; then
		extra_args=(--single)
	fi

	echo "$(date): Running: $id"
	start=$(date +%s)
	CryptOpt --optimizer ${optimizer} --curve ${curve} --method ${method} --saInitialTemperature ${temp} ${extra_args[@]} --resultDir "${result_dir}" >/dev/null 2>&1
	end=$(date +%s)
	runtime=$((end - start))
	echo "Took ${runtime}s"
	echo
}

for curve in ${CURVES[@]}; do
	for method in ${METHODS[@]}; do
		for temp in ${TEMPS[@]}; do
			for optimizer in ${OPTIMIZERS[@]}; do
				run_cryptopt ${optimizer} ${curve} ${method} ${temp}
			done
		done
	done
done
