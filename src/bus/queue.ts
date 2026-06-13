import { InboundMessage, type InboundMessageInput, OutboundMessage, type OutboundMessageInput } from "./events.js";

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T) => void> = [];

  get size(): number {
    return this.items.length;
  }

  enqueue(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }

    this.items.push(item);
  }

  dequeue(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export class MessageBus {
  readonly #inboundQueue = new AsyncQueue<InboundMessage>();
  readonly #outboundQueue = new AsyncQueue<OutboundMessage>();

  async publishInbound(message: InboundMessage | InboundMessageInput): Promise<void> {
    this.#inboundQueue.enqueue(message instanceof InboundMessage ? message : new InboundMessage(message));
  }

  async consumeInbound(): Promise<InboundMessage> {
    return this.#inboundQueue.dequeue();
  }

  async publishOutbound(message: OutboundMessage | OutboundMessageInput): Promise<void> {
    this.#outboundQueue.enqueue(message instanceof OutboundMessage ? message : new OutboundMessage(message));
  }

  async consumeOutbound(): Promise<OutboundMessage> {
    return this.#outboundQueue.dequeue();
  }

  get inboundSize(): number {
    return this.#inboundQueue.size;
  }

  get outboundSize(): number {
    return this.#outboundQueue.size;
  }
}
