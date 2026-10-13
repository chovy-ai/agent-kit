package runner

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

type testOutput struct {
	responses chan Response
}

func (o *testOutput) Write(data []byte) (int, error) {
	var response Response
	if err := json.Unmarshal(data, &response); err != nil {
		return 0, err
	}
	o.responses <- response
	return len(data), nil
}

type harness struct {
	input     *io.PipeWriter
	responses <-chan Response
	finished  chan error
	close     func()
}

func start(t *testing.T, config Config) harness {
	t.Helper()
	reader, writer := io.Pipe()
	output := &testOutput{responses: make(chan Response, 128)}
	server, err := NewServer(config, Streams{Input: reader, Output: output, Logs: io.Discard}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- server.Serve(ctx) }()
	var once sync.Once
	close := func() { once.Do(func() { cancel(); writer.Close() }) }
	t.Cleanup(func() {
		close()
		select {
		case <-finished:
		case <-time.After(2 * time.Second):
			t.Error("runner did not stop")
		}
	})
	return harness{input: writer, responses: output.responses, finished: finished, close: close}
}

func (h harness) send(t *testing.T, request Request) {
	t.Helper()
	if err := json.NewEncoder(h.input).Encode(request); err != nil {
		t.Fatal(err)
	}
}

func (h harness) next(t *testing.T) Response {
	t.Helper()
	select {
	case response := <-h.responses:
		return response
	case <-time.After(2 * time.Second):
		t.Fatal("response timed out")
		return Response{}
	}
}

func TestHandshakeAndErrors(t *testing.T) {
	h := start(t, DefaultConfig())
	h.send(t, Request{Version: 1, ID: "hello", Method: "system.hello"})
	response := h.next(t)
	if response.Type != "result" || response.Result.(map[string]any)["name"] != "agent-kit" {
		t.Fatalf("unexpected handshake: %#v", response)
	}
	for _, scenario := range []struct {
		request Request
		code    string
	}{
		{Request{Version: 2, ID: "version", Method: "system.ping"}, "UNSUPPORTED_VERSION"},
		{Request{Version: 1, ID: "method", Method: "command.exec"}, "UNKNOWN_METHOD"},
		{Request{Version: 1, ID: "params", Method: "system.ping", Params: json.RawMessage(`{"delayMs":-1}`)}, "INVALID_PARAMS"},
		{Request{Version: 1, ID: "null", Method: "system.ping", Params: json.RawMessage(`null`)}, "INVALID_PARAMS"},
	} {
		h.send(t, scenario.request)
		response := h.next(t)
		if response.ID != scenario.request.ID || response.Error == nil || response.Error.Code != scenario.code {
			t.Fatalf("unexpected error: %#v", response)
		}
	}
}

func TestCancelBypassesFullOrdinaryRequestLimit(t *testing.T) {
	config := DefaultConfig()
	config.MaxConcurrent = 1
	h := start(t, config)
	h.send(t, Request{Version: 1, ID: "long", Method: "system.ping", Params: json.RawMessage(`{"delayMs":60000}`)})
	h.send(t, Request{Version: 1, ID: "busy", Method: "system.ping"})
	busy := h.next(t)
	if busy.ID != "busy" || busy.Error == nil || busy.Error.Code != "BUSY" {
		t.Fatalf("expected BUSY: %#v", busy)
	}
	h.send(t, Request{Version: 1, ID: "cancel", Method: "request.cancel", Params: json.RawMessage(`{"requestId":"long"}`)})
	responses := map[string]Response{}
	for range 2 {
		response := h.next(t)
		responses[response.ID] = response
	}
	if responses["long"].Error == nil || responses["long"].Error.Code != "CANCELLED" {
		t.Fatal("long request was not cancelled")
	}
	if responses["cancel"].Type != "result" {
		t.Fatal("control request was blocked")
	}
	h.send(t, Request{Version: 1, ID: "next", Method: "system.ping"})
	if response := h.next(t); response.Type != "result" {
		t.Fatalf("runner did not remain usable: %#v", response)
	}
}

func TestMalformedRequestDoesNotBreakFollowingRequests(t *testing.T) {
	h := start(t, DefaultConfig())
	if _, err := io.WriteString(h.input, "not json\n"); err != nil {
		t.Fatal(err)
	}
	if response := h.next(t); response.Error == nil || response.Error.Code != "INVALID_REQUEST" {
		t.Fatal("malformed request was not rejected")
	}
	h.send(t, Request{Version: 1, ID: "after", Method: "system.ping"})
	if response := h.next(t); response.ID != "after" || response.Type != "result" {
		t.Fatalf("runner cannot recover from malformed input: %#v", response)
	}
}

func TestShutdownCancelsActiveRequests(t *testing.T) {
	h := start(t, DefaultConfig())
	h.send(t, Request{Version: 1, ID: "long", Method: "system.ping", Params: json.RawMessage(`{"delayMs":60000}`)})
	h.send(t, Request{Version: 1, ID: "stop", Method: "system.shutdown"})
	responses := map[string]Response{}
	for range 2 {
		response := h.next(t)
		responses[response.ID] = response
	}
	if responses["stop"].Type != "result" || responses["long"].Error == nil || responses["long"].Error.Code != "CANCELLED" {
		t.Fatalf("shutdown did not finish requests: %#v", responses)
	}
	// Cleanup observes Serve's completion; no second consumer takes the result.
}

func TestEOFStopsOutstandingRequests(t *testing.T) {
	h := start(t, DefaultConfig())
	h.send(t, Request{Version: 1, ID: "long", Method: "system.ping", Params: json.RawMessage(`{"delayMs":60000}`)})
	h.input.Close()
	response := h.next(t)
	if response.Error == nil || response.Error.Code != "CANCELLED" {
		t.Fatalf("EOF did not cancel request: %#v", response)
	}
}

func TestMessageLimitAndInvalidConfiguration(t *testing.T) {
	config := DefaultConfig()
	config.MaxConcurrent = 0
	if _, err := NewServer(config, Streams{}, nil); err == nil {
		t.Fatal("invalid configuration was accepted")
	}
	config = DefaultConfig()
	config.MaxMessageBytes = 1024
	h := start(t, config)
	go func() { _, _ = h.input.Write(make([]byte, 2048)) }()
	// Once the oversized reader stops, Serve closes the pipe, releasing the writer.
	select {
	case err := <-h.finished:
		if err == nil {
			t.Fatal("oversized input was accepted")
		}
		// Preserve the outcome for the common cleanup observer.
		h.finished <- err
	case <-time.After(2 * time.Second):
		t.Fatal("oversized frame did not stop runner")
	}
}
