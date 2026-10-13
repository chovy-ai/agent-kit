package local_test

import (
	"agent-kit/environment"
	"agent-kit/environment/local"
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func target(t *testing.T) *local.Environment {
	t.Helper()
	env, err := local.New(local.Config{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := env.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return env
}
func TestFilesystemBytesLimitsAndSymlinks(t *testing.T) {
	env := target(t)
	fs := env.Filesystem()
	ctx := context.Background()
	data := []byte{0, 255, 1, 2}
	if err := fs.WriteFile(ctx, "data", data); err != nil {
		t.Fatal(err)
	}
	out, err := fs.ReadFile(ctx, environment.ReadRequest{Path: "data", Offset: 1, Length: 2})
	if err != nil || !bytes.Equal(out, data[1:3]) {
		t.Fatalf("range: %v %v", out, err)
	}
	if err := fs.WriteFile(ctx, "data", make([]byte, 1<<20+1)); environment.Code(err) != "RESOURCE_EXHAUSTED" {
		t.Fatal(err)
	}
	out, _ = fs.ReadFile(ctx, environment.ReadRequest{Path: "data"})
	if !bytes.Equal(out, data) {
		t.Fatal("rejected write changed file")
	}
	if err := fs.WriteFile(ctx, "missing/file", []byte{}); environment.Code(err) != "NOT_FOUND" {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink("data", filepath.Join(env.DefaultCwd(), "link")); err != nil {
			t.Fatal(err)
		}
		info, err := fs.Stat(ctx, "link", false)
		if err != nil || info.Type != "symlink" {
			t.Fatalf("lstat: %+v %v", info, err)
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := fs.WriteFile(cancelled, "data", []byte("new")); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
func TestExecFilesOutputAndCancellation(t *testing.T) {
	env := target(t)
	if !env.BashAvailable() {
		t.Skip("Bash not installed")
	}
	ctx := context.Background()
	if err := env.Filesystem().WriteFile(ctx, "data", []byte("from-file")); err != nil {
		t.Fatal(err)
	}
	result, err := env.Process().Exec(ctx, environment.ExecRequest{Command: "cat data; printf error >&2; exit 7"}, nil)
	if err != nil || result.Completion != environment.Finished || result.ExitCode == nil || *result.ExitCode != 7 || string(result.Stdout) != "from-file" || string(result.Stderr) != "error" {
		t.Fatalf("result %+v %v", result, err)
	}
	result, err = env.Process().Exec(ctx, environment.ExecRequest{Command: "printf 123456789", MaxOutputBytes: 4}, nil)
	if err != nil || string(result.Stdout) != "1234" || !result.OutputTruncated {
		t.Fatalf("capture %+v %v", result, err)
	}
	result, err = env.Process().Exec(ctx, environment.ExecRequest{Command: "sleep 30 & wait", Timeout: 100 * time.Millisecond}, nil)
	if !errors.Is(err, context.DeadlineExceeded) || result.Completion != environment.Finished {
		t.Fatalf("cancel %+v %v", result, err)
	}
}
func TestCallbackFailureStopsScope(t *testing.T) {
	env := target(t)
	if !env.BashAvailable() {
		t.Skip("Bash not installed")
	}
	result, err := env.Process().Exec(context.Background(), environment.ExecRequest{Command: "printf ready; sleep 30"}, func(context.Context, environment.OutputChunk) error { return errors.New("consumer failed") })
	if environment.Code(err) != "OUTPUT_FAILED" || result.Completion != environment.Finished {
		t.Fatalf("callback %+v %v", result, err)
	}
}
