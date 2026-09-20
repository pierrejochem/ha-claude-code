/** One user turn as the Agent SDK consumes it. */
export interface SdkUserTurn {
  type: 'user';
  message: { role: 'user'; content: unknown };
  parent_tool_use_id: null;
}

type Waiter = (result: IteratorResult<SdkUserTurn, undefined>) => void;

/** Async-iterable queue: the SDK pulls user messages from it for as long as the session lives. */
export class InputQueue implements AsyncIterable<SdkUserTurn> {
  private items: SdkUserTurn[] = [];
  private waiters: Waiter[] = [];
  private done = false;

  push(item: SdkUserTurn): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  end(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SdkUserTurn, undefined> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as SdkUserTurn, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
