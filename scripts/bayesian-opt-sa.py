#!/usr/bin/env python3

import numpy as np
from bayes_opt import BayesianOptimization
from statistics import geometric_mean
import re
import subprocess

curve = "curve25519"
method = "square"
optimizer = "sa"
# optimizer = "rls"
cooling_schedule = "exp"
evals = "10k"
num_trials = 3
neighbor_strategy = "greedy"

# Params to tune.
# initial_temp = np.float64(5230)  # > 0
# visit_param = np.float64(1.64)  # > 1
# accept_param = np.float64(6)  #  > 0  (less than 0 implies greedy acceptance ~ rls)
# num_neighbors = np.float64(2)  # >= 2
# step_size_param = np.float64(712)

# max_step_size = -1
# energy_param = np.float64(1) # > 0

f = open("bayesian-stats.log", "w")


def run_cryptopt(
    initial_temp: np.float64,
    # visit_param: np.float64,
    accept_param: np.float64,
    num_neighbors: np.float64,
    step_size_param: np.float64,
):
    cmd = [
        "CryptOpt",
        f"--curve={curve}",
        f"--method={method}",
        f"--evals={evals}",
        f"--optimizer={optimizer}",
        f"--saInitialTemperature={initial_temp}",
        #   f"--saVisitParam={visit_param}",
        f"--saAcceptParam={accept_param}",
        f"--saNumNeighbors={num_neighbors}",
        f"--saCoolingSchedule={cooling_schedule}",
        f"--saStepSizeParam={step_size_param}",
        f"--saNeighborStrategy={neighbor_strategy}",
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE)
    stdout = result.stdout.decode()

    m = re.search("Ratio:.*\n", stdout)
    if m is None:
        raise Exception("malformed stdout?")
    ratio = np.float64(stdout[slice(*m.span())].strip().split(" ")[1])

    m = re.search(r"seed\d{16}.dat", stdout)
    if m is None:
        raise Exception("malformed stdout?")
    seed = stdout[slice(*m.span())].lstrip("seed").rstrip(".dat")

    f.write(
        f"ratio: {ratio} seed: {seed} curve={curve} method={method} evals={evals} optimizer={optimizer} saInitialTemperature={initial_temp} saAcceptParam={accept_param} saNumNeighbors={num_neighbors} saCoolingSchedule={cooling_schedule} saStepSizeParam={step_size_param} saNeighborStrategy={neighbor_strategy}\n"
    )
    return ratio


def obj(
    initial_temp: np.float64,
    # visit_param: np.float64,
    accept_param: np.float64,
    num_neighbors: np.float64,
    step_size_param: np.float64,
):
    x = []
    for _ in range(num_trials):
        x.append(
            run_cryptopt(initial_temp, accept_param, num_neighbors, step_size_param)
        )
    mean = geometric_mean(x)
    f.write(f"avg: {mean}\n")
    return mean


pbounds = {
    "initial_temp": (10_000, 25_000),
    # "visit_param": (1, 10),
    "accept_param": (1, 10),
    "num_neighbors": (4, 7),
    "step_size_param": (9_000, 15_000),
}


bayes = BayesianOptimization(f=obj, pbounds=pbounds, random_state=None)
bayes.maximize(n_iter=25)
f.write(f"max: {bayes.max}")
print(bayes.max)
f.close()
