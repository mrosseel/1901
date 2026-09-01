// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGameEvents, useRefreshAt } from "./hooks";
import { noteServerTime, resetServerTime } from "./clock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closeCode: number | undefined;
  closeReason: string | undefined;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.onclose?.();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetServerTime();
  FakeWebSocket.instances = [];
  document.body.innerHTML = "";
});

function LiveProbe({ refresh }: { refresh: () => Promise<unknown> }) {
  const connected = useGameEvents("http://localhost/api/v1/game/one/events", refresh);
  return <span>{connected ? "live" : "fallback"}</span>;
}

function DeadlineProbe({ refresh }: { refresh: () => void }) {
  useRefreshAt("2026-01-01T12:00:01Z", refresh);
  return null;
}

describe("live game events", () => {
  it("switches to WebSockets and coalesces changes while a refresh is running", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let finish: (() => void) | null = null;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));

    await act(async () => root.render(<LiveProbe refresh={refresh} />));
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe("ws://localhost/api/v1/game/one/events");
    await act(async () => socket.onopen?.());
    expect(host.textContent).toBe("live");

    await act(async () => {
      socket.onmessage?.({ data: `{"type":"state","version":1}` });
      socket.onmessage?.({ data: `{"type":"state","version":2}` });
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish?.();
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("stops rapid state-read retries and yields to polling after five failures", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const host = document.createElement("div");
    const root = createRoot(host);
    const refresh = vi.fn().mockRejectedValue(new Error("gone"));
    await act(async () => root.render(<LiveProbe refresh={refresh} />));
    const socket = FakeWebSocket.instances[0];
    await act(async () => socket.onopen?.());
    await act(async () => socket.onmessage?.({ data: `{"type":"state","version":1}` }));

    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(refresh).toHaveBeenCalledTimes(5);
    expect(socket.closeCode).toBe(1011);
    expect(host.textContent).toBe("fallback");

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(refresh).toHaveBeenCalledTimes(5);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it("keeps reconnect backoff when an upgrade opens and immediately closes", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const host = document.createElement("div");
    const root = createRoot(host);
    const refresh = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<LiveProbe refresh={refresh} />));

    const first = FakeWebSocket.instances[0];
    await act(async () => first.onopen?.());
    await act(async () => first.close());
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = FakeWebSocket.instances[1];
    await act(async () => second.onopen?.());
    await act(async () => second.close());
    await act(async () => vi.advanceTimersByTimeAsync(1999));
    expect(FakeWebSocket.instances).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(FakeWebSocket.instances).toHaveLength(3);
    await act(async () => root.unmount());
  });

  it("refreshes when server grace time passes without a mutation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    noteServerTime("2026-01-01T12:00:00Z");
    const host = document.createElement("div");
    const root = createRoot(host);
    const refresh = vi.fn();
    await act(async () => root.render(<DeadlineProbe refresh={refresh} />));

    await act(async () => vi.advanceTimersByTimeAsync(1099));
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
