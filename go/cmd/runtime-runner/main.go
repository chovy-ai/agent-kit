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
	flag.Parse()
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
