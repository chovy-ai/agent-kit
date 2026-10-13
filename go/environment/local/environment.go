// Package local adapts capabilities to the calling process's host.
package local

import (
	"agent-kit/environment"
	"agent-kit/internal/execution"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
)

type Config struct {
	Cwd, Bash string
	Env       []string
}
type Environment struct {
	cwd    string
	engine *execution.Engine
	files  *filesystem
	mu     sync.RWMutex
	closed bool
	ctx    context.Context
	cancel context.CancelFunc
	active sync.WaitGroup
}

func New(config Config) (*Environment, error) {
	cwd := config.Cwd
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}
	cwd, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(cwd)
	if err != nil || !info.IsDir() {
		return nil, environment.Fail("INVALID_ARGUMENT", "default cwd must be a directory", err)
	}
	bash := config.Bash
	if bash == "" && runtime.GOOS != "windows" {
		bash, _ = exec.LookPath("bash")
	} else if bash != "" {
		bash, err = exec.LookPath(bash)
		if err != nil {
			return nil, err
		}
	}
	if bash != "" {
		bash, err = filepath.Abs(bash)
		if err != nil {
			return nil, err
		}
	}
	base := config.Env
	if base == nil {
		base = os.Environ()
	}
	ctx, cancel := context.WithCancel(context.Background())
	e := &Environment{cwd: cwd, engine: execution.New(cwd, bash, base), ctx: ctx, cancel: cancel}
	e.files = &filesystem{env: e}
	return e, nil
}
func (e *Environment) Filesystem() environment.Filesystem { return e.files }
func (e *Environment) Process() environment.Process       { return e.engine }

// RunProcess exposes lifecycle notifications without exposing the execution engine.
func (e *Environment) RunProcess(ctx context.Context, req environment.ExecRequest, out environment.OutputHandler, started func(), settled func(environment.ExecResult, error)) (environment.ExecResult, error) {
	return e.engine.Run(ctx, req, out, started, settled)
}
func (e *Environment) Platform() string    { return runtime.GOOS }
func (e *Environment) BashAvailable() bool { return e.engine.Bash != "" }
func (e *Environment) DefaultCwd() string  { return e.cwd }
func (e *Environment) check(ctx context.Context) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.closed {
		return environment.Fail("CONNECTION_CLOSED", "environment closed", nil)
	}
	return nil
}
func (e *Environment) Close(ctx context.Context) error {
	e.mu.Lock()
	e.closed = true
	e.cancel()
	e.mu.Unlock()
	err := e.engine.Close(ctx)
	done := make(chan struct{})
	go func() { e.active.Wait(); close(done) }()
	select {
	case <-done:
		return err
	case <-ctx.Done():
		return environment.Fail("OUTCOME_UNKNOWN", "local file operation cleanup not confirmed", ctx.Err())
	}
}

func (e *Environment) operation(ctx context.Context) (context.Context, func(), error) {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return nil, nil, environment.Fail("CONNECTION_CLOSED", "local environment closed", nil)
	}
	e.active.Add(1)
	e.mu.Unlock()
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(e.ctx, cancel)
	return ctx, func() { stop(); cancel(); e.active.Done() }, nil
}
