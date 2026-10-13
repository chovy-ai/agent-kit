//go:build windows

package execution

import (
	"golang.org/x/sys/windows"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

type processScope struct{ process, job windows.Handle }

func envKey(key string) string { return strings.ToUpper(key) }
func launch(bash, command, cwd string, env []string, out, errout *os.File) (scope *processScope, err error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			windows.CloseHandle(job)
		}
	}()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, err
	}
	stdin, err := os.Open(os.DevNull)
	if err != nil {
		return nil, err
	}
	defer stdin.Close()
	files := []*os.File{stdin, out, errout}
	handles := make([]windows.Handle, 3)
	for i, f := range files {
		err = windows.DuplicateHandle(windows.CurrentProcess(), windows.Handle(f.Fd()), windows.CurrentProcess(), &handles[i], 0, true, windows.DUPLICATE_SAME_ACCESS)
		if err != nil {
			return nil, err
		}
		defer windows.CloseHandle(handles[i])
	}
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, err
	}
	defer attrs.Delete()
	if err = attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]), uintptr(len(handles))*unsafe.Sizeof(handles[0])); err != nil {
		return nil, err
	}
	si := windows.StartupInfoEx{}
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Flags = windows.STARTF_USESTDHANDLES
	si.StdInput = handles[0]
	si.StdOutput = handles[1]
	si.StdErr = handles[2]
	si.ProcThreadAttributeList = attrs.List()
	app, err := windows.UTF16PtrFromString(bash)
	if err != nil {
		return nil, err
	}
	line, err := windows.UTF16PtrFromString(syscall.EscapeArg(bash) + " -c " + syscall.EscapeArg(command))
	if err != nil {
		return nil, err
	}
	dir, err := windows.UTF16PtrFromString(cwd)
	if err != nil {
		return nil, err
	}
	block := []uint16{}
	for _, entry := range env {
		encoded, err := windows.UTF16FromString(entry)
		if err != nil {
			return nil, err
		}
		block = append(block, encoded...)
	}
	block = append(block, 0)
	if len(block) == 1 {
		block = append(block, 0)
	}
	pi := windows.ProcessInformation{}
	if err = windows.CreateProcess(app, line, nil, nil, true, windows.CREATE_SUSPENDED|windows.CREATE_UNICODE_ENVIRONMENT|windows.EXTENDED_STARTUPINFO_PRESENT, &block[0], dir, &si.StartupInfo, &pi); err != nil {
		return nil, err
	}
	defer windows.CloseHandle(pi.Thread)
	if err = windows.AssignProcessToJobObject(job, pi.Process); err != nil {
		windows.TerminateProcess(pi.Process, 1)
		windows.WaitForSingleObject(pi.Process, windows.INFINITE)
		windows.CloseHandle(pi.Process)
		return nil, err
	}
	if _, err = windows.ResumeThread(pi.Thread); err != nil {
		windows.TerminateJobObject(job, 1)
		windows.WaitForSingleObject(pi.Process, windows.INFINITE)
		windows.CloseHandle(pi.Process)
		return nil, err
	}
	success = true
	return &processScope{process: pi.Process, job: job}, nil
}
func (s *processScope) wait() waitResult {
	_, err := windows.WaitForSingleObject(s.process, windows.INFINITE)
	if err != nil {
		return waitResult{err: err}
	}
	var code uint32
	if err = windows.GetExitCodeProcess(s.process, &code); err != nil {
		return waitResult{err: err}
	}
	n := int64(code)
	return waitResult{code: &n}
}
func (s *processScope) kill() error { return windows.TerminateJobObject(s.job, 1) }
func (s *processScope) done() bool {
	var data struct {
		TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
		TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
	}
	err := windows.QueryInformationJobObject(s.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&data)), uint32(unsafe.Sizeof(data)), nil)
	return err == nil && data.ActiveProcesses == 0
}
func (s *processScope) close() { windows.CloseHandle(s.process); windows.CloseHandle(s.job) }
