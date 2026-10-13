// Package environment defines execution capabilities independently of transport and Pi.
package environment

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

type Environment interface {
	Filesystem() Filesystem
	Process() Process
}

// Directory exposes lookup without giving consumers registration or ownership.
type Directory interface {
	Get(string) (Environment, error)
	IDs() []string
}
type Filesystem interface {
	ReadFile(context.Context, ReadRequest) ([]byte, error)
	WriteFile(context.Context, string, []byte) error
	ReadDir(context.Context, string) ([]DirectoryEntry, error)
	Stat(context.Context, string, bool) (FileInfo, error)
	Mkdir(context.Context, string, bool) error
}
type ReadRequest struct {
	Path           string
	Offset, Length int64
}
type DirectoryEntry struct {
	Name string `json:"name"`
	Type string `json:"type"`
}
type FileInfo struct {
	Type       string    `json:"type"`
	Size       int64     `json:"size"`
	ModifiedAt time.Time `json:"modifiedAt"`
}
type Process interface {
	Exec(context.Context, ExecRequest, OutputHandler) (ExecResult, error)
}
type ExecRequest struct {
	Command, Cwd   string
	Env            map[string]string
	Timeout        time.Duration
	MaxOutputBytes int64
}
type OutputStream string

const (
	Stdout OutputStream = "stdout"
	Stderr OutputStream = "stderr"
)

type OutputChunk struct {
	Stream OutputStream
	Data   []byte
}
type OutputHandler func(context.Context, OutputChunk) error
type Completion string

const (
	NotStarted  Completion = "not_started"
	Finished    Completion = "finished"
	Unconfirmed Completion = "unconfirmed"
)

type ExecResult struct {
	Completion                        Completion
	ExitCode                          *int64
	Signal                            string
	Stdout, Stderr                    []byte
	OutputTruncated, OutputIncomplete bool
	Duration                          time.Duration
}

// Error preserves a stable category, underlying cause and possible file mutation.
type Error struct {
	Code, Reason   string
	MayHaveChanged bool
	Cause          error
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Reason, e.Cause)
	}
	return e.Code + ": " + e.Reason
}
func (e *Error) Unwrap() error { return e.Cause }
func Fail(code, reason string, cause error) error {
	return &Error{Code: code, Reason: reason, Cause: cause}
}
func Code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "DEADLINE_EXCEEDED"
	}
	if errors.Is(err, context.Canceled) {
		return "CANCELLED"
	}
	return "INTERNAL"
}

type Manager struct {
	mu     sync.RWMutex
	envs   map[string]Environment
	closed bool
}

var _ Directory = (*Manager)(nil)

func NewManager() *Manager { return &Manager{envs: make(map[string]Environment)} }
func (m *Manager) Register(id string, env Environment) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Fail("CONNECTION_CLOSED", "manager closed", nil)
	}
	if id == "" || env == nil {
		return Fail("INVALID_ARGUMENT", "environment id and implementation required", nil)
	}
	if _, exists := m.envs[id]; exists {
		return Fail("INVALID_ARGUMENT", "duplicate environment", nil)
	}
	m.envs[id] = env
	return nil
}
func (m *Manager) Get(id string) (Environment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.closed {
		return nil, Fail("CONNECTION_CLOSED", "manager closed", nil)
	}
	e, ok := m.envs[id]
	if !ok {
		return nil, Fail("NOT_FOUND", "unknown environment", nil)
	}
	return e, nil
}
func (m *Manager) IDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make([]string, 0, len(m.envs))
	for id := range m.envs {
		ids = append(ids, id)
	}
	return ids
}
func (m *Manager) Close(ctx context.Context) error {
	m.mu.Lock()
	m.closed = true
	envs := m.envs
	m.mu.Unlock()
	var errs []error
	for _, e := range envs {
		if c, ok := e.(interface{ Close(context.Context) error }); ok {
			errs = append(errs, c.Close(ctx))
		}
	}
	return errors.Join(errs...)
}
