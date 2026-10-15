//go:build wireinject

package di

import (
	"agent-kit/environment"
	"agent-kit/environment/local"
	"agent-kit/internal/runner"
	"agent-kit/remote"
	"github.com/google/wire"
)

func InitializeRunner(config runner.Config, streams runner.Streams) (*runner.Server, func(), error) {
	wire.Build(provideLogger, provideLocalEnvironments, provideRemoteBinding,
		provideEnvironmentManager, wire.Bind(new(environment.Directory), new(*environment.Manager)),
		runner.NewBusinessServer)
	return nil, nil, nil
}

func InitializeRemote(options RemoteOptions) (*remote.Server, error) {
	wire.Build(remoteLocalConfig, local.New, wire.Bind(new(remote.Target), new(*local.Environment)),
		remoteTargets, provideRemoteServer)
	return nil, nil
}
