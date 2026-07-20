import { join } from "node:path";
import { atomicWriteJson, readJson } from "./atomic-json.js";
import type { StatePaths } from "./paths.js";
import { validateRepositoryId, validateRepositoryRecord, type RepositoryRecord } from "./records.js";

export class RepositoryRegistry {
  constructor(private readonly paths: StatePaths) {}

  async put(record: RepositoryRecord): Promise<void> {
    const valid = validateRepositoryRecord(record);
    await atomicWriteJson(this.recordPath(valid.repositoryId), valid);
  }

  async get(repositoryIdValue: string): Promise<RepositoryRecord | null> {
    const repositoryId = validateRepositoryId(repositoryIdValue);
    const value = await readJson(this.recordPath(repositoryId));
    return value === null ? null : validateRepositoryRecord(value, repositoryId);
  }

  private recordPath(repositoryId: string): string { return join(this.paths.repositories, `${repositoryId}.json`); }
}
