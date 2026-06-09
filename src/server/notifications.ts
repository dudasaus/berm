import { RpcTarget } from "capnweb";

import {
  createNotification,
  type BermNotification,
  type NotificationPublishResult,
  type NotificationRequest,
} from "../shared/notifications";

export interface NotificationClient extends RpcTarget {
  notify(notification: BermNotification): void | Promise<void>;
}

export interface NotificationApi extends RpcTarget {
  subscribe(client: NotificationClient): Promise<{ recent: BermNotification[] }>;
}

const MAX_RECENT_NOTIFICATIONS = 50;

type RetainedNotificationClient = NotificationClient & {
  dup?: () => NotificationClient;
  onRpcBroken?: (callback: (error: unknown) => void) => void;
  [Symbol.dispose]?: () => void;
};

export class NotificationService {
  #clients = new Set<NotificationClient>();
  #recent: BermNotification[] = [];

  createApi(): NotificationApi {
    return new NotificationRpcApi(this);
  }

  listRecent(): BermNotification[] {
    return [...this.#recent];
  }

  subscribe(client: NotificationClient): { recent: BermNotification[] } {
    const retainedClient = retainNotificationClient(client);
    this.#clients.add(retainedClient);
    retainedClient.onRpcBroken?.(() => {
      this.#clients.delete(retainedClient);
      retainedClient[Symbol.dispose]?.();
      console.info(
        JSON.stringify({
          event: "notification.websocket.disconnected",
          subscribers: this.#clients.size,
        }),
      );
    });
    console.info(
      JSON.stringify({
        event: "notification.websocket.connected",
        subscribers: this.#clients.size,
      }),
    );
    return { recent: this.listRecent() };
  }

  publish(input: NotificationRequest): NotificationPublishResult {
    const notification = createNotification(input);
    this.#recent.push(notification);
    this.#recent = this.#recent.slice(-MAX_RECENT_NOTIFICATIONS);

    console.info(
      JSON.stringify({
        event: "notification.received",
        id: notification.id,
        level: notification.level,
        source: notification.source,
        projectId: notification.projectId,
        sessionId: notification.sessionId,
      }),
    );

    let delivered = 0;
    let dropped = 0;
    for (const client of [...this.#clients]) {
      try {
        Promise.resolve(client.notify(notification))
          .then(() => {
            console.info(
              JSON.stringify({
                event: "notification.broadcast",
                id: notification.id,
              }),
            );
          })
          .catch((error) => {
            if (!this.#clients.has(client)) {
              return;
            }
            dropped += 1;
            this.#clients.delete(client);
            (client as RetainedNotificationClient)[Symbol.dispose]?.();
            console.warn(
              JSON.stringify({
                event: "notification.dropped",
                id: notification.id,
                error: error instanceof Error ? error.message : String(error),
                subscribers: this.#clients.size,
              }),
            );
          });
        delivered += 1;
      } catch (error) {
        dropped += 1;
        this.#clients.delete(client);
        (client as RetainedNotificationClient)[Symbol.dispose]?.();
        console.warn(
          JSON.stringify({
            event: "notification.dropped",
            id: notification.id,
            error: error instanceof Error ? error.message : String(error),
            subscribers: this.#clients.size,
          }),
        );
      }
    }

    console.info(
      JSON.stringify({
        event: "notification.publish.completed",
        id: notification.id,
        delivered,
        dropped,
        subscribers: this.#clients.size,
      }),
    );

    return { ok: true, notification };
  }
}

function retainNotificationClient(client: NotificationClient): RetainedNotificationClient {
  const maybeStub = client as RetainedNotificationClient;
  return (maybeStub.dup?.() as RetainedNotificationClient | undefined) ?? maybeStub;
}

class NotificationRpcApi extends RpcTarget implements NotificationApi {
  constructor(readonly service: NotificationService) {
    super();
  }

  async subscribe(client: NotificationClient): Promise<{ recent: BermNotification[] }> {
    return this.service.subscribe(client);
  }
}
