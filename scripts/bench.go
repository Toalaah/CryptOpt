package main

import (
	"flag"
	"fmt"
	"log"
	"maps"
	"math/rand"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"
)

var (
	benchFile  = flag.String("f", "./scripts/benchmarks.yml", "path to the benchmark YAML file (env: $BENCHMARK_CONFIG)")
	numWorkers = flag.Int("j", runtime.NumCPU(), "number of parallel jobs (CPUs to use) (env: $BENCHMARK_NUM_WORKERS)")
	baseDir    = flag.String("b", ".", "relative path to where results should be stored (env: $BENCHMARK_BASE_DIR)")
	timeout    = flag.Duration("t", 90*time.Minute, "relative path to where results should be stored (env: $BENCHMARK_TIMEOUT)")
)

type Values []string

func (v *Values) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.SequenceNode {
		return fmt.Errorf("expected sequence, got %d", node.Kind)
	}
	*v = make(Values, len(node.Content))
	for i, item := range node.Content {
		(*v)[i] = item.Value
	}
	return nil
}

type Benchmark struct {
	Optimizer            *Values `yaml:"optimizer"`
	Method               *Values `yaml:"method"`
	Single               *Values `yaml:"single"`
	Curve                *Values `yaml:"curve"`
	Evals                *Values `yaml:"evals"`
	SaNumNeighbors       *Values `yaml:"saNumNeighbors"`
	SaNeighborStrategy   *Values `yaml:"saNeighborStrategy"`
	SaInitialTemperature *Values `yaml:"saInitialTemperature"`
	SaVisitParam         *Values `yaml:"saVisitParam"`
	SaAcceptParam        *Values `yaml:"saAcceptParam"`
	SaStepSizeParam      *Values `yaml:"saStepSizeParam"`
	SaMaxMutStepSize     *Values `yaml:"saMaxMutStepSize"`
	SaCoolingSchedule    *Values `yaml:"saCoolingSchedule"`
	SaReannealRatio      *Values `yaml:"saReannealRatio"`
	TabuUniqueFactorGoal *Values `yaml:"tabuUniqueFactorGoal"`
	BiasedUcbFactor      *Values `yaml:"biasedUcbFactor"`
	Bets                 *Values `yaml:"bets"`
	BetRatio             *Values `yaml:"betRatio"`
	Cyclegoal            *Values `yaml:"cyclegoal"`
}

type Run struct {
	Optimizer            *string `flag:"optimizer"`
	Method               *string `flag:"method"`
	Curve                *string `flag:"curve"`
	Evals                *string `flag:"evals"`
	SaNumNeighbors       *string `flag:"saNumNeighbors"`
	SaNeighborStrategy   *string `flag:"saNeighborStrategy"`
	SaInitialTemperature *string `flag:"saInitialTemperature"`
	TabuUniqueFactorGoal *string `flag:"tabuUniqueFactorGoal"`
	BiasedUcbFactor      *string `yaml:"biasedUcbFactor"`
	SaVisitParam         *string `flag:"saVisitParam"`
	SaAcceptParam        *string `flag:"saAcceptParam"`
	SaStepSizeParam      *string `flag:"saStepSizeParam"`
	SaMaxMutStepSize     *string `flag:"saMaxMutStepSize"`
	SaCoolingSchedule    *string `flag:"saCoolingSchedule"`
	SaReannealRatio      *string `flag:"saReannealRatio"`
	Bets                 *string `flag:"bets"`
	BetRatio             *string `flag:"betRatio"`
	Single               *string `flag:"single"`
	Cyclegoal            *string `flag:"cyclegoal"`
	ResultDir            string  `flag:"-"`
}

type paramField struct {
	flagName string
	values   Values
}

func getActiveFields(b Benchmark) []paramField {
	v := reflect.ValueOf(b)
	t := v.Type()
	var fields []paramField
	for i := 0; i < v.NumField(); i++ {
		field := v.Field(i)
		if field.IsNil() {
			continue
		}
		tag := t.Field(i).Tag.Get("yaml")
		vals := field.Elem().Interface().(Values)
		fields = append(fields, paramField{flagName: tag, values: vals})
	}
	return fields
}

