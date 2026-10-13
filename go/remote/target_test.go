package remote_test

import (
	"agent-kit/environment"
	"agent-kit/remote"
	"bytes"
	"context"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A replacement backend has no dependency on Local or the execution engine.
type customTarget struct {
	files    virtualFiles
	platform string
	started  atomic.Int32
	settled  atomic.Int32
	closed   atomic.Bool
}

var _ remote.Target = (*customTarget)(nil)

func (t *customTarget) Filesystem() environment.Filesystem { return &t.files }
func (t *customTarget) Process() environment.Process       { return t }
func (t *customTarget) DefaultCwd() string                 { return `C:\virtual` }
func (t *customTarget) BashAvailable() bool                { return true }
func (t *customTarget) Platform() string                   { return t.platform }
func (t *customTarget) Close(context.Context) error {
	t.closed.Store(true)
	return nil
}
func (t *customTarget) Exec(ctx context.Context, req environment.ExecRequest, out environment.OutputHandler) (environment.ExecResult, error) {
	return t.RunProcess(ctx, req, out, nil, nil)
}
func (t *customTarget) RunProcess(ctx context.Context, req environment.ExecRequest, out environment.OutputHandler, started func(), settled func(environment.ExecResult, error)) (environment.ExecResult, error) {
	if started != nil {
		t.started.Add(1)
		started()
	}
	data := []byte("custom:" + req.Command)
	var err error
	if out != nil {
		err = out(ctx, environment.OutputChunk{Stream: environment.Stdout, Data: data})
	}
	zero := int64(0)
	result := environment.ExecResult{Completion: environment.Finished, ExitCode: &zero, Stdout: data, Duration: time.Millisecond}
	if settled != nil {
		t.settled.Add(1)
		settled(result, err)
	}
	return result, err
}

type virtualFiles struct {
	environment.Filesystem
	mu   sync.Mutex
	data map[string][]byte
}

func (f *virtualFiles) WriteFile(_ context.Context, path string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.data == nil {
		f.data = map[string][]byte{}
	}
	f.data[path] = bytes.Clone(data)
	return nil
}
func (f *virtualFiles) ReadFile(_ context.Context, req environment.ReadRequest) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.data[req.Path]
	if !ok {
		return nil, environment.Fail("NOT_FOUND", "virtual file missing", nil)
	}
	start := min(req.Offset, int64(len(data)))
	end := int64(len(data))
	if req.Length > 0 {
		end = min(end, start+req.Length)
	}
	return bytes.Clone(data[start:end]), nil
}

func TestServerAcceptsIndependentExecutionBackend(t *testing.T) {
	target := &customTarget{platform: "windows"}
	server, err := remote.NewServer(map[string]remote.Target{"custom": target})
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	defer server.Close(ctx)
	client, err := remote.Dial(ctx, "ws"+httpServer.URL[4:], []string{"custom"})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	env, err := client.Environment("custom")
	if err != nil {
		t.Fatal(err)
	}
	defer env.Close(ctx)
	data := []byte{0, 255, 42}
	if err = env.Filesystem().WriteFile(ctx, "virtual", data); err != nil {
		t.Fatal(err)
	}
	read, err := env.Filesystem().ReadFile(ctx, environment.ReadRequest{Path: "virtual"})
	if err != nil || !bytes.Equal(read, data) {
		t.Fatalf("replacement filesystem lost bytes: %v %v", read, err)
	}
	var output []byte
	result, err := env.Process().Exec(ctx, environment.ExecRequest{Command: "action"}, func(_ context.Context, chunk environment.OutputChunk) error {
		output = append(output, chunk.Data...)
		return nil
	})
	if err != nil || result.Completion != environment.Finished || string(result.Stdout) != "custom:action" || !bytes.Equal(result.Stdout, output) {
		t.Fatalf("replacement process lost output or completion: %v %v", result, err)
	}
	if target.started.Load() != 1 || target.settled.Load() != 1 {
		t.Fatal("server did not use the backend lifecycle callbacks")
	}
	if err := server.Close(ctx); err != nil || !target.closed.Load() {
		t.Fatalf("server did not close its owned backend: %v", err)
	}
}

func TestServerUsesBackendPlatformAndRejectsTypedNil(t *testing.T) {
	var missing *customTarget
	if _, err := remote.NewServer(map[string]remote.Target{"nil": missing}); environment.Code(err) != "INVALID_ARGUMENT" {
		t.Fatalf("typed-nil backend was accepted: %v", err)
	}
	server, err := remote.NewServer(map[string]remote.Target{"custom": &customTarget{platform: "unsupported"}})
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	defer server.Close(context.Background())
	if _, err := remote.Dial(context.Background(), "ws"+httpServer.URL[4:], []string{"custom"}); environment.Code(err) != "FAILED_PRECONDITION" {
		t.Fatalf("server advertised its own platform instead of the backend's: %v", err)
	}
}
