package di

import (
	"agent-kit/environment"
	"agent-kit/internal/runner"
	"context"
	"io"
	"strings"
	"testing"
)

func TestGeneratedInjectorValidatesConfiguration(t *testing.T) {
	streams := runner.Streams{Input: strings.NewReader(""), Output: io.Discard, Logs: io.Discard}
	_, cleanup, err := InitializeRunner(runner.DefaultConfig(), streams)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	config := runner.DefaultConfig()
	config.MaxConcurrent = 0
	if _, _, err := InitializeRunner(config, streams); err == nil {
		t.Fatal("generated injector lost the provider's initialization error")
	}
}

func TestProviderCleanupClosesItsEnvironmentOnce(t *testing.T) {
	config := runner.DefaultConfig()
	config.Cwd = t.TempDir()
	target, cleanup, err := provideLocalEnvironment(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	if err = target.Filesystem().WriteFile(context.Background(), "before", []byte("data")); err != nil {
		t.Fatal(err)
	}
	cleanup()
	cleanup()
	if _, err = target.Filesystem().ReadFile(context.Background(), environment.ReadRequest{Path: "before"}); environment.Code(err) != "CONNECTION_CLOSED" {
		t.Fatalf("closed provider left its environment available: %v", err)
	}
}
