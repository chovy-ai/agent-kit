package remote

import (
	"agent-kit/environment"
	v1 "agent-kit/internal/remoteproto/v1"
	"bytes"
	"context"
	"errors"
	"time"
)

func (e *Environment) Exec(ctx context.Context, req environment.ExecRequest, output environment.OutputHandler) (result environment.ExecResult, err error) {
	result.Completion = environment.NotStarted
	begin := time.Now()
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	if req.Command == "" || req.Timeout < 0 || req.Timeout > time.Hour || req.MaxOutputBytes < 0 || req.MaxOutputBytes > 8<<20 {
		return result, environment.Fail("INVALID_ARGUMENT", "invalid execution request", nil)
	}
	if req.Timeout == 0 {
		req.Timeout = time.Minute
	}
	if req.MaxOutputBytes == 0 {
		req.MaxOutputBytes = 1 << 20
	}
	op, done, err := e.operation(ctx, req.Timeout)
	if err != nil {
		return result, err
	}
	defer done()
	lease, err := e.client.lease(op, e.target)
	if err != nil {
		return result, err
	}
	remaining := req.Timeout - time.Since(begin)
	if deadline, ok := op.Deadline(); ok {
		remaining = min(remaining, time.Until(deadline))
	}
	if remaining <= 0 || op.Err() != nil {
		return result, context.DeadlineExceeded
	}
	request := &v1.ExecRequest{TargetId: e.target, ExecutionId: id(), Command: req.Command, Cwd: req.Cwd, Env: req.Env, TimeoutMs: uint32(max(int64(1), int64((remaining+time.Millisecond-1)/time.Millisecond))), MaxOutputBytes: uint64(req.MaxOutputBytes)}
	transportCtx, transportCancel := context.WithTimeout(context.Background(), remaining+5*time.Second)
	defer transportCancel()
	key, p, err := e.client.begin(transportCtx, "process.exec", request, lease, op)
	if err != nil {
		return result, err
	}
	defer e.client.end(key, p)
	poll := time.NewTicker(100 * time.Millisecond)
	defer poll.Stop()
	var stdout, stderr bytes.Buffer
	copyOutput := func() {
		e.client.mu.Lock()
		incomplete := p.incomplete
		e.client.mu.Unlock()
		result.OutputIncomplete = result.OutputIncomplete || incomplete
		result.Stdout = bytes.Clone(stdout.Bytes())
		result.Stderr = bytes.Clone(stderr.Bytes())
	}
	var retained int64
	var started, cancelled bool
	var stopCause error
	var confirmation context.Context
	var confirmationCancel context.CancelFunc
	defer func() {
		if confirmationCancel != nil {
			confirmationCancel()
		}
	}()
	cancelExecution := func(cause error) {
		if cancelled {
			return
		}
		cancelled = true
		stopCause = cause
		confirmation, confirmationCancel = context.WithTimeout(context.Background(), cleanupGrace)
		if e.client.peer.ctx.Err() == nil {
			_ = e.client.call(confirmation, "process.cancel", &v1.ProcessCancelRequest{TargetId: e.target, ExecutionId: request.ExecutionId}, new(v1.ProcessCancelResponse), lease)
		}
	}
	consume := func(frame *v1.Envelope) (bool, error) {
		if event := frame.GetEvent(); event != nil {
			switch event.Name {
			case "process.started":
				var in v1.ProcessStarted
				if decodeBody(event.Body, &in) != nil || in.ExecutionId != request.ExecutionId || started {
					return false, environment.Fail("PROTOCOL_ERROR", "invalid started event", nil)
				}
				started = true
			case "process.output":
				var in v1.ProcessOutput
				if decodeBody(event.Body, &in) != nil || !started || in.ExecutionId != request.ExecutionId || len(in.Data) == 0 || len(in.Data) > 65536 || in.Stream != v1.OutputStream_OUTPUT_STREAM_STDOUT && in.Stream != v1.OutputStream_OUTPUT_STREAM_STDERR {
					return false, environment.Fail("PROTOCOL_ERROR", "invalid output event", nil)
				}
				stream := environment.Stdout
				buf := &stdout
				if in.Stream == v1.OutputStream_OUTPUT_STREAM_STDERR {
					stream = environment.Stderr
					buf = &stderr
				}
				keep := min(int64(len(in.Data)), req.MaxOutputBytes-retained)
				buf.Write(in.Data[:keep])
				retained += keep
				if keep < int64(len(in.Data)) {
					result.OutputTruncated = true
				}
				if output != nil && !cancelled {
					if callErr := output(op, environment.OutputChunk{Stream: stream, Data: bytes.Clone(in.Data)}); callErr != nil {
						cancelExecution(environment.Fail("OUTPUT_FAILED", "output callback", callErr))
					}
				}
			default:
				return false, environment.Fail("PROTOCOL_ERROR", "unknown process event", nil)
			}
			return false, nil
		}
		response := frame.GetResponse()
		if response == nil {
			return false, environment.Fail("PROTOCOL_ERROR", "terminal response required", nil)
		}
		if response.GetError() != nil {
			result.Completion = environment.NotStarted
			return true, fromRPC(response.GetError(), "process.exec")
		}
		var in v1.ExecTerminal
		if decodeBody(response.GetBody(), &in) != nil {
			return false, environment.Fail("PROTOCOL_ERROR", "invalid terminal", nil)
		}
		converted, termErr := convertTerminal(&in, request.ExecutionId)
		converted.OutputTruncated = converted.OutputTruncated || result.OutputTruncated
		result = converted
		return true, termErr
	}
	for {
		waitCtx := transportCtx
		if cancelled {
			waitCtx = confirmation
		}
		select {
		case <-op.Done():
			if !cancelled {
				cancelExecution(op.Err())
			}
		default:
		}
		// After cancellation use only the independent confirmation budget.
		if cancelled {
			waitCtx = confirmation
		}
		var frame *v1.Envelope
		var statePoll <-chan time.Time
		if cancelled {
			statePoll = poll.C
		}
		operationDone := op.Done()
		if cancelled {
			operationDone = nil
		}
		select {
		case frame = <-p.frames:
			e.client.mu.Lock()
			p.bytes -= messageSize(frame)
			e.client.mu.Unlock()
		case failure := <-p.err:
			if environment.Code(failure) == "NOT_SENT" {
				result.Completion = environment.NotStarted
				copyOutput()
				return result, op.Err()
			}
			if !cancelled && e.client.peer.ctx.Err() == nil {
				cancelExecution(failure)
				continue
			}
			err = failure
		case <-e.client.peer.done:
			err = environment.Fail("CONNECTION_CLOSED", "remote connection lost", nil)
		case <-waitCtx.Done():
			err = waitCtx.Err()
		case <-operationDone:
			cancelExecution(op.Err())
			continue
		case <-statePoll:
			if e.client.peer.ctx.Err() != nil {
				continue
			}
			state := new(v1.ProcessGetStateResponse)
			queryCtx, cancel := context.WithTimeout(confirmation, 100*time.Millisecond)
			queryErr := e.client.call(queryCtx, "process.getState", &v1.ProcessGetStateRequest{TargetId: e.target, ExecutionId: request.ExecutionId}, state, nil)
			cancel()
			if queryErr == nil && state.Terminal != nil {
				result, err = convertTerminal(state.Terminal, request.ExecutionId)
				result.OutputIncomplete = true
				copyOutput()
				if stopCause != nil {
					return result, stopCause
				}
				return result, err
			}
			continue
		}
		if frame != nil {
			finished, frameErr := consume(frame)
			if finished {
				if environment.Code(frameErr) == "PROTOCOL_ERROR" {
					e.client.peer.fail(frameErr)
					result.Completion = environment.Unconfirmed
					result.OutputIncomplete = true
					copyOutput()
					return result, environment.Fail("OUTCOME_UNKNOWN", "invalid execution terminal", frameErr)
				}
				copyOutput()
				if stopCause != nil && result.Completion != environment.Unconfirmed {
					return result, stopCause
				}
				return result, frameErr
			}
			if frameErr != nil {
				if environment.Code(frameErr) == "PROTOCOL_ERROR" {
					e.client.peer.fail(frameErr)
				}
				cancelExecution(frameErr)
				continue
			}
			continue
		}
		result.Completion = environment.Unconfirmed
		result.OutputIncomplete = true
		copyOutput()
		return result, environment.Fail("OUTCOME_UNKNOWN", "remote completion not confirmed", errors.Join(stopCause, err))
	}
}
func convertTerminal(in *v1.ExecTerminal, id string) (environment.ExecResult, error) {
	r := environment.ExecResult{ExitCode: in.ExitCode, Signal: in.Signal, Duration: time.Duration(in.DurationMs) * time.Millisecond, OutputTruncated: in.OutputTruncated, OutputIncomplete: in.OutputIncomplete}
	if in.ExecutionId != id {
		return r, environment.Fail("PROTOCOL_ERROR", "terminal execution mismatch", nil)
	}
	switch in.Completion {
	case v1.ProcessCompletion_PROCESS_COMPLETION_NOT_STARTED:
		r.Completion = environment.NotStarted
		if in.ExitCode != nil || in.ExecutionError == nil {
			return r, environment.Fail("PROTOCOL_ERROR", "invalid not_started terminal", nil)
		}
	case v1.ProcessCompletion_PROCESS_COMPLETION_FINISHED:
		r.Completion = environment.Finished
	case v1.ProcessCompletion_PROCESS_COMPLETION_UNCONFIRMED:
		r.Completion = environment.Unconfirmed
		if in.ExecutionError == nil || in.ExecutionError.Code != "OUTCOME_UNKNOWN" {
			return r, environment.Fail("PROTOCOL_ERROR", "invalid unconfirmed terminal", nil)
		}
	default:
		return r, environment.Fail("PROTOCOL_ERROR", "invalid completion", nil)
	}
	return r, fromRPC(in.ExecutionError, "process.exec")
}
