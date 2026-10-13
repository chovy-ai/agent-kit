package execution

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func (s *processScope) done() bool {
	if errors.Is(syscall.Kill(-s.cmd.Process.Pid, 0), syscall.ESRCH) {
		return true
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false
	}
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		data, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		end := strings.LastIndex(string(data), ")")
		if end < 0 {
			continue
		}
		fields := strings.Fields(string(data)[end+1:])
		if len(fields) < 3 {
			continue
		}
		group, _ := strconv.Atoi(fields[2])
		if group == s.cmd.Process.Pid && fields[0] != "Z" && fields[0] != "X" {
			return false
		}
	}
	return true
}
