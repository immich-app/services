export class DeferredRepository {
  private deferred: (() => Promise<unknown>)[] = [];
  constructor(private ctx: ExecutionContext) {}

  defer(call: () => Promise<unknown>): void {
    this.deferred.push(call);
  }

  runDeferred() {
    for (const call of this.deferred) {
      this.ctx.waitUntil(call());
    }
  }
}
