package di

import (
	"agent-kit/environment"
	"agent-kit/environment/local"
	"agent-kit/internal/runner"
	"agent-kit/remote"
	"context"
	"fmt"
	"log/slog"
	"sort"
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

type localEnvironments map[string]*local.Environment

func provideLocalEnvironments(config runner.Config) (localEnvironments, func(), error) {
	definitions := config.Environments
	if definitions == nil {
		definitions = map[string]environment.Definition{"local": {Type: "local", Cwd: config.Cwd, Bash: config.Bash}}
	} else if config.Cwd != "" || config.Bash != "" || config.RemoteEndpoint != "" {
		return nil, nil, environment.Fail("INVALID_ARGUMENT", "named environments cannot be combined with legacy environment options", nil)
	}
	if err := environment.ValidateDefinitions(definitions); err != nil {
		return nil, nil, err
	}
	targets := localEnvironments{}
	cleanup := sync.OnceFunc(func() {
		for _, target := range targets {
			cleanupEnvironment(target)()
		}
	})
	names := make([]string, 0, len(definitions))
	for name := range definitions {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		definition := definitions[name]
		target, err := local.New(local.Config{Cwd: definition.Cwd, Bash: definition.Bash})
		if err != nil {
			cleanup()
			return nil, nil, fmt.Errorf("environment %q: %w", name, err)
		}
		targets[name] = target
	}
	return targets, cleanup, nil
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

func provideEnvironmentManager(localTargets localEnvironments, bound *remoteBinding) (*environment.Manager, error) {
	manager := environment.NewManager()
	for name, target := range localTargets {
		if err := manager.Register(name, target); err != nil {
			return nil, err
		}
	}
	if bound.target != nil {
		if err := manager.Register("remote", bound.target); err != nil {
			return nil, err
		}
	}
	return manager, nil
}
