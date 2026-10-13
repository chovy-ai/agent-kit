package remote

import (
	"agent-kit/environment"
	v1 "agent-kit/internal/remoteproto/v1"
	"context"
	"crypto/rand"
	"errors"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
	"net/http"
	"sync"
	"time"
)

type lease struct {
	token   []byte
	target  string
	expires time.Time
}
type record struct {
	session, target, id string
	cancel              context.CancelFunc
	state               v1.ProcessState
	terminal            *v1.ExecTerminal
	expires             time.Time
	leaseExpiry         time.Time
}
type Server struct {
	targets                               map[string]Target
	instance                              string
	mu                                    sync.Mutex
	sessions                              map[*session]bool
	records                               map[string]*record
	draining                              bool
	ordinary, controls, files, executions chan struct{}
}
type session struct {
	s                                     *Server
	peer                                  *peer
	id                                    string
	mu                                    sync.Mutex
	ready                                 bool
	active                                map[string]context.CancelFunc
	leases                                map[string]lease
	ordinary, controls, files, executions chan struct{}
	workers                               sync.WaitGroup
}

// NewServer takes ownership of the registered targets until Close.
func NewServer(targets map[string]Target) (*Server, error) {
	if len(targets) == 0 {
		return nil, environment.Fail("INVALID_ARGUMENT", "at least one target required", nil)
	}
	owned := map[string]Target{}
	for key, target := range targets {
		if key == "" || len(key) > 128 || nilTarget(target) {
			return nil, environment.Fail("INVALID_ARGUMENT", "invalid target", nil)
		}
		owned[key] = target
	}
	return &Server{targets: owned, instance: id(), sessions: map[*session]bool{}, records: map[string]*record{}, ordinary: make(chan struct{}, 128), controls: make(chan struct{}, 32), files: make(chan struct{}, 64), executions: make(chan struct{}, 16)}, nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	if s.draining || len(s.sessions) >= 32 {
		s.mu.Unlock()
		http.Error(w, "execution server unavailable", http.StatusServiceUnavailable)
		return
	}
	s.mu.Unlock()
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{Subprotocol}})
	if err != nil {
		return
	}
	if conn.Subprotocol() != Subprotocol {
		conn.Close(websocket.StatusPolicyViolation, "unsupported subprotocol")
		return
	}
	sess := &session{s: s, peer: newPeer(conn), id: id(), active: map[string]context.CancelFunc{}, leases: map[string]lease{}, ordinary: make(chan struct{}, 32), controls: make(chan struct{}, 8), files: make(chan struct{}, 16), executions: make(chan struct{}, 4)}
	s.mu.Lock()
	if s.draining || len(s.sessions) >= 32 {
		s.mu.Unlock()
		conn.CloseNow()
		return
	}
	s.sessions[sess] = true
	s.mu.Unlock()
	sess.peer.onMessage = sess.receive
	sess.peer.onFail = func(error) {
		sess.mu.Lock()
		for _, cancel := range sess.active {
			cancel()
		}
		sess.mu.Unlock()
	}
	sess.peer.start()
	// A peer that never sends Hello must not occupy a session indefinitely.
	timer := time.AfterFunc(3*time.Second, func() {
		sess.mu.Lock()
		ready := sess.ready
		sess.mu.Unlock()
		if !ready {
			sess.peer.close()
		}
	})
	defer timer.Stop()
	<-sess.peer.done
	sess.workers.Wait()
	s.mu.Lock()
	delete(s.sessions, sess)
	s.mu.Unlock()
}
func acquire(ch chan struct{}) bool {
	select {
	case ch <- struct{}{}:
		return true
	default:
		return false
	}
}
func (s *session) receive(msg *v1.Envelope) error {
	req := msg.GetRequest()
	if req == nil || msg.Sequence != 0 {
		return environment.Fail("PROTOCOL_ERROR", "client message must be a request", nil)
	}
	if len(msg.RequestId) > 128 || req.Method == "" || req.TimeoutMs == 0 {
		return s.reject(msg, "INVALID_ARGUMENT", "invalid request", nil)
	}
	s.mu.Lock()
	ready := s.ready
	_, duplicate := s.active[msg.RequestId]
	s.mu.Unlock()
	if duplicate {
		return environment.Fail("PROTOCOL_ERROR", "duplicate active request id", nil)
	}
	if !ready && req.Method != "system.hello" {
		return s.reject(msg, "INVALID_ARGUMENT", "Hello required", nil)
	}
	if req.Method == "system.hello" {
		var hello v1.HelloRequest
		if ready || proto.Unmarshal(req.Body, &hello) != nil || hello.ProtocolVersion != 1 || req.TimeoutMs > 3000 {
			return s.reject(msg, "UNSUPPORTED_VERSION", "invalid Hello", nil)
		}
		s.mu.Lock()
		s.ready = true
		s.mu.Unlock()
		return s.respond(msg, &v1.HelloResponse{ProtocolVersion: 1, ServiceInstance: s.s.instance, SessionId: s.id, Methods: methods, ChannelLimits: channelLimits(), Timeouts: timeouts()}, true)
	}
	if req.ServiceInstance != s.s.instance {
		return s.reject(msg, "INSTANCE_MISMATCH", "service instance changed", nil)
	}
	isControl := control(req.Method)
	limit := uint32(60000)
	if isControl {
		limit = 10000
	}
	if req.Method == "process.exec" {
		limit = 3605000
	}
	if req.TimeoutMs > limit {
		return s.reject(msg, "INVALID_ARGUMENT", "RPC budget exceeds method limit", nil)
	}
	s.s.mu.Lock()
	draining := s.s.draining
	s.s.mu.Unlock()
	if draining && !isControl {
		return s.reject(msg, "RESOURCE_EXHAUSTED", "server draining", nil)
	}
	localPermits, globalPermits := s.ordinary, s.s.ordinary
	if isControl {
		localPermits, globalPermits = s.controls, s.s.controls
	}
	if !acquire(localPermits) {
		return s.reject(msg, "RESOURCE_EXHAUSTED", "session concurrency", nil)
	}
	if !acquire(globalPermits) {
		<-localPermits
		return s.reject(msg, "RESOURCE_EXHAUSTED", "server concurrency", nil)
	}
	ctx, cancel := context.WithTimeout(s.peer.ctx, time.Duration(req.TimeoutMs)*time.Millisecond)
	s.mu.Lock()
	s.active[msg.RequestId] = cancel
	s.mu.Unlock()
	s.workers.Add(1)
	go func() {
		defer s.workers.Done()
		defer func() {
			cancel()
			s.mu.Lock()
			delete(s.active, msg.RequestId)
			s.mu.Unlock()
			<-localPermits
			<-globalPermits
		}()
		result, err := s.handle(ctx, msg)
		if req.Method == "process.exec" && result == nil && err == nil {
			return
		}
		var sendErr error
		if err != nil {
			sendErr = s.reject(msg, environment.Code(err), err.Error(), err)
		} else {
			sendErr = s.respond(msg, result, isControl)
		}
		if sendErr != nil {
			s.peer.fail(sendErr)
		}
	}()
	return nil
}
func (s *session) respond(msg *v1.Envelope, body proto.Message, priority bool) error {
	data, err := proto.Marshal(body)
	if err != nil {
		return err
	}
	return s.peer.send(&v1.Envelope{RequestId: msg.RequestId, Kind: &v1.Envelope_Response{Response: &v1.RpcResponse{Outcome: &v1.RpcResponse_Body{Body: data}}}}, priority)
}
func rpcError(method string, err error) *v1.RpcError {
	code := environment.Code(err)
	if code == "SHELL_UNAVAILABLE" {
		code = "BASH_UNAVAILABLE"
	}
	reason := code
	var e *environment.Error
	if errors.As(err, &e) {
		reason = e.Reason
	}
	var detail proto.Message = &v1.RequestErrorDetail{Reason: reason}
	if len(method) >= 11 && method[:11] == "filesystem." {
		switch code {
		case "INVALID_ARGUMENT":
			reason = "INVALID_ARGUMENT"
		case "RESOURCE_EXHAUSTED":
			reason = "LIMIT_EXCEEDED"
		case "INTERNAL":
			reason = "INTERNAL_ERROR"
		}
		mutation := v1.MutationState_MUTATION_STATE_NOT_STARTED
		if e != nil && e.MayHaveChanged {
			mutation = v1.MutationState_MUTATION_STATE_MAY_HAVE_CHANGED
		}
		detail = &v1.FileErrorDetail{Reason: reason, MutationState: mutation}
	} else if len(method) >= 8 && method[:8] == "process." {
		detail = &v1.ProcessErrorDetail{Reason: reason, Completion: v1.ProcessCompletion_PROCESS_COMPLETION_NOT_STARTED}
	}
	data, _ := proto.Marshal(detail)
	message := err.Error()
	if len(message) > 4096 {
		message = message[:4096]
	}
	return &v1.RpcError{Code: code, Message: message, Details: data}
}
func (s *session) reject(msg *v1.Envelope, code, message string, cause error) error {
	if cause == nil {
		cause = environment.Fail(code, message, nil)
	}
	return s.peer.send(&v1.Envelope{RequestId: msg.RequestId, Kind: &v1.Envelope_Response{Response: &v1.RpcResponse{Outcome: &v1.RpcResponse_Error{Error: rpcError(msg.GetRequest().Method, cause)}}}}, true)
}
func (s *session) target(key string) (Target, error) {
	if key == "" || len(key) > 128 {
		return nil, environment.Fail("INVALID_ARGUMENT", "invalid target id", nil)
	}
	target := s.s.targets[key]
	if target == nil {
		return nil, environment.Fail("NOT_FOUND", "UNKNOWN_TARGET", nil)
	}
	return target, nil
}
func (s *session) getInfo(targetID string) (proto.Message, error) {
	target, err := s.target(targetID)
	if err != nil {
		return nil, err
	}
	platform := v1.Platform_PLATFORM_LINUX
	switch target.Platform() {
	case "darwin":
		platform = v1.Platform_PLATFORM_MACOS
	case "windows":
		platform = v1.Platform_PLATFORM_WINDOWS
	case "linux":
	default:
		return nil, environment.Fail("FAILED_PRECONDITION", "unsupported target platform", nil)
	}
	info := &v1.GetInfoResponse{TargetId: targetID, Platform: platform, DefaultCwd: target.DefaultCwd(), FilesystemAvailable: true, BashAvailable: target.BashAvailable(), FilesystemLimits: fsLimits(), ProcessLimits: processLimits(), Methods: methods}
	if info.BashAvailable {
		s.mu.Lock()
		defer s.mu.Unlock()
		now := time.Now()
		for key, l := range s.leases {
			if !l.expires.After(now) {
				delete(s.leases, key)
			}
		}
		if len(s.leases) >= 128 {
			return nil, environment.Fail("RESOURCE_EXHAUSTED", "session lease limit", nil)
		}
		var data [16]byte
		if _, err := rand.Read(data[:]); err != nil {
			return nil, err
		}
		token := append([]byte{}, data[:]...)
		s.leases[string(token)] = lease{token: token, target: targetID, expires: now.Add(30 * time.Second)}
		info.AdmissionLease = &v1.AdmissionLease{Token: token, RemainingTtlMs: 30000}
	}
	return info, nil
}
func (s *session) validateLease(token []byte, target string) (time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.leases[string(token)]
	if len(token) != 16 || !ok || l.target != target || !l.expires.After(time.Now()) {
		return time.Time{}, environment.Fail("LEASE_EXPIRED", "startup admission expired", nil)
	}
	return l.expires, nil
}
func (s *Server) pruneLocked() {
	now := time.Now()
	for key, rec := range s.records {
		if !rec.expires.IsZero() && !rec.expires.After(now) {
			delete(s.records, key)
		}
	}
}
func (s *Server) Close(ctx context.Context) error {
	s.mu.Lock()
	s.draining = true
	sessions := make([]*session, 0, len(s.sessions))
	for sess := range s.sessions {
		sessions = append(sessions, sess)
	}
	s.mu.Unlock()
	for _, sess := range sessions {
		sess.mu.Lock()
		for _, cancel := range sess.active {
			cancel()
		}
		sess.mu.Unlock()
	}
	var errs []error
	for _, target := range s.targets {
		errs = append(errs, target.Close(ctx))
	}
	for _, sess := range sessions {
		sess.peer.graceful(ctx)
	}
	return errors.Join(errs...)
}
