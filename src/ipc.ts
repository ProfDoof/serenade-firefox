import { v4 as uuidv4 } from "uuid";
import ExtensionCommandHandler from "./extension-command-handler";
export default class IPC {
  private app: string;
  private extensionCommandHandler: ExtensionCommandHandler;
  private connected: boolean = false;
  private id: string = "";
  private websocket?: WebSocket;
  private url: string = "ws://localhost:17373/";

  constructor(app: string, extensionCommandHandler: ExtensionCommandHandler) {
    this.app = app;
    this.extensionCommandHandler = extensionCommandHandler;
    this.id = uuidv4();
  }

  isConnected() {
    return this.connected;
  }

  private onClose() {
    this.connected = false;
  }

  private async onMessage(message: any) {
    if (typeof message === "string") {
      let request;
      try {
        request = JSON.parse(message);
      } catch (e) {
        return;
      }

      if (request.message === "response") {
        const result = await this.handle(request.data.response);
        if (result) {
          this.send("callback", {
            callback: request.data.callback,
            data: result,
          });
        }
      }
    }
  }

  private onOpen() {
    this.connected = true;
    this.sendActive();
  }

  async ensureConnection(): Promise<void> {
    if (this.connected) {
      return;
    }
    return new Promise((resolve) => {
      try {
        this.websocket = new WebSocket(this.url);

        this.websocket.addEventListener("open", () => {
          this.onOpen();
          resolve();
        });

        this.websocket.addEventListener("close", () => {
          this.onClose();
        });

        this.websocket.addEventListener("message", (event) => {
          this.onMessage(event.data);
        });
      } catch (e) { }
    });
  }

  private async tab(): Promise<any> {
    const [result] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return result;
  }

  private async sendMessageToContentScript(message: any): Promise<void> {
    let tab = await this.tab();
    if (!tab?.id || tab.url?.startsWith("chrome://")) {
      return;
    }
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab!.id!, message, (response) => {
        resolve(response);
      });
    });
  }

  async handle(response: any): Promise<any> {
    let handlerResponse = null;
    if (response.execute) {
      for (const command of response.execute.commandsList) {
        if (command.type !== "COMMAND_TYPE_GET_EDITOR_STATE") {
          console.log(command);
        }
        if (command.type in (this.extensionCommandHandler as any)) {
          handlerResponse = await (this.extensionCommandHandler as any)[command.type](command);
        } else {
          handlerResponse = await this.sendMessageToContentScript({
            type: "injected-script-command-request",
            data: command,
          });
        }
      }
    }

    let result = {
      message: "completed",
      data: {},
      success: true,
    };

    if (handlerResponse) {
      if (handlerResponse.data?.success !== undefined) {
        handlerResponse.success = handlerResponse.data.success;
        delete (handlerResponse.data.success)
      }
      result = { ...handlerResponse };
    }
    console.log(result);
    return result;
  }

  sendActive() {
    this.send("active", {
      app: this.app,
      id: this.id,
    });
  }

  sendHeartbeat() {
    this.send("heartbeat", {
      app: this.app,
      id: this.id,
    });
  }

  send(message: string, data: any) {
    if (!this.connected || !this.websocket || this.websocket!.readyState != 1) {
      return false;
    }

    try {
      this.websocket!.send(JSON.stringify({ message, data }));
      return true;
    } catch (e) {
      this.connected = false;
      return false;
    }
  }

  async start() {
    await this.ensureConnection();

    setInterval(this.ensureConnection, 1000);

    // Use alarm to send heartbeat to client
    chrome.alarms.create("sendHeartbeatToClient", { periodInMinutes: 1 })
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "sendHeartbeatToClient") {
        this.sendHeartbeat();
      }
    })
  }
}
