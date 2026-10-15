package runner

import (
	"agent-kit/environment"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"
)

type Config struct {
	MaxMessageBytes                         int
	MaxConcurrent                           int
	Cwd, Bash, RemoteEndpoint, RemoteTarget string
	Environments                            map[string]environment.Definition
}

func DefaultConfig() Config {
	return Config{MaxMessageBytes: 1024 * 1024, MaxConcurrent: 32}
}

type Streams struct {
	Input  io.Reader
	Output io.Writer
	Logs   io.Writer
}

type Server struct {
	config    Config
	streams   Streams
	logger    *slog.Logger
	outputMu  sync.Mutex
	activeMu  sync.Mutex
	active    map[string]context.CancelFunc
	directory environment.Directory
}

func NewBusinessServer(config Config, streams Streams, logger *slog.Logger, directory environment.Directory) (*Server, error) {
	if directory == nil {
		return nil, errors.New("environment directory is required")
	}
	s, err := NewServer(config, streams, logger)
	if err != nil {
		return nil, err
	}
	s.directory = directory
	return s, nil
}

func NewServer(config Config, streams Streams, logger *slog.Logger) (*Server, error) {
	if config.MaxMessageBytes < 1024 || config.MaxConcurrent < 1 {
		return nil, errors.New("invalid runner limits")
	}
	if streams.Input == nil || streams.Output == nil || streams.Logs == nil || logger == nil {
		return nil, errors.New("runner streams and logger are required")
	}
	return &Server{config: config, streams: streams, logger: logger, active: make(map[string]context.CancelFunc)}, nil
}

func (s *Server) Serve(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	if closer, ok := s.streams.Input.(io.Closer); ok {
		defer closer.Close()
	}
	lines := make(chan []byte)
	readErrors := make(chan error, 1)
	failures := make(chan error, 1)
	shutdown := make(chan struct{})
	var shutdownOnce sync.Once
	var workers sync.WaitGroup
	permits := make(chan struct{}, s.config.MaxConcurrent)
	go func() {
		scanner := bufio.NewScanner(s.streams.Input)
		scanner.Buffer(make([]byte, 1024), s.config.MaxMessageBytes)
		for scanner.Scan() {
			line := bytes.Clone(scanner.Bytes())
			select {
			case lines <- line:
			case <-ctx.Done():
				return
			}
		}
		readErrors <- scanner.Err()
	}()
	write := func(response Response) {
		s.outputMu.Lock()
		data, err := json.Marshal(response)
		if err == nil && len(data) > s.config.MaxMessageBytes {
			data, _ = json.Marshal(Response{Version: ProtocolVersion, ID: response.ID, Type: "error", Error: &RPCError{Code: "MESSAGE_TOO_LARGE", Message: "Encoded result exceeds runner message limit"}})
		}
		if err == nil {
			_, err = s.streams.Output.Write(append(data, '\n'))
		}
		s.outputMu.Unlock()
		if err != nil {
			select {
			case failures <- fmt.Errorf("write response: %w", err):
			default:
			}
			cancel()
		}
	}
	respondError := func(id, code, message string) {
		write(Response{Version: ProtocolVersion, ID: id, Type: "error", Error: &RPCError{Code: code, Message: message}})
	}
	s.logger.Info("runner started", "protocolVersion", ProtocolVersion)
	var serveError error
loop:
	for {
		select {
		case <-ctx.Done():
			if parent.Err() != nil {
				serveError = parent.Err()
			}
			break loop
		case <-shutdown:
			break loop
		case err := <-failures:
			serveError = err
			break loop
		case err := <-readErrors:
			if err != nil {
				serveError = fmt.Errorf("read request: %w", err)
			}
			break loop
		case line := <-lines:
			var request Request
			if err := decode(line, &request); err != nil || request.ID == "" || request.Method == "" {
				respondError(request.ID, "INVALID_REQUEST", "Expected a JSON request with id and method")
				continue
			}
			if request.Version != ProtocolVersion {
				respondError(request.ID, "UNSUPPORTED_VERSION", "Unsupported protocol version")
				continue
			}
			control := request.Method == "request.cancel" || request.Method == "system.shutdown"
			if !control {
				select {
				case permits <- struct{}{}:
				default:
					respondError(request.ID, "BUSY", "Runner concurrency limit reached")
					continue
				}
			}
			requestCtx, requestCancel := context.WithCancel(ctx)
			s.activeMu.Lock()
			_, duplicate := s.active[request.ID]
			if !duplicate {
				s.active[request.ID] = requestCancel
			}
			s.activeMu.Unlock()
			if duplicate {
				requestCancel()
				if !control {
					<-permits
				}
				respondError(request.ID, "DUPLICATE_REQUEST", "Request id is already active")
				continue
			}
			workers.Add(1)
			go func() {
				defer workers.Done()
				var finishOnce sync.Once
				finish := func() {
					finishOnce.Do(func() {
						requestCancel()
						s.activeMu.Lock()
						delete(s.active, request.ID)
						s.activeMu.Unlock()
						if !control {
							<-permits
						}
					})
				}
				defer finish()
				result, rpcError := s.handle(requestCtx, request)
				// Completion frees capacity before the client receives the terminal message.
				finish()
				if rpcError != nil {
					write(Response{Version: ProtocolVersion, ID: request.ID, Type: "error", Error: rpcError})
				} else {
					write(Response{Version: ProtocolVersion, ID: request.ID, Type: "result", Result: result})
				}
				if request.Method == "system.shutdown" && rpcError == nil {
					shutdownOnce.Do(func() { close(shutdown) })
				}
			}()
		}
	}
	cancel()
	workers.Wait()
	select {
	case err := <-failures:
		serveError = err
	default:
	}
	s.logger.Info("runner stopped")
	return serveError
}

