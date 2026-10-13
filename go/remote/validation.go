package remote

import (
	v1 "agent-kit/internal/remoteproto/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

func positivePolicy(msg proto.Message) bool {
	if msg == nil {
		return false
	}
	m := msg.ProtoReflect()
	if !m.IsValid() {
		return false
	}
	fields := m.Descriptor().Fields()
	for i := 0; i < fields.Len(); i++ {
		field := fields.Get(i)
		switch field.Kind() {
		case protoreflect.Uint32Kind, protoreflect.Uint64Kind:
			if m.Get(field).Uint() == 0 {
				return false
			}
		}
	}
	return true
}
func validateHello(in *v1.HelloResponse) bool {
	if in.ProtocolVersion != 1 || in.ServiceInstance == "" || in.SessionId == "" || !positivePolicy(in.ChannelLimits) || !positivePolicy(in.Timeouts) || in.ChannelLimits.MaxMessageBytes < 65536 || in.ChannelLimits.MaxMessageBytes > maxMessage {
		return false
	}
	found := map[string]bool{}
	for _, method := range in.Methods {
		found[method] = true
	}
	for _, method := range methods {
		if !found[method] {
			return false
		}
	}
	return true
}
func validateInfo(in *v1.GetInfoResponse, target string) bool {
	if in.TargetId != target || in.Platform < v1.Platform_PLATFORM_WINDOWS || in.Platform > v1.Platform_PLATFORM_MACOS || in.DefaultCwd == "" || !in.FilesystemAvailable || !positivePolicy(in.FilesystemLimits) || !positivePolicy(in.ProcessLimits) {
		return false
	}
	f, p := in.FilesystemLimits, in.ProcessLimits
	if f.MaxReadChunkBytes > 65536 || f.MaxReadChunkBytes+1024 > maxMessage || f.MaxWriteBytes > 1<<20 || f.MaxDirectoryResponseBytes > maxMessage-1024 || p.DefaultTimeoutMs > p.MaxTimeoutMs || p.MaxTimeoutMs > 3600000 || p.DefaultCaptureBytes > p.MaxCaptureBytes || p.MaxCaptureBytes > 8<<20 || p.MaxOutputChunkBytes > 65536 || p.MaxOutputChunkBytes+1024 > maxMessage || p.LeaseRefreshMarginMs >= p.AdmissionLeaseTtlMs {
		return false
	}
	return !in.BashAvailable || (in.AdmissionLease != nil && len(in.AdmissionLease.Token) == 16 && in.AdmissionLease.RemainingTtlMs > 0)
}
