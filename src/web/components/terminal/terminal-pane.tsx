import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";

import { parseServerMessage, serializeMessage, type ClientMessage, type TerminalStatusState } from "../../../shared/protocol";

const TERMINAL_BG = "#1f1811";

export type TerminalConnectionState = "connecting" | "connected" | "disconnected";
export type SessionUnavailableReason = "deleted" | "missing";

export interface TerminalPaneHandle {
  clear: () => void;
  reset: () => void;
  reconnect: () => void;
}

interface TerminalPaneProps {
  projectId: string;
  sessionId: string;
  onConnectionStateChange: (state: TerminalConnectionState) => void;
  onTerminalStateChange: (state: TerminalStatusState) => void;
  onSessionUnavailable: (sessionId: string, reason: SessionUnavailableReason) => void;
}

function wsUrl(projectId: string, sessionId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/terminal?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`;
}

function suppressPendingViewportRefresh(terminal: Terminal): void {
  const core = (
    terminal as unknown as {
      _core?: {
        viewport?: {
          _refreshAnimationFrame?: number | null;
          _refresh?: (immediate: boolean) => void;
          _innerRefresh?: () => void;
          syncScrollArea?: (immediate?: boolean) => void;
        };
        _viewport?: {
          _refreshAnimationFrame?: number | null;
          _refresh?: (immediate: boolean) => void;
          _innerRefresh?: () => void;
          syncScrollArea?: (immediate?: boolean) => void;
        };
      };
    }
  )._core;

  const viewport = (
    core?.viewport ??
    core?._viewport
  );

  if (!viewport) {
    return;
  }

  if (typeof viewport._refreshAnimationFrame === "number" && viewport._refreshAnimationFrame >= 0) {
    window.cancelAnimationFrame(viewport._refreshAnimationFrame);
    viewport._refreshAnimationFrame = null;
  }

  viewport.syncScrollArea = () => {};
  viewport._refresh = () => {};
  if (typeof viewport._innerRefresh === "function") {
    viewport._innerRefresh = () => {};
  }
}

export const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(
  ({ projectId, sessionId, onConnectionStateChange, onTerminalStateChange, onSessionUnavailable }, ref) => {
    const mountRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const reconnectTimerRef = useRef<number | null>(null);
    const pingTimerRef = useRef<number | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const resizeRafRef = useRef<number | null>(null);
    const disposedRef = useRef(false);
    const onConnectionStateChangeRef = useRef(onConnectionStateChange);
    const onTerminalStateChangeRef = useRef(onTerminalStateChange);
    const onSessionUnavailableRef = useRef(onSessionUnavailable);

    const desiredStateRef = useRef<"connected" | "closed">("connected");

    useEffect(() => {
      onConnectionStateChangeRef.current = onConnectionStateChange;
    }, [onConnectionStateChange]);

    useEffect(() => {
      onTerminalStateChangeRef.current = onTerminalStateChange;
    }, [onTerminalStateChange]);

    useEffect(() => {
      onSessionUnavailableRef.current = onSessionUnavailable;
    }, [onSessionUnavailable]);

    const sendMessage = useCallback((message: ClientMessage) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(serializeMessage(message));
    }, []);

    const sendResize = useCallback(() => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      sendMessage({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    }, [sendMessage]);

    const safeFitAndResize = useCallback(() => {
      if (disposedRef.current) {
        return;
      }

      const mount = mountRef.current;
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!mount || !mount.isConnected || !terminal || !fitAddon) {
        return;
      }

      const bounds = mount.getBoundingClientRect();
      if (bounds.width < 8 || bounds.height < 8) {
        return;
      }

      try {
        fitAddon.fit();
      } catch {
        return;
      }

      sendResize();
    }, [sendResize]);

    const reconnect = useCallback(() => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      const socket = socketRef.current;
      if (socket && socket.readyState <= WebSocket.OPEN) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close(1000, "Client reconnect");
      }

      const nextSocket = new WebSocket(wsUrl(projectId, sessionId));
      socketRef.current = nextSocket;
      onConnectionStateChangeRef.current("connecting");

      nextSocket.onopen = () => {
        if (socketRef.current !== nextSocket) {
          return;
        }
        onConnectionStateChangeRef.current("connected");
        safeFitAndResize();

        pingTimerRef.current = window.setInterval(() => {
          sendMessage({ type: "ping", ts: Date.now() });
        }, 25_000);
      };

      nextSocket.onmessage = (event) => {
        if (socketRef.current !== nextSocket) {
          return;
        }
        const parsed = parseServerMessage(event.data);
        if (!parsed.ok) {
          terminalRef.current?.writeln(`\r\n[protocol-error] ${parsed.error}`);
          return;
        }

        const message = parsed.value;
        if (message.type === "output") {
          terminalRef.current?.write(message.data);
          return;
        }

        if (message.type === "status") {
          onTerminalStateChangeRef.current(message.state);
          return;
        }

        if (message.type === "exit") {
          terminalRef.current?.writeln(`\r\n[process-exit] code=${message.code ?? "null"}`);
          return;
        }

        if (message.type === "error") {
          terminalRef.current?.writeln(`\r\n[server-error] ${message.message}`);
          return;
        }

        if (message.type === "session_deleted") {
          terminalRef.current?.writeln(`\r\n[session-deleted] ${message.sessionId}`);
          desiredStateRef.current = "closed";
          onSessionUnavailableRef.current(message.sessionId, "deleted");
          nextSocket.close(1000, "Session deleted");
          return;
        }

        if (message.type === "session_not_found") {
          terminalRef.current?.writeln(`\r\n[session-missing] ${message.sessionId}`);
          desiredStateRef.current = "closed";
          onSessionUnavailableRef.current(message.sessionId, "missing");
          nextSocket.close(1000, "Session not found");
        }
      };

      nextSocket.onclose = () => {
        if (socketRef.current !== nextSocket) {
          return;
        }

        if (pingTimerRef.current) {
          window.clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }

        onConnectionStateChangeRef.current("disconnected");

        if (desiredStateRef.current === "closed") {
          return;
        }

        reconnectTimerRef.current = window.setTimeout(() => {
          reconnect();
        }, 1_200);
      };
    }, [projectId, safeFitAndResize, sendMessage, sessionId]);

    useImperativeHandle(
      ref,
      () => ({
        clear() {
          terminalRef.current?.clear();
        },
        reset() {
          sendMessage({ type: "reset" });
        },
        reconnect,
      }),
      [reconnect, sendMessage],
    );

    const terminalOptions = useMemo(
      () => ({
        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        convertEol: true,
        theme: {
          background: TERMINAL_BG,
          foreground: "#f7e8d6",
          cursor: "#f5b26a",
          selectionBackground: "#704f3042",
          black: "#2f241a",
          red: "#d27862",
          green: "#b1d38d",
          yellow: "#e6cb79",
          blue: "#9ab4d6",
          magenta: "#c49cc7",
          cyan: "#7bbbc3",
          white: "#f4eee4",
          brightBlack: "#6f6255",
          brightRed: "#e9a093",
          brightGreen: "#c7e8a5",
          brightYellow: "#f4dd98",
          brightBlue: "#b6cae8",
          brightMagenta: "#dab9df",
          brightCyan: "#9ad2d8",
          brightWhite: "#fff9f2",
        },
      }),
      [],
    );

    useLayoutEffect(() => {
      disposedRef.current = false;
      desiredStateRef.current = "connected";

      const terminal = new Terminal(terminalOptions);
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      let openRafId: number | null = null;
      let onDataDispose: { dispose: () => void } | undefined;
      let removeFontListeners: (() => void) | undefined;
      let initialized = false;

      const initializeTerminal = () => {
        if (disposedRef.current) {
          return;
        }

        const mount = mountRef.current;
        if (!mount || !mount.isConnected || mount.clientWidth < 8 || mount.clientHeight < 8) {
          openRafId = window.requestAnimationFrame(initializeTerminal);
          return;
        }

        try {
          terminal.open(mount);
        } catch {
          openRafId = window.requestAnimationFrame(initializeTerminal);
          return;
        }

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        safeFitAndResize();

        onDataDispose = terminal.onData((data) => {
          sendMessage({ type: "input", data });
        });

        resizeObserverRef.current = new ResizeObserver(() => {
          if (resizeRafRef.current) {
            window.cancelAnimationFrame(resizeRafRef.current);
          }
          resizeRafRef.current = window.requestAnimationFrame(() => {
            safeFitAndResize();
          });
        });
        resizeObserverRef.current.observe(mount);

        if ("fonts" in document) {
          const fonts = document.fonts;
          const onFontsChanged = () => {
            safeFitAndResize();
          };

          void fonts.ready.then(onFontsChanged);
          fonts.addEventListener("loadingdone", onFontsChanged);
          fonts.addEventListener("loadingerror", onFontsChanged);

          removeFontListeners = () => {
            fonts.removeEventListener("loadingdone", onFontsChanged);
            fonts.removeEventListener("loadingerror", onFontsChanged);
          };
        }

        reconnect();
        initialized = true;
      };

      openRafId = window.requestAnimationFrame(initializeTerminal);

      return () => {
        disposedRef.current = true;
        desiredStateRef.current = "closed";
        const activeTerminal = terminalRef.current;

        terminalRef.current = null;
        fitAddonRef.current = null;

        if (openRafId) {
          window.cancelAnimationFrame(openRafId);
          openRafId = null;
        }

        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current);
        }

        if (pingTimerRef.current) {
          window.clearInterval(pingTimerRef.current);
        }

        if (resizeRafRef.current) {
          window.cancelAnimationFrame(resizeRafRef.current);
          resizeRafRef.current = null;
        }

        const socket = socketRef.current;
        if (socket && socket.readyState <= WebSocket.OPEN) {
          socket.onopen = null;
          socket.onmessage = null;
          socket.onclose = null;
          socket.onerror = null;
          socket.close(1000, "Component unmount");
        }

        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = null;
        removeFontListeners?.();
        onDataDispose?.dispose();
        if (initialized && activeTerminal) {
          try {
            suppressPendingViewportRefresh(activeTerminal);
            activeTerminal.dispose();
          } catch {
            // Prevent dispose race from crashing unmount.
          }
        }
      };
    }, [reconnect, safeFitAndResize, sendMessage, terminalOptions]);

    return (
      <div
        ref={mountRef}
        className="h-full min-h-[420px] w-full overflow-hidden bg-[#1f1811]"
        style={{ backgroundColor: TERMINAL_BG }}
      />
    );
  },
);

TerminalPane.displayName = "TerminalPane";
