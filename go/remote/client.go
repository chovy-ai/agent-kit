package remote

import (
	"agent-kit/environment"
	v1 "agent-kit/internal/remoteproto/v1"
	"context"
	"errors"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
	"sync"
	"time"
)

type pending struct {
	method     string
	frames     chan *v1.Envelope
	err        chan error
	sequence   uint64
	bytes      int
	control    bool
	incomplete bool
	sent       bool
}
type Client struct {
	peer               *peer
	mu                 sync.Mutex
	pending            map[string]*pending
	retired            map[string]bool
	retiredOrder       []string
	instance           string
	infos              map[string]*v1.GetInfoResponse
	leaseTimes         map[string]time.Time
	ordinary, controls chan struct{}
}

// Dial eagerly connects and validates all initial targets. It never reconnects or retries.
func Dial(ctx context.Context, endpoint string, targets []string) (*Client, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	dialCtx, stop := context.WithTimeout(ctx, 5*time.Second)
	conn, _, err := websocket.Dial(dialCtx, endpoint, &websocket.DialOptions{Subprotocols: []string{Subprotocol}})
	stop()
	if err != nil {
		return nil, environment.Fail("CONNECTION_FAILED", "dial remote server", err)
	}
	if conn.Subprotocol() != Subprotocol {
		conn.CloseNow()
		return nil, environment.Fail("PROTOCOL_ERROR", "unsupported subprotocol", nil)
	}
	c := &Client{peer: newPeer(conn), pending: map[string]*pending{}, retired: map[string]bool{}, infos: map[string]*v1.GetInfoResponse{}, leaseTimes: map[string]time.Time{}, ordinary: make(chan struct{}, 32), controls: make(chan struct{}, 8)}
	c.peer.onMessage = c.receive
	c.peer.onFail = c.failPending
	c.peer.start()
	ready := false
	defer func() {
		if !ready {
			c.peer.close()
		}
	}()
	helloCtx, finish := context.WithTimeout(ctx, 3*time.Second)
	hello := new(v1.HelloResponse)
	err = c.call(helloCtx, "system.hello", &v1.HelloRequest{ProtocolVersion: 1}, hello, nil)
	finish()
	if err != nil {
		return nil, err
	}
	if !validateHello(hello) {
		return nil, environment.Fail("PROTOCOL_ERROR", "invalid Hello result", nil)
	}
	c.instance = hello.ServiceInstance
	for _, target := range targets {
		if _, err = c.refresh(ctx, target); err != nil {
			return nil, err
		}
	}
	ready = true
	return c, nil
}
func (c *Client) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c.peer.graceful(ctx)
	return nil
}
func (c *Client) failPending(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range c.pending {
		select {
		case p.err <- err:
		default:
		}
	}
}
func (c *Client) receive(msg *v1.Envelope) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.pending[msg.RequestId]
	if p == nil {
		if c.retired[msg.RequestId] {
			return nil
		}
		return environment.Fail("PROTOCOL_ERROR", "response without pending request", nil)
	}
	if msg.GetResponse() == nil && msg.GetEvent() == nil {
		return environment.Fail("PROTOCOL_ERROR", "server sent request", nil)
	}
	if p.method == "process.exec" {
		if msg.GetResponse() != nil && msg.GetResponse().GetError() != nil {
			if p.sequence != 0 || msg.Sequence != 0 {
				return environment.Fail("PROTOCOL_ERROR", "execution RPC error after start", nil)
			}
		} else {
			if msg.Sequence != p.sequence+1 {
				return environment.Fail("PROTOCOL_ERROR", "execution sequence gap", nil)
			}
			p.sequence = msg.Sequence
		}
	} else if msg.Sequence != 0 || msg.GetEvent() != nil {
		return environment.Fail("PROTOCOL_ERROR", "unexpected event or sequence", nil)
	}
	if response := msg.GetResponse(); response != nil && response.Outcome == nil {
		return environment.Fail("PROTOCOL_ERROR", "response outcome required", nil)
	}
	if response := msg.GetResponse(); response != nil && response.GetError() != nil && (response.GetError().Code == "" || len(response.GetError().Message) > 4096) {
		return environment.Fail("PROTOCOL_ERROR", "invalid RPC error", nil)
	}
	size := proto.Size(msg)
	if p.bytes+size > 1<<20 && msg.GetEvent() != nil {
		p.incomplete = true
		select {
		case p.err <- environment.Fail("OUTPUT_FAILED", "client output queue full", nil):
		default:
		}
		return nil
	}
	select {
	case p.frames <- msg:
		p.bytes += size
	default:
		p.incomplete = true
		select {
		case p.err <- environment.Fail("OUTPUT_FAILED", "client response queue full", nil):
		default:
		}
	}
	return nil
}
func (c *Client) retire(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.pending, key)
	c.retired[key] = true
	c.retiredOrder = append(c.retiredOrder, key)
	if len(c.retiredOrder) > 256 {
		delete(c.retired, c.retiredOrder[0])
		c.retiredOrder = c.retiredOrder[1:]
	}
}
func (c *Client) begin(ctx context.Context, method string, body proto.Message, lease []byte, admission ...context.Context) (string, *pending, error) {
	if ctx.Err() != nil {
		return "", nil, ctx.Err()
	}
	c.peer.mu.Lock()
	failure := c.peer.err
	c.peer.mu.Unlock()
	if failure != nil {
		return "", nil, failure
	}
	permits := c.ordinary
	if control(method) {
		permits = c.controls
	}
	if !acquire(permits) {
		return "", nil, environment.Fail("RESOURCE_EXHAUSTED", "client concurrency", nil)
	}
	data, err := proto.Marshal(body)
	if err != nil {
		<-permits
		return "", nil, err
	}
	wait := 10 * time.Second
	if control(method) {
		wait = 2 * time.Second
	}
	if deadline, ok := ctx.Deadline(); ok {
		wait = time.Until(deadline)
	}
	ms := max(int64(1), int64((wait+time.Millisecond-1)/time.Millisecond))
	if ms > 3605000 {
		ms = 3605000
	}
	key := id()
	p := &pending{method: method, frames: make(chan *v1.Envelope, 128), err: make(chan error, 1), control: control(method)}
	c.mu.Lock()
	c.pending[key] = p
	c.mu.Unlock()
	queuedCtx := ctx
	if len(admission) > 0 {
		queuedCtx = admission[0]
	}
	err = c.peer.enqueue(&v1.Envelope{RequestId: key, Kind: &v1.Envelope_Request{Request: &v1.RpcRequest{Method: method, TimeoutMs: uint32(ms), ServiceInstance: c.instance, AdmissionLease: lease, Body: data}}}, control(method), queuedCtx, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		if queuedCtx.Err() != nil {
			return false
		}
		p.sent = true
		return true
	}, func() {
		select {
		case p.err <- environment.Fail("NOT_SENT", "request cancelled before socket write", queuedCtx.Err()):
		default:
		}
	})
	if err != nil {
		c.retire(key)
		<-permits
		return "", nil, err
	}
	return key, p, nil
}
func (c *Client) end(key string, p *pending) {
	c.retire(key)
	if p.control {
		<-c.controls
	} else {
		<-c.ordinary
	}
}
func (c *Client) next(ctx context.Context, p *pending) (*v1.Envelope, error) {
	select {
	case frame := <-p.frames:
		c.mu.Lock()
		p.bytes -= proto.Size(frame)
		c.mu.Unlock()
		return frame, nil
	case err := <-p.err:
		return nil, err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.peer.done:
		c.peer.mu.Lock()
		err := c.peer.err
		c.peer.mu.Unlock()
		return nil, err
	}
}
func fromRPC(err *v1.RpcError, method string) error {
	if err == nil {
		return nil
	}
	reason := err.Code
	changed := false
	if len(method) >= 11 && method[:11] == "filesystem." {
		var detail v1.FileErrorDetail
		if proto.Unmarshal(err.Details, &detail) == nil {
			reason = detail.Reason
			changed = detail.MutationState == v1.MutationState_MUTATION_STATE_MAY_HAVE_CHANGED
		}
		if (method == "filesystem.write" || method == "filesystem.mkdir") && (len(err.Details) == 0 || detail.MutationState == v1.MutationState_MUTATION_STATE_UNSPECIFIED) {
			return &environment.Error{Code: "OUTCOME_UNKNOWN", Reason: "file mutation not confirmed", MayHaveChanged: true, Cause: errors.New(err.Code + ": " + err.Message)}
		}
	}
	var cause error = errors.New(err.Message)
	if err.Code == "CANCELLED" {
		cause = errors.Join(cause, context.Canceled)
	} else if err.Code == "DEADLINE_EXCEEDED" {
		cause = errors.Join(cause, context.DeadlineExceeded)
	}
	return &environment.Error{Code: err.Code, Reason: reason, MayHaveChanged: changed, Cause: cause}
}
func (c *Client) call(ctx context.Context, method string, in, out proto.Message, lease []byte) error {
	key, p, err := c.begin(ctx, method, in, lease)
	if err != nil {
		return err
	}
	defer c.end(key, p)
	frame, err := c.next(ctx, p)
	if err != nil {
		c.mu.Lock()
		sent := p.sent
		c.mu.Unlock()
		if !sent {
			return environment.Fail(environment.Code(err), "NOT_SENT", err)
		}
		if !control(method) && c.peer.ctx.Err() == nil {
			clean, cancel := context.WithTimeout(context.Background(), cleanupGrace)
			defer cancel()
			_ = c.call(clean, "request.cancel", &v1.CancelRequest{RequestId: key}, new(v1.CancelRequestResponse), nil)
		}
		return err
	}
	response := frame.GetResponse()
	if response == nil {
		return environment.Fail("PROTOCOL_ERROR", "expected response", nil)
	}
	if response.GetError() != nil {
		return fromRPC(response.GetError(), method)
	}
	if err = proto.Unmarshal(response.GetBody(), out); err != nil {
		return environment.Fail("PROTOCOL_ERROR", "invalid response body", err)
	}
	return nil
}
func (c *Client) refresh(ctx context.Context, target string) (*v1.GetInfoResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	begin := time.Now()
	info := new(v1.GetInfoResponse)
	if err := c.call(ctx, "environment.getInfo", &v1.GetInfoRequest{TargetId: target}, info, nil); err != nil {
		return nil, err
	}
	if !validateInfo(info, target) {
		return nil, environment.Fail("PROTOCOL_ERROR", "invalid target capabilities", nil)
	}
	c.mu.Lock()
	c.infos[target] = proto.Clone(info).(*v1.GetInfoResponse)
	if info.AdmissionLease != nil {
		c.leaseTimes[target] = begin.Add(time.Duration(info.AdmissionLease.RemainingTtlMs) * time.Millisecond)
	}
	c.mu.Unlock()
	return info, nil
}
func (c *Client) lease(ctx context.Context, target string) ([]byte, error) {
	c.mu.Lock()
	info := c.infos[target]
	expiry := c.leaseTimes[target]
	c.mu.Unlock()
	if info == nil {
		return nil, environment.Fail("NOT_FOUND", "target not initialized", nil)
	}
	if !info.BashAvailable {
		return nil, environment.Fail("SHELL_UNAVAILABLE", "target Bash unavailable", nil)
	}
	if time.Until(expiry) < 5*time.Second {
		var err error
		info, err = c.refresh(ctx, target)
		if err != nil {
			return nil, err
		}
	}
	return append([]byte{}, info.AdmissionLease.Token...), nil
}
func (c *Client) Environment(target string) (*Environment, error) {
	c.mu.Lock()
	info := c.infos[target]
	c.mu.Unlock()
	if info == nil {
		return nil, environment.Fail("NOT_FOUND", "target not initialized", nil)
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Environment{client: c, target: target, ctx: ctx, cancel: cancel}, nil
}

type Environment struct {
	client *Client
	target string
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	closed bool
	active sync.WaitGroup
}

func (e *Environment) Filesystem() environment.Filesystem { return e }
func (e *Environment) Process() environment.Process       { return e }
func (e *Environment) Close(ctx context.Context) error {
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
		return environment.Fail("OUTCOME_UNKNOWN", "environment close not confirmed", ctx.Err())
	}
}
func (e *Environment) operation(ctx context.Context, budget time.Duration) (context.Context, func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return nil, nil, environment.Fail("CONNECTION_CLOSED", "remote environment closed", nil)
	}
	e.active.Add(1)
	e.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, budget)
	stop := context.AfterFunc(e.ctx, cancel)
	return ctx, func() { stop(); cancel(); e.active.Done() }, nil
}
