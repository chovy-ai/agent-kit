package runner

import (
	"agent-kit/environment"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
)

// The consumer can be constructed with a directory that is not Manager.
type testDirectory struct {
	target environment.Environment
}

func (d testDirectory) IDs() []string { return []string{"custom"} }
func (d testDirectory) Get(key string) (environment.Environment, error) {
	if key != "custom" {
		return nil, environment.Fail("NOT_FOUND", "unknown environment", nil)
	}
	return d.target, nil
}

type testEnvironment struct {
	files environment.Filesystem
}

func (e testEnvironment) Filesystem() environment.Filesystem { return e.files }
func (e testEnvironment) Process() environment.Process       { return nil }

type readingFilesystem struct {
	environment.Filesystem
	path string
}

func (f *readingFilesystem) ReadFile(_ context.Context, req environment.ReadRequest) ([]byte, error) {
	f.path = req.Path
	return []byte{0, 255, 42}, nil
}

func TestBusinessServerUsesInjectedDirectoryAndFilesystem(t *testing.T) {
	files := &readingFilesystem{}
	directory := testDirectory{target: testEnvironment{files: files}}
	server, err := NewBusinessServer(DefaultConfig(), Streams{Input: strings.NewReader(""), Output: io.Discard, Logs: io.Discard}, slog.Default(), directory)
	if err != nil {
		t.Fatal(err)
	}
	list, failure := server.handle(context.Background(), Request{Method: "environment.list"})
	if failure != nil || list.(map[string]any)["environments"].([]string)[0] != "custom" {
		t.Fatalf("injected discovery failed: %v %v", list, failure)
	}
	result, failure := server.handle(context.Background(), Request{Method: "filesystem.read", Params: json.RawMessage(`{"environmentId":"custom","path":"virtual"}`)})
	if failure != nil || files.path != "virtual" || len(result.(map[string]any)["data"].([]byte)) != 3 {
		t.Fatalf("injected read failed: %v %v", result, failure)
	}
	_, failure = server.handle(context.Background(), Request{Method: "filesystem.read", Params: json.RawMessage(`{"environmentId":"missing","path":"virtual"}`)})
	if failure == nil || failure.Code != "NOT_FOUND" {
		t.Fatalf("lookup error lost: %v", failure)
	}
}
