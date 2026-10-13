//go:build linux || darwin

package execution

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

type processScope struct{ cmd *exec.Cmd }

func envKey(key string) string { return key }
func launch(bash, command, cwd string, env []string, out, errout *os.File) (*processScope, error) {
	cmd := exec.Command(bash, "-c", command)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.Stdout = out
	cmd.Stderr = errout
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &processScope{cmd: cmd}, nil
}
func (s *processScope) wait() waitResult {
	err := s.cmd.Wait()
	code := int64(s.cmd.ProcessState.ExitCode())
	r := waitResult{err: err}
	if code >= 0 {
		r.code = &code
	}
	if status, ok := s.cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		r.signal = status.Signal().String()
	}
	return r
}
func (s *processScope) kill() error {
	err := syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
func (s *processScope) close() {}
