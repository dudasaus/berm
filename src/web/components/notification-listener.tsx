import { useEffect, useRef, useState } from "react";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import { Bell, BellOff, WifiOff } from "lucide-react";
import { toast } from "sonner";

import { Button } from "./ui/button";
import type { BermNotification } from "../../shared/notifications";

type NotificationApi = {
  subscribe(client: BrowserNotificationClient): Promise<{ recent: BermNotification[] }>;
};

type BrowserNotificationPermission = NotificationPermission | "unsupported";
type NotificationConnectionState = "connecting" | "connected" | "disconnected";
type BrowserNotificationDelivery = {
  permission: BrowserNotificationPermission;
  nativeShown: boolean;
  nativePath: "service-worker" | "window" | null;
  toastShown: boolean;
};
type NotificationToastFn = (title: string, options?: { description?: string; action?: { label: string; onClick: () => void } }) => void;

class BrowserNotificationClient extends RpcTarget {
  constructor(private readonly onNotify: (notification: BermNotification) => Promise<BrowserNotificationDelivery>) {
    super();
  }

  notify(notification: BermNotification) {
    return this.onNotify(notification);
  }
}

function notificationSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/notifications`;
}

function toastForLevel(level: BermNotification["level"]): NotificationToastFn {
  switch (level) {
    case "success":
      return toast.success;
    case "warning":
      return toast.warning;
    case "error":
      return toast.error;
    case "info":
      return toast.info;
  }
}

function readPermission(): BrowserNotificationPermission {
  if (!("Notification" in window)) {
    return "unsupported";
  }

  return Notification.permission;
}

async function requestPermission(): Promise<BrowserNotificationPermission> {
  if (!("Notification" in window)) {
    return "unsupported";
  }

  if (Notification.permission !== "default") {
    return Notification.permission;
  }

  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

async function showBrowserNotification(notification: BermNotification): Promise<{
  nativeShown: boolean;
  nativePath: BrowserNotificationDelivery["nativePath"];
}> {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return { nativeShown: false, nativePath: null };
  }

  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.register("/notification-worker.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      await registration.showNotification(notification.title, {
        body: notification.message ?? undefined,
        tag: notification.id,
        data: {
          url: window.location.href,
        },
      });
      return { nativeShown: true, nativePath: "service-worker" };
    } catch {
      // Fall through to window Notification for browsers without service-worker notification support.
    }
  }

  try {
    const browserNotification = new Notification(notification.title, {
      body: notification.message ?? undefined,
      tag: notification.id,
    });
    browserNotification.onclick = () => {
      window.focus();
      browserNotification.close();
    };
    return { nativeShown: true, nativePath: "window" };
  } catch {
    return { nativeShown: false, nativePath: null };
  }
}

function showToast(notification: BermNotification) {
  const notify = toastForLevel(notification.level);
  const action =
    "Notification" in window && Notification.permission === "default"
      ? {
          label: "Enable",
          onClick: () => {
            void requestPermission();
          },
        }
      : undefined;

  notify(notification.title, {
    description: notification.message ?? undefined,
    ...(action ? { action } : {}),
  });
}

export function NotificationListener() {
  const seenIdsRef = useRef(new Set<string>());
  const [permission, setPermission] = useState<BrowserNotificationPermission>(() =>
    typeof window === "undefined" ? "unsupported" : readPermission(),
  );
  const [connectionState, setConnectionState] = useState<NotificationConnectionState>("connecting");

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;
    let pollTimer: number | null = null;
    let api: RpcStub<NotificationApi> | null = null;

    const handleNotification = async (notification: BermNotification): Promise<BrowserNotificationDelivery> => {
      if (seenIdsRef.current.has(notification.id)) {
        return {
          permission: readPermission(),
          nativePath: null,
          nativeShown: false,
          toastShown: false,
        };
      }

      seenIdsRef.current.add(notification.id);
      const nativeDelivery = await showBrowserNotification(notification);
      showToast(notification);
      return {
        permission: readPermission(),
        nativePath: nativeDelivery.nativePath,
        nativeShown: nativeDelivery.nativeShown,
        toastShown: true,
      };
    };

    const syncRecentNotifications = async () => {
      try {
        const response = await fetch("/api/notifications");
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { notifications?: BermNotification[] };
        for (const notification of payload.notifications ?? []) {
          void handleNotification(notification);
        }
      } catch {
        // The WebSocket path reports connection state; polling is only a delivery fallback.
      }
    };

    const connect = async () => {
      if (disposed) {
        return;
      }

      setConnectionState("connecting");
      try {
        const client = new BrowserNotificationClient(handleNotification);
        api = newWebSocketRpcSession<NotificationApi>(notificationSocketUrl());
        api.onRpcBroken(() => {
          if (disposed) {
            return;
          }
          setConnectionState("disconnected");
          reconnectTimer = window.setTimeout(connect, 1_500);
        });
        const subscribed = await api.subscribe(client);
        setConnectionState("connected");
        for (const notification of subscribed.recent) {
          void handleNotification(notification);
        }
      } catch {
        if (!disposed) {
          setConnectionState("disconnected");
          reconnectTimer = window.setTimeout(connect, 1_500);
        }
      }
    };

    void connect();
    void syncRecentNotifications();
    pollTimer = window.setInterval(() => {
      void syncRecentNotifications();
    }, 2_500);

    return () => {
      disposed = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      if (pollTimer) {
        window.clearInterval(pollTimer);
      }
      api?.[Symbol.dispose]();
    };
  }, []);

  const handleEnableNotifications = async () => {
    setPermission(await requestPermission());
  };

  if (permission === "granted" && connectionState === "connected") {
    return null;
  }

  const Icon =
    permission === "default"
      ? Bell
      : connectionState === "connected"
        ? permission === "denied"
          ? BellOff
          : Bell
        : WifiOff;
  const label =
    permission === "default"
      ? "Enable notifications"
      : connectionState !== "connected"
        ? "Notifications offline"
        : permission === "denied"
          ? "Notifications blocked"
          : "Notifications unavailable";

  return (
    <div className="fixed bottom-3 right-3 z-50">
      <Button
        type="button"
        variant={permission === "denied" || connectionState === "disconnected" ? "outline" : "secondary"}
        size="sm"
        className="shadow-lg backdrop-blur"
        onClick={permission === "default" ? handleEnableNotifications : undefined}
        disabled={permission !== "default"}
      >
        <Icon className="h-3.5 w-3.5" />
        {label}
      </Button>
    </div>
  );
}
