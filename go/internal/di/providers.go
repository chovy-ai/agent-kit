package di

import (
	"agent-kit/environment"
	"agent-kit/environment/local"
	"agent-kit/internal/runner"
	"agent-kit/remote"
	"context"
	"log/slog"
	"sync"
	"time"
)

func provideLogger(streams runner.Streams) *slog.Logger {
	return slog.New(slog.NewJSONHandler(streams.Logs, nil))
}

func cleanupEnvironment(target interface{ Close(context.Context) error }) func() {
	return sync.OnceFunc(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		target.Close(ctx)
	})
}

func provideLocalEnvironment(config runner.Config) (*local.Environment, func(), error) {
	target, err := local.New(local.Config{Cwd: config.Cwd, Bash: config.Bash})
	if err != nil {
		return nil, nil, err
	}
	return target, cleanupEnvironment(target), nil
}

// remoteBinding owns the optional connection and the environment borrowing it.
type remoteBinding struct {
	target environment.Environment
}

func provideRemoteBinding(config runner.Config) (*remoteBinding, func(), error) {
	if config.RemoteEndpoint == "" {
		return &remoteBinding{}, func() {}, nil
	}
	key := config.RemoteTarget
	if key == "" {
		key = "host"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := remote.Dial(ctx, config.RemoteEndpoint, []string{key})
	if err != nil {
		return nil, nil, err
	}
	target, err := client.Environment(key)
	if err != nil {
		client.Close()
		return nil, nil, err
	}
	closeTarget := cleanupEnvironment(target)
	cleanup := sync.OnceFunc(func() {
		closeTarget()
		client.Close()
	})
	return &remoteBinding{target: target}, cleanup, nil
}

func provideEnvironmentManager(localTarget *local.Environment, bound *remoteBinding) (*environment.Manager, error) {
	manager := environment.NewManager()
	if err := manager.Register("local", localTarget); err != nil {
		return nil, err
	}
	if bound.target != nil {
		if err := manager.Register("remote", bound.target); err != nil {
			return nil, err
		}
	}
	return manager, nil
}
