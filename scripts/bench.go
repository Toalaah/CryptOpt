package main

import (
	"fmt"
	"log"
	"maps"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"gopkg.in/yaml.v3"
)

const numWorkers = 8

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
	SaVisitParam         *string `flag:"saVisitParam"`
	SaAcceptParam        *string `flag:"saAcceptParam"`
	SaStepSizeParam      *string `flag:"saStepSizeParam"`
	SaMaxMutStepSize     *string `flag:"saMaxMutStepSize"`
	SaCoolingSchedule    *string `flag:"saCoolingSchedule"`
	SaReannealRatio      *string `flag:"saReannealRatio"`
	Bets                 *string `flag:"bets"`
	BetRatio             *string `flag:"betRatio"`
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
		parts = append(parts, k+"="+params[k])
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

		if err := os.MkdirAll(run.ResultDir, 0755); err != nil {
			log.Printf("[CPU %d] Failed to create dir %s: %v", cpuID, run.ResultDir, err)
			continue
		}

		cmdArgs := append(
			[]string{"-c", strconv.Itoa(cpuID), "node", "./dist/CryptOpt.js"},
			run.cliArgs()...,
		)
		cmd := exec.Command("taskset", cmdArgs...)

		fmt.Printf("[CPU %d] %s: Running: %s\n", cpuID, time.Now().Format(time.DateTime), id)
		start := time.Now()

		if err := cmd.Run(); err != nil {
			count := completed.Add(1)
			log.Printf("[CPU %d] [%d/%d] Error running %s: %v", cpuID, count, total, id, err)
			continue
		}

		count := completed.Add(1)
		elapsed := time.Since(start).Round(time.Second)
		fmt.Printf("[CPU %d] [%d/%d] Completed %s (took %s)\n", cpuID, count, total, id, elapsed)
	}
}

func main() {
	if len(os.Args) < 2 {
		log.Fatal("Usage: go run scripts/bench.go <benchmark-name>")
	}
	benchName := os.Args[1]

	data, err := os.ReadFile("scripts/benchmarks.yml")
	if err != nil {
		log.Fatalf("Failed to read scripts/benchmarks.yml: %v", err)
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

	baseDir := fmt.Sprintf("./results-%s", benchName)
	runs := make([]Run, len(combos))
	for i, combo := range combos {
		runs[i] = makeRun(combo, baseDir)
	}

	rand.Shuffle(len(runs), func(i, j int) {
		runs[i], runs[j] = runs[j], runs[i]
	})

	fmt.Printf("Benchmark: %s\n", benchName)
	fmt.Printf("Total runs: %d\n", len(runs))
	fmt.Printf("Workers: %d (CPUs 0-%d)\n", numWorkers, numWorkers-1)
	fmt.Println()

	jobs := make(chan Run)
	var wg sync.WaitGroup
	var completed atomic.Int64

	for i := range numWorkers {
		wg.Add(1)
		go worker(i, jobs, &wg, len(runs), &completed)
	}

	for _, run := range runs {
		jobs <- run
	}
	close(jobs)

	wg.Wait()
	fmt.Println("All runs completed.")
}
