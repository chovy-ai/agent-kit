package remote

import (
	"agent-kit/environment"
	"agent-kit/internal/remoteproto/v1"
	"context"
	"errors"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
	"sync"
	"time"
)

type queued struct {
	data        []byte
	control     bool
	ctx         context.Context
	beforeWrite func() bool
	discard     func()
}
type peer struct {
	conn                                     *websocket.Conn
	ctx                                      context.Context
	cancel                                   context.CancelFunc
	wake                                     chan struct{}
	mu                                       sync.Mutex
	queues                                   map[string][]queued
	order                                    []string
	bytes, items, controlBytes, controlItems int
	err                                      error
	done                                     chan struct{}
	onMessage                                func(*v1.Envelope) error
	onFail                                   func(error)
	once                                     sync.Once
}

func newPeer(conn *websocket.Conn) *peer {
	ctx, cancel := context.WithCancel(context.Background())
	conn.SetReadLimit(maxMessage)
	return &peer{conn: conn, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), queues: make(map[string][]queued), done: make(chan struct{})}
}
func (p *peer) start() { go p.read(); go p.write(); go p.heartbeat() }
func (p *peer) fail(err error) {
	p.once.Do(func() {
		p.mu.Lock()
		p.err = err
		p.queues = make(map[string][]queued)
		p.order = nil
		p.mu.Unlock()
		p.cancel()
		p.conn.CloseNow()
		if p.onFail != nil {
			p.onFail(err)
		}
		close(p.done)
	})
}
func (p *peer) send(msg *v1.Envelope, priority bool) error {
	return p.enqueue(msg, priority, nil, nil, nil)
}
func (p *peer) enqueue(msg *v1.Envelope, priority bool, ctx context.Context, beforeWrite func() bool, discard func()) error {
	data, err := proto.Marshal(msg)
	if err != nil {
		return environment.Fail("PROTOCOL_ERROR", "encode message", err)
	}
	if len(data) > maxMessage {
		return environment.Fail("RESOURCE_EXHAUSTED", "message limit", nil)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.err != nil {
		return p.err
	}
	if priority {
		if p.controlItems >= 64 || p.controlBytes+len(data) > 256<<10 {
			return environment.Fail("RESOURCE_EXHAUSTED", "control queue", nil)
		}
	} else if p.items >= 256 || p.bytes+len(data) > 4<<20 {
		return environment.Fail("RESOURCE_EXHAUSTED", "send queue", nil)
	}
	if len(p.queues[msg.RequestId]) == 0 {
		p.order = append(p.order, msg.RequestId)
	}
	p.queues[msg.RequestId] = append(p.queues[msg.RequestId], queued{data: data, control: priority, ctx: ctx, beforeWrite: beforeWrite, discard: discard})
	if priority {
		p.controlItems++
		p.controlBytes += len(data)
	} else {
		p.items++
		p.bytes += len(data)
	}
	select {
	case p.wake <- struct{}{}:
	default:
	}
	return nil
}
func (p *peer) pop() (queued, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.order) == 0 {
		return queued{}, false
	}
	index := 0
	for i, key := range p.order {
		if p.queues[key][0].control {
			index = i
			break
		}
	}
	key := p.order[index]
	q := p.queues[key][0]
	p.queues[key] = p.queues[key][1:]
	p.order = append(p.order[:index], p.order[index+1:]...)
	if len(p.queues[key]) == 0 {
		delete(p.queues, key)
	} else {
		p.order = append(p.order, key)
	}
	if q.control {
		p.controlItems--
		p.controlBytes -= len(q.data)
	} else {
		p.items--
		p.bytes -= len(q.data)
	}
	return q, true
}
func (p *peer) write() {
	for {
		q, ok := p.pop()
		if !ok {
			select {
			case <-p.ctx.Done():
				return
			case <-p.wake:
				continue
			}
		}
		ctx, cancel := context.WithTimeout(p.ctx, 5*time.Second)
		if q.ctx != nil && q.ctx.Err() != nil {
			cancel()
			if q.discard != nil {
				q.discard()
			}
			continue
		}
		if q.beforeWrite != nil && !q.beforeWrite() {
			cancel()
			if q.discard != nil {
				q.discard()
			}
			continue
		}
		err := p.conn.Write(ctx, websocket.MessageBinary, q.data)
		cancel()
		if err != nil {
			p.fail(environment.Fail("CONNECTION_CLOSED", "WS write failed", err))
			return
		}
	}
}
func (p *peer) read() {
	for {
		kind, data, err := p.conn.Read(p.ctx)
		if err != nil {
			p.fail(environment.Fail("CONNECTION_CLOSED", "WS read failed", err))
			return
		}
		msg := new(v1.Envelope)
		if kind != websocket.MessageBinary || proto.Unmarshal(data, msg) != nil || msg.RequestId == "" || msg.Kind == nil {
			p.fail(environment.Fail("PROTOCOL_ERROR", "invalid WS envelope", nil))
			return
		}
		if err = p.onMessage(msg); err != nil {
			p.fail(err)
			return
		}
	}
}
func (p *peer) heartbeat() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(p.ctx, 5*time.Second)
			err := p.conn.Ping(ctx)
			cancel()
			if err != nil {
				p.fail(environment.Fail("CONNECTION_CLOSED", "WS heartbeat failed", err))
				return
			}
		}
	}
}
func (p *peer) close() {
	p.fail(environment.Fail("CONNECTION_CLOSED", "connection closed by owner", nil))
}
func (p *peer) graceful(ctx context.Context) {
	done := make(chan struct{})
	go func() { _ = p.conn.Close(websocket.StatusNormalClosure, "owner closed"); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		p.conn.CloseNow()
		<-done
	}
	p.close()
}
func connectionError(err error) error {
	if err == nil {
		return nil
	}
	var e *environment.Error
	if errors.As(err, &e) {
		return err
	}
	return environment.Fail("CONNECTION_CLOSED", "WS connection failed", err)
}
