package execution

import (
	"agent-kit/environment"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Engine struct {
	Cwd, Bash string
	BaseEnv   []string
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	closed    bool
	active    sync.WaitGroup
	slots     chan struct{}
}

func New(cwd, bash string, base []string) *Engine {
	ctx, cancel := context.WithCancel(context.Background())
	return &Engine{Cwd: cwd, Bash: bash, BaseEnv: append([]string{}, base...), ctx: ctx, cancel: cancel, slots: make(chan struct{}, 16)}
}
func (e *Engine) Close(ctx context.Context) error {
	e.mu.Lock()
	e.closed = true
	e.cancel()
	e.mu.Unlock()
	done := make(chan struct{})
	go func() { e.active.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return environment.Fail("OUTCOME_UNKNOWN", "execution cleanup not confirmed", ctx.Err())
	}
}
func (e *Engine) Exec(ctx context.Context, req environment.ExecRequest, out environment.OutputHandler) (environment.ExecResult, error) {
	return e.Run(ctx, req, out, nil, nil)
}

// Run provides adapter-internal notifications without extending Process's public contract.
// settled fires only after the owned process scope and pipe readers have ended.
func (e *Engine) Run(ctx context.Context, req environment.ExecRequest, out environment.OutputHandler, started func(), settled func(environment.ExecResult, error)) (result environment.ExecResult, err error) {
	result.Completion = environment.NotStarted
	if req.Command == "" || len(req.Command) > 65536 || !utf8.ValidString(req.Command) || strings.ContainsRune(req.Command, 0) || req.Timeout < 0 || req.Timeout > time.Hour || req.MaxOutputBytes < 0 || req.MaxOutputBytes > 8<<20 || len(req.Cwd) > 65536 || !utf8.ValidString(req.Cwd) || strings.ContainsRune(req.Cwd, 0) {
		return result, environment.Fail("INVALID_ARGUMENT", "invalid execution request", nil)
	}
	if e.Bash == "" {
		return result, environment.Fail("SHELL_UNAVAILABLE", "Bash unavailable", nil)
	}
	if req.Timeout == 0 {
		req.Timeout = time.Minute
	}
	if req.MaxOutputBytes == 0 {
		req.MaxOutputBytes = 1 << 20
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = e.Cwd
	} else if !filepath.IsAbs(cwd) {
		cwd = filepath.Join(e.Cwd, cwd)
	}
	env, err := mergeEnv(e.BaseEnv, req.Env)
	if err != nil {
		return result, err
	}
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return result, environment.Fail("CONNECTION_CLOSED", "local environment closed", nil)
	}
	select {
	case e.slots <- struct{}{}:
		e.active.Add(1)
	default:
		e.mu.Unlock()
		return result, environment.Fail("RESOURCE_EXHAUSTED", "execution concurrency", nil)
	}
	e.mu.Unlock()
	release := func() { <-e.slots; e.active.Done() }
	ctx, cancel := context.WithTimeout(ctx, req.Timeout)
	defer cancel()
	stop := context.AfterFunc(e.ctx, cancel)
	defer stop()
	if ctx.Err() != nil {
		release()
		return result, ctx.Err()
	}
	stdout, ow, err := os.Pipe()
	if err != nil {
		release()
		return result, err
	}
	stderr, ew, err := os.Pipe()
	if err != nil {
		stdout.Close()
		ow.Close()
		release()
		return result, err
	}
	begin := time.Now()
	scope, err := launch(e.Bash, req.Command, cwd, env, ow, ew)
	ow.Close()
	ew.Close()
	if err != nil {
		stdout.Close()
		stderr.Close()
		release()
		return result, environment.Fail("START_FAILED", "create Bash", err)
	}
	if started != nil {
		started()
	}
	var capture sync.Mutex
	var outbuf, errbuf bytes.Buffer
	var truncated, incomplete bool
	var retained, forwarded int64
	var queuedBytes int64
	var forwarding = true
	queue := make(chan environment.OutputChunk, 128)
	callbackDone := make(chan struct{})
	callbackError := make(chan error, 1)
	go func() {
		defer close(callbackDone)
		for chunk := range queue {
			capture.Lock()
			queuedBytes -= int64(len(chunk.Data))
			capture.Unlock()
			if out != nil {
				if callErr := out(ctx, chunk); callErr != nil {
					select {
					case callbackError <- callErr:
					default:
					}
					cancel()
					for range queue {
					}
					return
				}
			}
		}
	}()
	var readers sync.WaitGroup
	readers.Add(2)
	read := func(file *os.File, stream environment.OutputStream) {
		defer readers.Done()
		defer file.Close()
		buf := make([]byte, 65536)
		for {
			n, readErr := file.Read(buf)
			if n > 0 {
				capture.Lock()
				data := bytes.Clone(buf[:n])
				keep := min(int64(n), req.MaxOutputBytes-retained)
				if stream == environment.Stdout {
					outbuf.Write(data[:keep])
				} else {
					errbuf.Write(data[:keep])
				}
				retained += keep
				if keep < int64(n) {
					truncated = true
				}
				if out != nil && forwarding {
					if forwarded+int64(n) > 8<<20 || queuedBytes+int64(n) > 1<<20 {
						forwarding = false
						truncated = true
					} else {
						select {
						case queue <- environment.OutputChunk{Stream: stream, Data: data}:
							forwarded += int64(n)
							queuedBytes += int64(n)
						default:
							forwarding = false
							truncated = true
						}
					}
				}
				capture.Unlock()
			}
			if readErr != nil {
				if readErr != io.EOF {
					capture.Lock()
					incomplete = true
					capture.Unlock()
				}
				return
			}
		}
	}
	go read(stdout, environment.Stdout)
	go read(stderr, environment.Stderr)
	readDone := make(chan struct{})
	go func() { readers.Wait(); close(queue); close(readDone) }()
	waited := make(chan waitResult, 1)
	go func() { waited <- scope.wait() }()
	var status waitResult
	var haveStatus bool
	var cause error
	select {
	case status = <-waited:
		haveStatus = true
	case <-ctx.Done():
		cause = ctx.Err()
	}
	select {
	case cbErr := <-callbackError:
		cause = environment.Fail("OUTPUT_FAILED", "output callback", cbErr)
	default:
	}
	killErr := scope.kill()
	cleanupDeadline := time.Now().Add(2 * time.Second)
	for (!haveStatus || !scope.done()) && time.Now().Before(cleanupDeadline) {
		if !haveStatus {
			select {
			case status = <-waited:
				haveStatus = true
			default:
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	confirmed := haveStatus && scope.done() && killErr == nil
	if confirmed {
		select {
		case <-readDone:
		case <-time.After(time.Until(cleanupDeadline)):
			stdout.Close()
			stderr.Close()
		}
	} else {
		stdout.Close()
		stderr.Close()
	}
	<-readDone
	// Well-behaved callbacks honor ctx; never start another callback after returning.
	<-callbackDone
	select {
	case cbErr := <-callbackError:
		cause = environment.Fail("OUTPUT_FAILED", "output callback", cbErr)
	default:
	}
	capture.Lock()
	result = environment.ExecResult{Completion: environment.Finished, Stdout: bytes.Clone(outbuf.Bytes()), Stderr: bytes.Clone(errbuf.Bytes()), OutputTruncated: truncated, OutputIncomplete: incomplete, Duration: time.Since(begin)}
	capture.Unlock()
	if incomplete && cause == nil {
		cause = environment.Fail("IO_ERROR", "output pipe did not finish normally", nil)
	}
	if haveStatus {
		result.ExitCode = status.code
		result.Signal = status.signal
		if status.err != nil && status.code == nil && cause == nil {
			cause = environment.Fail("IO_ERROR", "wait Bash", status.err)
		}
	}
	if !confirmed {
		result.Completion = environment.Unconfirmed
		result.OutputIncomplete = true
		err = environment.Fail("OUTCOME_UNKNOWN", "process scope cleanup not confirmed", errors.Join(cause, killErr))
		snapshot := result
		go func() {
			defer release()
			defer scope.close()
			if !haveStatus {
				status = <-waited
			}
			for !scope.done() {
				_ = scope.kill()
				time.Sleep(100 * time.Millisecond)
			}
			snapshot.Completion = environment.Finished
			snapshot.ExitCode = status.code
			snapshot.Signal = status.signal
			if settled != nil {
				settled(snapshot, cause)
			}
		}()
		return result, err
	}
	scope.close()
	release()
	if settled != nil {
		settled(result, cause)
	}
	return result, cause
}
func mergeEnv(base []string, overrides map[string]string) ([]string, error) {
	if len(overrides) > 128 {
		return nil, environment.Fail("INVALID_ARGUMENT", "environment entries", nil)
	}
	values := map[string]string{}
	for _, entry := range base {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			values[envKey(key)] = key + "=" + value
		}
	}
	size := 0
	keys := make([]string, 0, len(overrides))
	for key := range overrides {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	seen := map[string]bool{}
	for _, key := range keys {
		value := overrides[key]
		normalized := envKey(key)
		size += len(key) + len(value)
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) || size > 65536 || seen[normalized] {
			return nil, environment.Fail("INVALID_ARGUMENT", "invalid environment override", nil)
		}
		seen[normalized] = true
		values[normalized] = key + "=" + value
	}
	result := make([]string, 0, len(values))
	for _, entry := range values {
		result = append(result, entry)
	}
	sort.Strings(result)
	return result, nil
}

type waitResult struct {
	code   *int64
	signal string
	err    error
}
