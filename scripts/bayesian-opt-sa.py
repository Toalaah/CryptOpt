#!/usr/bin/env python3

import numpy as np
from bayes_opt import BayesianOptimization
from datetime import datetime
import json
from statistics import geometric_mean
import re
import subprocess

num_iter = 25
num_trials = 3
curve = "curve25519"
method = "square"
optimizer = "sa"
cooling_schedule = "exp"
evals = "10k"
neighbor_strategy = "greedy"
num_neighbors = np.float64(1)
max_step_size = np.float64(-1)


f = open("bayesian-stats.log", "w")

trial_num = 1


# https://stackoverflow.com/questions/14693701
def escape_ansi(line):
    ansi_escape = re.compile(r"(?:\x1B[@-_]|[\x80-\x9F])[0-?]*[ -/]*[@-~]")
    return ansi_escape.sub("", line)


def run_cryptopt(
    initial_temp: np.float64,
    # num_neighbors: np.float64,
    step_size_param: np.float64,
    # max_step_size: np.float64,
    visit_param: np.float64,
    accept_param: np.float64,
):
    global trial_num
    cmd = [
        "CryptOpt",
        f"--curve={curve}",
        f"--method={method}",
        f"--evals={evals}",
        f"--optimizer={optimizer}",
        f"--saInitialTemperature={initial_temp}",
        f"--saNumNeighbors={num_neighbors}",
        f"--saStepSizeParam={step_size_param}",
        f"--saMaxMutStepSize={max_step_size}",
        f"--saVisitParam={visit_param}",
        f"--saAcceptParam={accept_param}",
        f"--saCoolingSchedule={cooling_schedule}",
        f"--saNeighborStrategy={neighbor_strategy}",
    ]
    if optimizer == "sa":
        cmd.append("--single")
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    stdout = escape_ansi(result.stdout.decode())

    # m = re.search(r"Best epoch \(by ratio\).*\(ratio=", stdout)
    # if m is None:
    #     raise Exception("malformed stdout?")
    # ratio = np.float64(stdout[m.span()[1] :].strip().split(")")[0])

    m = re.search("Final ratio:.*\n", stdout)
    if m is None:
        raise Exception("malformed stdout?")
    ratio = np.float64(stdout[slice(*m.span())].strip().split(" ")[2])

    m = re.search(r"seed\d{16}.dat", stdout)
    if m is None:
        raise Exception("malformed stdout?")
    seed = stdout[slice(*m.span())].lstrip("seed").rstrip(".dat")

    f.write(f"iter: {trial_num}\n")
    f.write(
        f"\tseed: {seed}\n\tcurve={curve}\n\tmethod={method}\n\tevals={evals}\n\toptimizer={optimizer}\n\tsaInitialTemperature={initial_temp}\n\tsaAcceptParam={accept_param}\n\tsaNumNeighbors={num_neighbors}\n\tsaCoolingSchedule={cooling_schedule}\n\tsaStepSizeParam={step_size_param}\n\tsaMaxMutStepSize={max_step_size}\n\tsaNeighborStrategy={neighbor_strategy}\n\t"
    )
    f.write(f"\t=> ratio: {ratio}\n\n")
    f.flush()
    return ratio


def obj(
    initial_temp: np.float64,
    # num_neighbors: np.float64,
    step_size_param: np.float64,
    # max_step_size: np.float64,
    visit_param: np.float64,
    accept_param: np.float64,
):
    global trial_num
    x = []
    for _ in range(num_trials):
        x.append(
            run_cryptopt(
                initial_temp,
                # num_neighbors,
                step_size_param,
                # max_step_size,
                visit_param,
                accept_param,
            )
        )
    mean = geometric_mean(x)
    f.write(f"geo_avg (across {num_trials} trials): {mean}\n")
    f.flush()
    trial_num += 1
    return mean


pbounds = {
    "initial_temp": (5_000, 20_000),
    # "num_neighbors": (0, 7),
    "step_size_param": (0.001, 10),
    # "max_step_size": (-1, 20),
    "visit_param": (0.01, 10),
    "accept_param": (0.01, 10),
}

f.write(
    f"Performing Bayesian Optimization <trials per run: {num_trials}> <num iterations: {num_iter}> <time: {datetime.now()}>\n"
)

cryptopt_vars = {
    "curve": curve,
    "method": method,
    "optimizer": optimizer,
    "cooling_schedule": cooling_schedule,
    "evals": cooling_schedule,
    "neighbor_strategy": neighbor_strategy,
    "max_step_size": max_step_size,
    "num_neighbors": num_neighbors,
}
f.write(f"Using the following constant parameters: {json.dumps(cryptopt_vars)}\n")

f.write(f"Tuning following parameters w/ bounds: {json.dumps(pbounds)}\n")
f.flush()


bayes = BayesianOptimization(f=obj, pbounds=pbounds, random_state=None)
bayes.maximize(n_iter=num_iter)
f.write(f"Best performing parameters: {bayes.max}")
f.close()
print(bayes.max)
