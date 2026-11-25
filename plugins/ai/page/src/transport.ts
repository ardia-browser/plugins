import { ArdiaApi, fetchRequest } from "./api";
import { ardiaBridge, ChannelLink } from "./channelLink";
import { channelConnection, connect, signIn, type Connection } from "./connection";

export type Transport = {
  kind: "channel" | "socket";
  connection: Connection;
  api: ArdiaApi;
  healthy(): Promise<boolean>;
  onHealth: ((listener: (healthy: boolean) => void) => () => void) | null;
  openUrl: ((url: string) => void) | null;
};

export async function openTransport(): Promise<Transport> {
  const bridge = ardiaBridge();
  if (bridge) {
    const link = new ChannelLink(bridge);
    return {
      kind: "channel",
      connection: channelConnection(link),
      api: new ArdiaApi((method, path, body, signal) => link.api(method, path, body, signal)),
      healthy: async () => link.isHealthy,
      onHealth: (listener) => link.onHealth(listener),
      openUrl: (url) => link.open(url),
    };
  }
  const bearer = await signIn();
  return {
    kind: "socket",
    connection: await connect(bearer),
    api: new ArdiaApi(fetchRequest(bearer)),
    healthy: () => fetch("/.well-known/t3/environment", { cache: "no-store" }).then((r) => r.ok, () => false),
    onHealth: null,
    openUrl: null,
  };
}
