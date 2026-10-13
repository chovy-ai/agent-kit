package remote

import (
	"agent-kit/environment"
	"context"
	"reflect"
)

// Target is the execution backend required by Server. Implementations need not
// depend on this package: Go's structural interfaces bind them at startup.
type Target interface {
	environment.Environment
	Platform() string
	DefaultCwd() string
	BashAvailable() bool
	Close(context.Context) error

	// RunProcess reports started only after the process scope exists. Callbacks
	// are serialized per invocation. Settled reports actual scope cleanup and
	// may run after an Unconfirmed return; it must never release ownership early.
	// An implementation may return NotStarted without invoking either callback.
	RunProcess(context.Context, environment.ExecRequest, environment.OutputHandler,
		func(), func(environment.ExecResult, error)) (environment.ExecResult, error)
}

func nilTarget(target Target) bool {
	if target == nil {
		return true
	}
	value := reflect.ValueOf(target)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}
