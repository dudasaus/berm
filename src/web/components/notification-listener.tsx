import { useEffect, useRef } from "react";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import { toast } from "sonner";

import type { BermNotification } from "../../shared/notifications";

type NotificationApi = {
  subscribe(client: BrowserNotificationClient): Promise<{ recent: BermNotification[] }>;
};

type NotificationToastFn = (title: string, options?: { description?: string; action?: { label: string; onClick: () => void } }) => void;

class BrowserNotificationClient extends RpcTarget {
  constructor(private readonly onNotify: (notification: BermNotification) => void) {
    super();
  }

  notify(notification: BermNotification) {
    this.onNotify(notification);
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

function requestPermission() {
  if (!("Notification" in window) || Notification.permission !== "default") {
    return;
  }

  void Notification.requestPermission().catch(() => {});
}

function showBrowserNotification(notification: BermNotification): boolean {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return false;
  }

  const browserNotification = new Notification(notification.title, {
    body: notification.message ?? undefined,
    tag: notification.id,
  });
  browserNotification.onclick = () => {
    window.focus();
    browserNotification.close();
  };
  return true;
}

function showToast(notification: BermNotification) {
  const notify = toastForLevel(notification.level);
  const action =
    "Notification" in window && Notification.permission === "default"
      ? {
          label: "Enable",
          onClick: requestPermission,
        }
      : undefined;

  notify(notification.title, {
    description: notification.message ?? undefined,
    ...(action ? { action } : {}),
  });
}

export function NotificationListener() {
  const seenIdsRef = useRef(new Set<string>());

  useEffect(() => {
    requestPermission();

    let disposed = false;
    let reconnectTimer: number | null = null;
    let api: RpcStub<NotificationApi> | null = null;

    const handleNotification = (notification: BermNotification) => {
      if (seenIdsRef.current.has(notification.id)) {
        return;
      }

      seenIdsRef.current.add(notification.id);
      if (!showBrowserNotification(notification)) {
        showToast(notification);
      }
    };

    const connect = async () => {
      if (disposed) {
        return;
      }

      try {
        const client = new BrowserNotificationClient(handleNotification);
        api = newWebSocketRpcSession<NotificationApi>(notificationSocketUrl());
        api.onRpcBroken(() => {
          if (disposed) {
            return;
          }
          reconnectTimer = window.setTimeout(connect, 1_500);
        });
        const subscribed = await api.subscribe(client);
        for (const notification of subscribed.recent) {
          handleNotification(notification);
        }
      } catch {
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, 1_500);
        }
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      api?.[Symbol.dispose]();
    };
  }, []);

  return null;
}
