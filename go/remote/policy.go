// Package remote implements the shared WS RPC adapter and execution server.
package remote

import (
	"agent-kit/internal/remoteproto/v1"
	"crypto/rand"
	"encoding/hex"
	"time"
)

const Subprotocol = "agentkit.remote.v1.pb"
const maxMessage = 2 << 20

var methods = []string{"system.hello", "environment.getInfo", "request.cancel", "filesystem.read", "filesystem.write", "filesystem.readDir", "filesystem.stat", "filesystem.mkdir", "process.exec", "process.cancel", "process.getState"}

func id() string {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		panic(err)
	}
	data[6] = (data[6] & 15) | 64
	data[8] = (data[8] & 63) | 128
	h := hex.EncodeToString(data[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func control(method string) bool {
	return method == "system.hello" || method == "environment.getInfo" || method == "request.cancel" || method == "process.cancel" || method == "process.getState"
}
func channelLimits() *v1.ChannelLimits {
	return &v1.ChannelLimits{MaxMessageBytes: maxMessage, MaxPendingRequests: 32, MaxControlRequests: 8, MaxWriteQueueBytes: 4 << 20, MaxWriteQueueMessages: 256, ControlQueueBytes: 256 << 10, ControlQueueMessages: 64, MaxSessions: 32, MaxActiveRequests: 128, MaxActiveControlRequests: 32}
}
func timeouts() *v1.TimeoutDefaults {
	return &v1.TimeoutDefaults{SdkInitMs: 10000, WsConnectMs: 5000, HelloMs: 3000, GetInfoMs: 3000, FileRpcMs: 10000, ControlRpcMs: 2000, HeartbeatIntervalMs: 15000, PongWaitMs: 5000, WriteIoMs: 5000, ExecDeliveryGraceMs: 3000, CloseGraceMs: 5000, MaxFileRpcMs: 60000, MaxControlRpcMs: 10000}
}
func fsLimits() *v1.FilesystemLimits {
	return &v1.FilesystemLimits{MaxReadChunkBytes: 65536, MaxWriteBytes: 1 << 20, MaxDirectoryEntries: 10000, MaxDirectoryResponseBytes: 1 << 20, MaxConcurrentSessionRequests: 16, MaxConcurrentGlobalRequests: 64, MaxPathBytes: 65536}
}
func processLimits() *v1.ProcessLimits {
	return &v1.ProcessLimits{DefaultTimeoutMs: 60000, MaxTimeoutMs: 3600000, CleanupGraceMs: 2000, DefaultCaptureBytes: 1 << 20, MaxCaptureBytes: 8 << 20, MaxOutputChunkBytes: 65536, MaxForwardBytes: 8 << 20, MaxActiveSessionExecutions: 4, MaxActiveGlobalExecutions: 16, ExecutionOutputQueueBytes: 1 << 20, ExecutionOutputQueueMessages: 128, TerminalRetentionMs: 120000, AdmissionLeaseTtlMs: 30000, MaxExecutionRecords: 4096, MaxCancelMarkerRecords: 1024, LeaseRefreshMarginMs: 5000, MaxCommandBytes: 65536, MaxEnvEntries: 128, MaxEnvTotalBytes: 65536, MaxCwdBytes: 65536, MaxAdmissionLeases: 4096}
}

const cleanupGrace = 2 * time.Second
