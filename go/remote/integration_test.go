package remote

import (
	"agent-kit/environment"
	"agent-kit/environment/local"
	v1 "agent-kit/internal/remoteproto/v1"
	"bufio"
	"bytes"
	"context"
	"fmt"
	"google.golang.org/protobuf/proto"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"
)

func TestRemoteHelper(t *testing.T) {
	if os.Getenv("AGENT_KIT_TEST_SERVER") != "1" {
		return
	}
	env, err := local.New(local.Config{Cwd: os.Getenv("AGENT_KIT_TEST_CWD")})
	if err != nil {
		panic(err)
	}
	server, err := NewServer(map[string]Target{"host": env, "other": env})
	if err != nil {
		panic(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	httpServer := &http.Server{Handler: server}
	go httpServer.Serve(listener)
	fmt.Println("ws://" + listener.Addr().String())
	io.Copy(io.Discard, os.Stdin)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Close(ctx)
	httpServer.Close()
}

func TestDisconnectFailsImmediatelyAndCleansOwnedExecution(t *testing.T) {
	target, err := local.New(local.Config{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(map[string]Target{"host": target})
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		server.Close(ctx)
	})
	client, err := Dial(context.Background(), "ws"+httpServer.URL[4:], []string{"host"})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	env, _ := client.Environment("host")
	defer env.Close(context.Background())
	started := make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		result, err := env.Exec(context.Background(), environment.ExecRequest{Command: "printf ready; (sleep 0.5; printf leaked > leak) & wait"}, func(context.Context, environment.OutputChunk) error {
			select {
			case <-started:
			default:
				close(started)
			}
			return nil
		})
		if result.Completion != environment.Unconfirmed {
			finished <- fmt.Errorf("unexpected completion %s", result.Completion)
			return
		}
		finished <- err
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("execution did not start")
	}
	client.peer.close()
	select {
	case err := <-finished:
		if environment.Code(err) != "OUTCOME_UNKNOWN" {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("disconnected client waited for recovery")
	}
	if _, err = env.ReadFile(context.Background(), environment.ReadRequest{Path: "leak"}); environment.Code(err) != "CONNECTION_CLOSED" {
		t.Fatalf("failed client accepted new request: %v", err)
	}
	time.Sleep(600 * time.Millisecond)
	if _, err = os.Stat(target.DefaultCwd() + "/leak"); !os.IsNotExist(err) {
		t.Fatalf("disconnected command left a child running: %v", err)
	}
}

func TestUnknownTargetFailsInitializationWithoutLeakingSession(t *testing.T) {
	target, err := local.New(local.Config{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	server, _ := NewServer(map[string]Target{"host": target})
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	defer server.Close(context.Background())
	if _, err = Dial(context.Background(), "ws"+httpServer.URL[4:], []string{"missing"}); environment.Code(err) != "NOT_FOUND" {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		server.mu.Lock()
		count := len(server.sessions)
		server.mu.Unlock()
		if count == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("failed initialization retained session")
}
func startRemote(t *testing.T) (*Client, *Environment) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestRemoteHelper$")
	cmd.Env = append(os.Environ(), "AGENT_KIT_TEST_SERVER=1", "AGENT_KIT_TEST_CWD="+t.TempDir())
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		t.Fatal("server endpoint missing")
	}
	endpoint := scanner.Text()
	go io.Copy(io.Discard, stdout)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, endpoint, []string{"host", "other"})
	if err != nil {
		stdin.Close()
		cmd.Process.Kill()
		cmd.Wait()
		t.Fatal(err)
	}
	env, err := client.Environment("host")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		env.Close(ctx)
		client.Close()
		stdin.Close()
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-ctx.Done():
			cmd.Process.Kill()
			<-done
			t.Error("server shutdown timeout")
		}
	})
	return client, env
}
func TestRemoteTwoProcessesFilesAndExec(t *testing.T) {
	client, env := startRemote(t)
	ctx := context.Background()
	payload := append([]byte{0, 255}, bytes.Repeat([]byte("content"), 20000)...)
	if err := env.WriteFile(ctx, "binary", payload); err != nil {
		t.Fatal(err)
	}
	data, err := env.ReadFile(ctx, environment.ReadRequest{Path: "binary"})
	if err != nil || !bytes.Equal(payload, data) {
		t.Fatalf("binary read %d %v", len(data), err)
	}
	if err = env.WriteFile(ctx, "empty", []byte{}); err != nil {
		t.Fatal(err)
	}
	if err = env.Mkdir(ctx, "nested/dir", true); err != nil {
		t.Fatal(err)
	}
	info, err := env.Stat(ctx, "binary", false)
	if err != nil || info.Size != int64(len(payload)) {
		t.Fatalf("stat %+v %v", info, err)
	}
	entries, err := env.ReadDir(ctx, ".")
	if err != nil || len(entries) != 3 {
		t.Fatalf("entries %+v %v", entries, err)
	}
	result, err := env.Exec(ctx, environment.ExecRequest{Command: "printf remote; printf error >&2; exit 9"}, nil)
	if err != nil || result.ExitCode == nil || *result.ExitCode != 9 || string(result.Stdout) != "remote" || string(result.Stderr) != "error" {
		t.Fatalf("exec %+v %v", result, err)
	}
	other, _ := client.Environment("other")
	defer other.Close(ctx)
	if err := env.Close(ctx); err != nil {
		t.Fatal(err)
	}
	result, err = other.Exec(ctx, environment.ExecRequest{Command: "printf shared"}, nil)
	if err != nil || string(result.Stdout) != "shared" {
		t.Fatalf("shared after close %+v %v", result, err)
	}
}
func TestRemoteCancellationPreservesConnection(t *testing.T) {
	_, env := startRemote(t)
	ctx := context.Background()
	result, err := env.Exec(ctx, environment.ExecRequest{Command: "printf ready; sleep 30 & wait", Timeout: 150 * time.Millisecond}, nil)
	if environment.Code(err) != "DEADLINE_EXCEEDED" || result.Completion != environment.Finished {
		t.Fatalf("cancel %+v %v", result, err)
	}
	result, err = env.Exec(ctx, environment.ExecRequest{Command: "printf alive"}, nil)
	if err != nil || string(result.Stdout) != "alive" {
		t.Fatalf("connection lost %+v %v", result, err)
	}
}
func TestConcurrentRemoteStreams(t *testing.T) {
	_, env := startRemote(t)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			command := fmt.Sprintf("printf command-%d; sleep 0.1; printf done >&2", i)
			r, err := env.Exec(context.Background(), environment.ExecRequest{Command: command}, nil)
			if err != nil || string(r.Stdout) != fmt.Sprintf("command-%d", i) || string(r.Stderr) != "done" {
				t.Errorf("stream %+v %v", r, err)
			}
		}(i)
	}
	wg.Wait()
}
func TestCancelBeforeExecAndLeaseExpiry(t *testing.T) {
	client, _ := startRemote(t)
	ctx := context.Background()
	lease, err := client.lease(ctx, "host")
	if err != nil {
		t.Fatal(err)
	}
	execution := id()
	out := new(v1.ProcessCancelResponse)
	if err = client.call(ctx, "process.cancel", &v1.ProcessCancelRequest{TargetId: "host", ExecutionId: execution}, out, lease); err != nil || out.Disposition != v1.ProcessCancelDisposition_PROCESS_CANCEL_DISPOSITION_ACCEPTED {
		t.Fatalf("pre cancel %+v %v", out, err)
	}
	for _, token := range [][]byte{lease, []byte("expired")} {
		key, p, err := client.begin(ctx, "process.exec", &v1.ExecRequest{TargetId: "host", ExecutionId: execution, Command: "touch should-not-exist"}, token)
		if err != nil {
			t.Fatal(err)
		}
		frame, err := client.next(ctx, p)
		client.end(key, p)
		if err != nil || frame.GetResponse().GetError() == nil {
			t.Fatalf("expected rejection %+v %v", frame, err)
		}
	}
	env, _ := client.Environment("host")
	defer env.Close(ctx)
	_, err = env.Stat(ctx, "should-not-exist", false)
	if environment.Code(err) != "NOT_FOUND" {
		t.Fatal("rejected Exec produced side effect", err)
	}
}
func TestProtoPresence(t *testing.T) {
	for _, pair := range [][2]proto.Message{{&v1.WriteRequest{}, &v1.WriteRequest{Data: []byte{}}}, {&v1.ExecTerminal{}, &v1.ExecTerminal{ExitCode: proto.Int64(0)}}, {&v1.RpcResponse{}, &v1.RpcResponse{Outcome: &v1.RpcResponse_Body{Body: []byte{}}}}} {
		a, _ := proto.Marshal(pair[0])
		b, _ := proto.Marshal(pair[1])
		if bytes.Equal(a, b) {
			t.Fatal("presence lost")
		}
	}
}
