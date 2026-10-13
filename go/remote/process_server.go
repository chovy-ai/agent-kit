package remote

import (
	"agent-kit/environment"
	v1 "agent-kit/internal/remoteproto/v1"
	"context"
	"google.golang.org/protobuf/proto"
	"time"
)

func (s *session) key(target, execution string) string {
	return s.id + "\x00" + target + "\x00" + execution
}
func terminal(execution string, result environment.ExecResult, err error) *v1.ExecTerminal {
	completion := v1.ProcessCompletion_PROCESS_COMPLETION_NOT_STARTED
	if result.Completion == environment.Finished {
		completion = v1.ProcessCompletion_PROCESS_COMPLETION_FINISHED
	} else if result.Completion == environment.Unconfirmed {
		completion = v1.ProcessCompletion_PROCESS_COMPLETION_UNCONFIRMED
	}
	out := &v1.ExecTerminal{ExecutionId: execution, Completion: completion, ExitCode: result.ExitCode, Signal: result.Signal, DurationMs: uint64(result.Duration / time.Millisecond), OutputTruncated: result.OutputTruncated, OutputIncomplete: result.OutputIncomplete}
	if err != nil {
		out.ExecutionError = rpcError("process.exec", err)
		detail := &v1.ProcessErrorDetail{Reason: environment.Code(err), Completion: completion}
		out.ExecutionError.Details, _ = proto.Marshal(detail)
	}
	return out
}
func (s *session) save(rec *record, result environment.ExecResult, err error) {
	s.s.mu.Lock()
	defer s.s.mu.Unlock()
	if rec.state == v1.ProcessState_PROCESS_STATE_FINISHED && result.Completion == environment.Unconfirmed {
		return
	}
	rec.terminal = terminal(rec.id, result, err)
	if result.Completion == environment.Unconfirmed {
		rec.state = v1.ProcessState_PROCESS_STATE_CLEANING
		return
	}
	if result.Completion == environment.NotStarted {
		rec.state = v1.ProcessState_PROCESS_STATE_NOT_STARTED
	} else {
		rec.state = v1.ProcessState_PROCESS_STATE_FINISHED
	}
	rec.expires = time.Now().Add(120 * time.Second)
	if rec.leaseExpiry.After(rec.expires) {
		rec.expires = rec.leaseExpiry
	}
}
func (s *session) exec(ctx context.Context, msg *v1.Envelope) (proto.Message, error) {
	var in v1.ExecRequest
	req := msg.GetRequest()
	if proto.Unmarshal(req.Body, &in) != nil || in.ExecutionId == "" || len(in.ExecutionId) > 128 {
		return nil, environment.Fail("INVALID_ARGUMENT", "invalid execution id", nil)
	}
	target, err := s.target(in.TargetId)
	if err != nil {
		return nil, err
	}
	expiry, err := s.validateLease(req.AdmissionLease, in.TargetId)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	rec := &record{session: s.id, target: in.TargetId, id: in.ExecutionId, cancel: cancel, state: v1.ProcessState_PROCESS_STATE_STARTING, leaseExpiry: expiry}
	key := s.key(in.TargetId, in.ExecutionId)
	s.s.mu.Lock()
	s.s.pruneLocked()
	if _, exists := s.s.records[key]; exists {
		s.s.mu.Unlock()
		return nil, environment.Fail("DUPLICATE_EXECUTION", "execution id already admitted", nil)
	}
	if len(s.s.records) >= 4096 {
		s.s.mu.Unlock()
		return nil, environment.Fail("RESOURCE_EXHAUSTED", "execution records full", nil)
	}
	s.s.records[key] = rec
	s.s.mu.Unlock()
	var sequence uint64
	emit := func(name string, body proto.Message, final bool) error {
		data, err := proto.Marshal(body)
		if err != nil {
			return err
		}
		sequence++
		frame := &v1.Envelope{RequestId: msg.RequestId, Sequence: sequence}
		if final {
			frame.Kind = &v1.Envelope_Response{Response: &v1.RpcResponse{Outcome: &v1.RpcResponse_Body{Body: data}}}
		} else {
			frame.Kind = &v1.Envelope_Event{Event: &v1.RpcEvent{Name: name, Body: data}}
		}
		if err = s.peer.send(frame, final || name == "process.started"); err != nil {
			sequence--
		}
		return err
	}
	result := environment.ExecResult{Completion: environment.NotStarted}
	if !acquire(s.executions) {
		err = environment.Fail("RESOURCE_EXHAUSTED", "session execution limit", nil)
	} else {
		if !acquire(s.s.executions) {
			<-s.executions
			err = environment.Fail("RESOURCE_EXHAUSTED", "global execution limit", nil)
		} else {
			// The engine owns quota until later settled notification when cleanup is unconfirmed.
			settled := false
			settle := func(r environment.ExecResult, e error) {
				s.save(rec, r, e)
				s.s.mu.Lock()
				if !settled {
					settled = true
					<-s.executions
					<-s.s.executions
				}
				s.s.mu.Unlock()
			}
			if _, err = s.validateLease(req.AdmissionLease, in.TargetId); err == nil {
				forwarding := true
				truncated := false
				result, err = target.RunProcess(ctx, environment.ExecRequest{Command: in.Command, Cwd: in.Cwd, Env: in.Env, Timeout: time.Duration(in.TimeoutMs) * time.Millisecond, MaxOutputBytes: int64(in.MaxOutputBytes)}, func(_ context.Context, chunk environment.OutputChunk) error {
					if !forwarding {
						return nil
					}
					stream := v1.OutputStream_OUTPUT_STREAM_STDOUT
					if chunk.Stream == environment.Stderr {
						stream = v1.OutputStream_OUTPUT_STREAM_STDERR
					}
					sendErr := emit("process.output", &v1.ProcessOutput{ExecutionId: in.ExecutionId, Stream: stream, Data: chunk.Data}, false)
					if environment.Code(sendErr) == "RESOURCE_EXHAUSTED" {
						forwarding = false
						truncated = true
						return nil
					}
					return sendErr
				}, func() {
					s.s.mu.Lock()
					rec.state = v1.ProcessState_PROCESS_STATE_RUNNING
					s.s.mu.Unlock()
					if err := emit("process.started", &v1.ProcessStarted{ExecutionId: in.ExecutionId}, false); err != nil {
						s.peer.fail(err)
					}
				}, settle)
				result.OutputTruncated = result.OutputTruncated || truncated
			}
			if result.Completion != environment.Unconfirmed {
				s.s.mu.Lock()
				needsSettle := !settled
				s.s.mu.Unlock()
				if needsSettle {
					settle(result, err)
				}
			}
		}
	}
	s.save(rec, result, err)
	if err = emit("", terminal(in.ExecutionId, result, err), true); err != nil {
		s.peer.fail(err)
	}
	return nil, nil
}
func (s *session) cancelExecution(msg *v1.Envelope) (proto.Message, error) {
	var in v1.ProcessCancelRequest
	if proto.Unmarshal(msg.GetRequest().Body, &in) != nil || in.ExecutionId == "" || len(in.ExecutionId) > 128 {
		return nil, environment.Fail("INVALID_ARGUMENT", "invalid cancel", nil)
	}
	if _, err := s.target(in.TargetId); err != nil {
		return nil, err
	}
	key := s.key(in.TargetId, in.ExecutionId)
	s.s.mu.Lock()
	s.s.pruneLocked()
	rec := s.s.records[key]
	if rec != nil {
		cancel := rec.cancel
		state := rec.state
		if state != v1.ProcessState_PROCESS_STATE_FINISHED && state != v1.ProcessState_PROCESS_STATE_NOT_STARTED {
			rec.state = v1.ProcessState_PROCESS_STATE_CLEANING
		}
		s.s.mu.Unlock()
		if state == v1.ProcessState_PROCESS_STATE_FINISHED || state == v1.ProcessState_PROCESS_STATE_NOT_STARTED {
			return &v1.ProcessCancelResponse{ExecutionId: in.ExecutionId, Disposition: v1.ProcessCancelDisposition_PROCESS_CANCEL_DISPOSITION_ALREADY_TERMINAL}, nil
		}
		cancel()
		return &v1.ProcessCancelResponse{ExecutionId: in.ExecutionId, Disposition: v1.ProcessCancelDisposition_PROCESS_CANCEL_DISPOSITION_ACCEPTED}, nil
	}
	s.s.mu.Unlock()
	expiry, err := s.validateLease(msg.GetRequest().AdmissionLease, in.TargetId)
	if err != nil {
		return &v1.ProcessCancelResponse{ExecutionId: in.ExecutionId, Disposition: v1.ProcessCancelDisposition_PROCESS_CANCEL_DISPOSITION_MISSING}, nil
	}
	s.s.mu.Lock()
	defer s.s.mu.Unlock()
	if rec = s.s.records[key]; rec != nil {
		if rec.state == v1.ProcessState_PROCESS_STATE_FINISHED || rec.state == v1.ProcessState_PROCESS_STATE_NOT_STARTED {
			return &v1.ProcessCancelResponse{ExecutionId: in.ExecutionId, Disposition: v1.ProcessCancelDisposition_PROCESS_CANCEL_DISPOSITION_ALREADY_TERMINAL}, nil
		}
		rec.state = v1.ProcessState_PROCESS_STATE_CLEANING
		if rec.cancel != nil {
			rec.cancel()
		}
		return &v1.ProcessCancelResponse{ExecutionId: in.ExecutionId, Disposition: v1.ProcessCancelDisposition_PROCESS_CANCEL_DISPOSITION_ACCEPTED}, nil
	}
	markers := 0
	for _, r := range s.s.records {
		if r.cancel == nil {
			markers++
		}
	}
	if markers >= 1024 || len(s.s.records) >= 4096 {
		return nil, environment.Fail("RESOURCE_EXHAUSTED", "cancel markers full", nil)
	}
	result := environment.ExecResult{Completion: environment.NotStarted}
	s.s.records[key] = &record{session: s.id, target: in.TargetId, id: in.ExecutionId, state: v1.ProcessState_PROCESS_STATE_NOT_STARTED, terminal: terminal(in.ExecutionId, result, context.Canceled), expires: expiry, leaseExpiry: expiry}
	return &v1.ProcessCancelResponse{ExecutionId: in.ExecutionId, Disposition: v1.ProcessCancelDisposition_PROCESS_CANCEL_DISPOSITION_ACCEPTED}, nil
}
func (s *session) getState(msg *v1.Envelope) (proto.Message, error) {
	var in v1.ProcessGetStateRequest
	if proto.Unmarshal(msg.GetRequest().Body, &in) != nil || in.ExecutionId == "" || len(in.ExecutionId) > 128 {
		return nil, environment.Fail("INVALID_ARGUMENT", "invalid state query", nil)
	}
	if _, err := s.target(in.TargetId); err != nil {
		return nil, err
	}
	s.s.mu.Lock()
	defer s.s.mu.Unlock()
	s.s.pruneLocked()
	out := &v1.ProcessGetStateResponse{ExecutionId: in.ExecutionId, State: v1.ProcessState_PROCESS_STATE_MISSING}
	if rec := s.s.records[s.key(in.TargetId, in.ExecutionId)]; rec != nil {
		out.State = rec.state
		if rec.state == v1.ProcessState_PROCESS_STATE_FINISHED || rec.state == v1.ProcessState_PROCESS_STATE_NOT_STARTED {
			out.Terminal = proto.Clone(rec.terminal).(*v1.ExecTerminal)
		}
	}
	return out, nil
}
