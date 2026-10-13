package main

import (
	"agent-kit/environment/local"
	"agent-kit/internal/di"
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func run() error {
	listen := flag.String("listen", "127.0.0.1:9220", "WS listener address")
	target := flag.String("target", "host", "Registered target ID")
	cwd := flag.String("cwd", "", "Target default directory")
	bash := flag.String("bash", "", "Target Bash executable")
	flag.Parse()
	server, err := di.InitializeRemote(di.RemoteOptions{TargetID: *target, Local: local.Config{Cwd: *cwd, Bash: *bash}})
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	httpServer := &http.Server{Handler: server, ReadHeaderTimeout: 5 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	failure := make(chan error, 1)
	go func() { failure <- httpServer.Serve(listener) }()
	fmt.Fprintf(os.Stderr, "remote endpoint: ws://%s\n", listener.Addr())
	select {
	case <-ctx.Done():
	case err = <-failure:
	}
	cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	closeErr := server.Close(cleanup)
	httpServer.Shutdown(cleanup)
	if err != nil && err != http.ErrServerClosed {
		return err
	}
	return closeErr
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
