export class SessionOwnership {
  private readonly createdParents = new Set<string>();
  private readonly createdForks = new Set<string>();

  trackCreatedParent(sessionId: string): void {
    this.createdParents.add(sessionId);
  }

  trackCreatedFork(parentSessionId: string, forkSessionId: string): void {
    if (!forkSessionId || forkSessionId === parentSessionId || this.createdParents.has(forkSessionId)) {
      throw new Error("ACP 返回了无效的保活 fork ID，已阻止后续操作");
    }
    this.createdForks.add(forkSessionId);
  }

  assertCanDelete(sessionId: string, allowCreatedParentCleanup = false): void {
    if (this.createdForks.delete(sessionId)) return;
    if (allowCreatedParentCleanup && this.createdParents.delete(sessionId)) return;
    throw new Error(`拒绝删除原始 session 或未知 session：${sessionId}`);
  }
}