func decode(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("expected exactly one JSON value")
	}
	return nil
}

func params(request Request, target any) error {
	data := request.Params
	if len(data) == 0 {
		data = []byte("{}")
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errors.New("params must be an object")
	}
	return decode(data, target)
}

func (s *Server) handle(ctx context.Context, request Request) (any, *RPCError) {
	invalid := func() (any, *RPCError) {
		return nil, &RPCError{Code: "INVALID_PARAMS", Message: "Invalid method parameters"}
	}
	switch request.Method {
	case "system.hello":
		if params(request, &struct{}{}) != nil {
			return invalid()
		}
		methods := append([]string{}, Methods...)
		if s.directory != nil {
			methods = append(methods, BusinessMethods...)
		}
		return map[string]any{"name": "agent-kit", "protocolVersion": ProtocolVersion, "methods": methods, "events": []string{"process.output"}}, nil
	case "system.ping":
		var input struct {
			DelayMs int `json:"delayMs"`
		}
		if params(request, &input) != nil || input.DelayMs < 0 || input.DelayMs > 60000 {
			return invalid()
		}
		timer := time.NewTimer(time.Duration(input.DelayMs) * time.Millisecond)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil, &RPCError{Code: "CANCELLED", Message: "Request cancelled"}
		case <-timer.C:
			return map[string]any{"ok": true}, nil
		}
	case "request.cancel":
		var input struct {
			RequestID string `json:"requestId"`
		}
		if params(request, &input) != nil || input.RequestID == "" || input.RequestID == request.ID {
			return invalid()
		}
		s.activeMu.Lock()
		cancel := s.active[input.RequestID]
		s.activeMu.Unlock()
		if cancel != nil {
			cancel()
		}
		return map[string]any{"cancelled": cancel != nil}, nil
	case "system.shutdown":
		if params(request, &struct{}{}) != nil {
			return invalid()
		}
		return map[string]any{"stopping": true}, nil
	default:
		if s.directory != nil {
			return s.business(ctx, request)
		}
		return nil, &RPCError{Code: "UNKNOWN_METHOD", Message: "Method is not available in this framework"}
	}
}
