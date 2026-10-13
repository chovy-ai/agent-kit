package execution

import (
	"errors"
	"syscall"
)

func (s *processScope) done() bool {
	return errors.Is(syscall.Kill(-s.cmd.Process.Pid, 0), syscall.ESRCH)
}
