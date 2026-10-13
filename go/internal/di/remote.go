package di

import (
	"agent-kit/environment"
	"agent-kit/environment/local"
	"agent-kit/remote"
)

type RemoteOptions struct {
	TargetID string
	Local    local.Config
}

func remoteLocalConfig(options RemoteOptions) (local.Config, error) {
	if options.TargetID == "" || len(options.TargetID) > 128 {
		return local.Config{}, environment.Fail("INVALID_ARGUMENT", "invalid target id", nil)
	}
	return options.Local, nil
}

func remoteTargets(options RemoteOptions, target remote.Target) map[string]remote.Target {
	return map[string]remote.Target{options.TargetID: target}
}

func provideRemoteServer(targets map[string]remote.Target) (*remote.Server, error) {
	server, err := remote.NewServer(targets)
	if err != nil {
		for _, target := range targets {
			cleanupEnvironment(target)()
		}
		return nil, err
	}
	return server, nil
}
