package main

import (
	"agent-kit/internal/di"
	"agent-kit/internal/runner"
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func run() error {
	config := runner.DefaultConfig()
	flag.IntVar(&config.MaxMessageBytes, "max-message-bytes", config.MaxMessageBytes, "Maximum JSON request size")
	flag.IntVar(&config.MaxConcurrent, "max-concurrent", config.MaxConcurrent, "Maximum concurrent ordinary requests")
	flag.StringVar(&config.Cwd, "cwd", "", "Local default directory")
	flag.StringVar(&config.Bash, "bash", "", "Local Bash executable")
	flag.StringVar(&config.RemoteEndpoint, "remote-endpoint", "", "Remote WS endpoint")
	flag.StringVar(&config.RemoteTarget, "remote-target", "host", "Remote target ID")
	configPath := flag.String("config", "", "Named local environments JSON file")
	environmentsJSON := flag.String("environments-json", "", "Inline named local environments JSON")
	flag.Parse()
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments")
	}
	provided := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { provided[f.Name] = true })
	if provided["config"] || provided["environments-json"] {
		if provided["config"] && provided["environments-json"] {
			return fmt.Errorf("config and environments-json cannot be combined")
		}
		if provided["config"] && *configPath == "" || provided["environments-json"] && *environmentsJSON == "" {
			return fmt.Errorf("environment configuration must be non-empty")
		}
		var conflict string
		flag.Visit(func(f *flag.Flag) {
			if f.Name == "cwd" || f.Name == "bash" || f.Name == "remote-endpoint" || f.Name == "remote-target" {
				conflict = f.Name
			}
		})
		if conflict != "" {
			return fmt.Errorf("named environments cannot be combined with --%s", conflict)
		}
		var err error
		if *configPath != "" {
			config.Environments, err = runner.LoadEnvironmentConfig(*configPath)
		} else {
			cwd, cwdErr := os.Getwd()
			if cwdErr != nil {
				return cwdErr
			}
			config.Environments, err = runner.ParseEnvironmentConfig([]byte(*environmentsJSON), cwd)
		}
		if err != nil {
			return err
		}
	}
	server, cleanup, err := di.InitializeRunner(config, runner.Streams{Input: os.Stdin, Output: os.Stdout, Logs: os.Stderr})
	if err != nil {
		return err
	}
	defer cleanup()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := server.Serve(ctx); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
