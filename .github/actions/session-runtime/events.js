const MAX_CHUNK = 4_096;

class EventSink {
  constructor({ emit, flushDelay = 100, schedule = setTimeout, cancel = clearTimeout }) {
    this.emit = emit;
    this.flushDelay = flushDelay;
    this.schedule = schedule;
    this.cancel = cancel;
    this.buffers = new Map();
  }

  text(turnId, text) {
    if (typeof text !== "string" || text.length === 0) return;
    const buffered = this.buffers.get(turnId) ?? "";
    this.buffers.set(turnId, `${buffered}${text}`);
    if (this.buffers.get(turnId).length >= MAX_CHUNK) {
      this.flush(turnId);
      return;
    }
    if (!this.timer) this.timer = this.schedule(() => this.flush(), this.flushDelay);
  }

  event(event) {
    this.flush();
    this.emit(event);
  }

  flush(onlyTurnId) {
    if (this.timer) this.cancel(this.timer);
    this.timer = undefined;
    for (const [turnId, text] of [...this.buffers]) {
      if (onlyTurnId !== undefined && turnId !== onlyTurnId) continue;
      this.buffers.delete(turnId);
      for (let offset = 0; offset < text.length; offset += MAX_CHUNK) {
        this.emit({
          type: "agent_message_chunk",
          data: { turnId, text: text.slice(offset, offset + MAX_CHUNK) },
        });
      }
    }
  }

  close() {
    this.flush();
  }
}

function bounded(value, maximum = 1_024) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}

module.exports = { EventSink, bounded };