func crossProduct(fields []paramField) []map[string]string {
	if len(fields) == 0 {
		return []map[string]string{{}}
	}
	first := fields[0]
	rest := crossProduct(fields[1:])
	result := make([]map[string]string, 0, len(first.values)*len(rest))
	for _, val := range first.values {
		for _, r := range rest {
			m := make(map[string]string, len(r)+1)
			maps.Copy(m, r)
			m[first.flagName] = val
			result = append(result, m)
		}
	}
	return result
}

func makeRunID(params map[string]string) string {
	standardOrder := []string{"optimizer", "curve", "method"}
	var parts []string
	used := make(map[string]bool)

	for _, key := range standardOrder {
		if v, ok := params[key]; ok {
			parts = append(parts, v)
			used[key] = true
		}
	}

	var extra []string
	for k := range params {
		if !used[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	for _, k := range extra {
		if params[k] == "" {
			parts = append(parts, k)
		} else {
			parts = append(parts, k+"="+params[k])
		}
	}

	return strings.Join(parts, "--")
}

func makeRun(params map[string]string, baseDir string) Run {
	r := Run{}
	rv := reflect.ValueOf(&r).Elem()
	rt := rv.Type()
	for i := 0; i < rv.NumField(); i++ {
		tag := rt.Field(i).Tag.Get("flag")
		if tag == "" || tag == "-" {
			continue
		}
		if v, ok := params[tag]; ok {
			rv.Field(i).Set(reflect.ValueOf(&v))
		}
	}
	r.ResultDir = filepath.Join(baseDir, makeRunID(params))
	return r
}

func (r Run) cliArgs() []string {
	var args []string
	rv := reflect.ValueOf(r)
	rt := rv.Type()
	for i := 0; i < rv.NumField(); i++ {
		tag := rt.Field(i).Tag.Get("flag")
		if tag == "" || tag == "-" {
			continue
		}
		field := rv.Field(i)
		if field.IsNil() {
			continue
		}
		args = append(args, "--"+tag, field.Elem().String())
	}
	if r.Optimizer != nil && *r.Optimizer == "sa" {
		args = append(args, "--single")
	}
	args = append(args, "--resultDir", r.ResultDir)
	return args
}

func worker(cpuID int, jobs <-chan Run, wg *sync.WaitGroup, total int, completed *atomic.Int64) {
	defer wg.Done()
	for run := range jobs {
		id := filepath.Base(run.ResultDir)

		if _, err := os.Stat(run.ResultDir); err == nil {
			count := completed.Add(1)
			fmt.Printf("[CPU %d] [%d/%d] Skipping (already exists): %s\n", cpuID, count, total, id)
			continue
		}

		// Use a sibling temp dir so the final rename is on the same filesystem
		// (avoids cross-device link errors from os.Rename).
		tmpDir, err := os.MkdirTemp(filepath.Dir(run.ResultDir), ".tmp-cryptopt-bench-*")
		if err != nil {
			log.Printf("[CPU %d] Failed to create temp dir for %s: %v", cpuID, id, err)
			continue
		}

		// Point the run at the temp dir for the duration of the process.
		tmpRun := run
		tmpRun.ResultDir = tmpDir

		cmdArgs := append(
			[]string{"-c", strconv.Itoa(cpuID), "node", "./dist/CryptOpt.js"},
			tmpRun.cliArgs()...,
		)
		cmd := exec.Command("taskset", cmdArgs...)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

		// https://jarv.org/posts/command-with-timeout/
		type cmdResult struct {
			outb []byte
			err  error
		}

		cmdDone := make(chan cmdResult, 1)
		fmt.Printf("[CPU %d] %s: Running: %s\n", cpuID, time.Now().Format(time.DateTime), id)
		start := time.Now()
		go func() {
			outb, err := cmd.CombinedOutput()
			cmdDone <- cmdResult{outb, err}
		}()

		select {
		case <-time.After(*timeout):
			syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			count := completed.Add(1)
			log.Printf("[CPU %d] [%d/%d] timed out running %s", cpuID, count, total, id)
			os.RemoveAll(tmpDir)
			continue
		case res := <-cmdDone:
			if err := res.err; err != nil {
				count := completed.Add(1)
				log.Printf("[CPU %d] [%d/%d] Error running %s: %v", cpuID, count, total, id, err)
				os.RemoveAll(tmpDir)
				continue
			}
		}

		// Process exited cleanly — atomically promote the temp dir to the final location.
		// If the target already exists (e.g. a duplicate trial), append _1, _2, … until a free slot.
		finalDir := run.ResultDir
		renameFailed := false
		for i := 1; ; i++ {
			if err := os.Rename(tmpDir, finalDir); err == nil {
				break
			} else if _, statErr := os.Stat(finalDir); statErr != nil {
				// Destination does not exist — some other unexpected error.
				log.Printf("[CPU %d] Failed to move result dir to %s: %v", cpuID, run.ResultDir, err)
				os.RemoveAll(tmpDir)
				renameFailed = true
				break
			}
			finalDir = fmt.Sprintf("%s_%d", run.ResultDir, i)
		}
		if renameFailed {
			continue
		}

		count := completed.Add(1)
		elapsed := time.Since(start).Round(time.Second)
		fmt.Printf("[CPU %d] [%d/%d] Completed %s (took %s)\n", cpuID, count, total, filepath.Base(finalDir), elapsed)
	}
}

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: %s [flags] <benchmark-name>\n\nFlags:\n", os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()

	if flag.NArg() < 1 {
		flag.Usage()
		os.Exit(1)
	}
	benchName := flag.Arg(0)

	if path, ok := os.LookupEnv("BENCHMARK_BASE_DIR"); ok {
		*baseDir = path
	}

	if path, ok := os.LookupEnv("BENCHMARK_CONFIG"); ok {
		*benchFile = path
	}

	if t, ok := os.LookupEnv("BENCHMARK_TIMEOUT"); ok {
		d, err := time.ParseDuration(t)
		if err != nil {
			log.Fatalf("Failed to parse timeout from env: %v", err)
		}
		*timeout = d
	}

	if val, ok := os.LookupEnv("BENCHMARK_NUM_WORKERS"); ok {
		n, err := strconv.ParseUint(val, 10, 32)
		if err != nil {
			log.Fatalf("Failed to parse num workers from env: %v", err)
		}
		*numWorkers = int(n)
	}

	data, err := os.ReadFile(*benchFile)
	if err != nil {
		log.Fatalf("Failed to read %s: %v", *benchFile, err)
	}

	var benchmarks map[string]Benchmark
	if err := yaml.Unmarshal(data, &benchmarks); err != nil {
		log.Fatalf("Failed to parse benchmarks.yml: %v", err)
	}

	bench, ok := benchmarks[benchName]
	if !ok {
		available := make([]string, 0, len(benchmarks))
		for k := range benchmarks {
			available = append(available, k)
		}
		sort.Strings(available)
		log.Fatalf("Unknown benchmark %q. Available: %s", benchName, strings.Join(available, ", "))
	}

	fields := getActiveFields(bench)
	combos := crossProduct(fields)

	baseDir := path.Join(*baseDir, fmt.Sprintf("./results-%s", benchName))
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		log.Fatalf("Failed to create results directory: %v", err)
	}
	runs := make([]Run, len(combos))
	for i, combo := range combos {
		runs[i] = makeRun(combo, baseDir)
	}

	rand.Shuffle(len(runs), func(i, j int) {
		runs[i], runs[j] = runs[j], runs[i]
	})

	fmt.Printf("Benchmark: %s\n", benchName)
	fmt.Printf("Total runs: %d\n", len(runs))
	fmt.Printf("Workers: %d (CPUs 0-%d)\n", *numWorkers, *numWorkers-1)
	fmt.Println()

	jobs := make(chan Run)
	var wg sync.WaitGroup
	var completed atomic.Int64

	for i := range *numWorkers {
		wg.Add(1)
		go worker(i, jobs, &wg, len(runs), &completed)
	}

	for _, run := range runs {
		jobs <- run
		time.Sleep(time.Millisecond * 250)
	}
	close(jobs)

	wg.Wait()
	fmt.Println("All runs completed.")
}
