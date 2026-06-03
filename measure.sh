#!/usr/bin/env bash

set -eou pipefail

file="$1"

taskset -c 0 node ./dist/CountCycle.js "$(realpath $file)"
