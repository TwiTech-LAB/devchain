import { Injectable } from '@nestjs/common';

@Injectable()
export class ProjectGitMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(projectId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(projectId) === current) this.tails.delete(projectId);
    }
  }

  /** Resolves once every operation queued so far has finished. */
  async idle(): Promise<void> {
    await Promise.all(this.tails.values());
  }
}
