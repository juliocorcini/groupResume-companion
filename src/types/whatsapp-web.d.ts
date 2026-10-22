declare module "whatsapp-web.js" {
  export class Client {
    constructor(options?: any);
    on(event: string, listener: (...args: any[]) => void): this;
    initialize(): Promise<void>;
    destroy(): Promise<void>;
    getChats(): Promise<any[]>;
    getChatById(id: string): Promise<any>;
    getContacts(): Promise<any[]>;
    sendMessage(chatId: string, content: string): Promise<any>;
  }

  export class LocalAuth {
    constructor(options?: { clientId?: string; dataPath?: string });
  }

  const _default: {
    Client: typeof Client;
    LocalAuth: typeof LocalAuth;
  };

  export default _default;
}
