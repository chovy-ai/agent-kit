package remote

import (
	v1 "agent-kit/internal/remoteproto/v1"
	"google.golang.org/protobuf/proto"
)

func decodeBody(data []byte, msg proto.Message) error { return proto.Unmarshal(data, msg) }
func messageSize(msg *v1.Envelope) int                { return proto.Size(msg) }
