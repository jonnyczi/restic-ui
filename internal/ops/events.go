package ops

import (
	"sync"
)

// Event is a live update pushed to UI clients over the WebSocket stream.
type Event struct {
	Type     string     `json:"type"` // "op" | "log" | "progress"
	Op       *Operation `json:"op,omitempty"`
	OpID     int64      `json:"opId,omitempty"`
	Log      *LogLine   `json:"log,omitempty"`
	Progress *Progress  `json:"progress,omitempty"`
}

// LogLine is one persisted/streamed log entry of an operation.
type LogLine struct {
	Seq     int64  `json:"seq"`
	TS      string `json:"ts"`
	Level   string `json:"level"` // info | warn | error
	Message string `json:"message"`
}

// Progress is a throttled snapshot of a running backup.
type Progress struct {
	PercentDone float64 `json:"percentDone"`
	TotalFiles  int64   `json:"totalFiles"`
	FilesDone   int64   `json:"filesDone"`
	TotalBytes  int64   `json:"totalBytes"`
	BytesDone   int64   `json:"bytesDone"`
	SecondsLeft int64   `json:"secondsLeft"`
	CurrentFile string  `json:"currentFile,omitempty"`
}

// Hub is a simple fan-out pub/sub for Events. Slow subscribers drop events
// rather than blocking operations.
type Hub struct {
	mu   sync.Mutex
	subs map[chan Event]struct{}
}

// NewHub constructs a Hub.
func NewHub() *Hub {
	return &Hub{subs: make(map[chan Event]struct{})}
}

// Subscribe registers a listener; call the returned cancel to unsubscribe.
func (h *Hub) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 256)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		if _, ok := h.subs[ch]; ok {
			delete(h.subs, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
}

// Publish delivers an event to all subscribers, dropping for full buffers.
func (h *Hub) Publish(e Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- e:
		default: // subscriber too slow; drop rather than stall a backup
		}
	}
}
