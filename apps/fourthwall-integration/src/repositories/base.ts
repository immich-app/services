export abstract class BaseRepository {
  constructor(protected db: D1Database) {}

  protected generateId(): string {
    return crypto.randomUUID();
  }

  protected getCurrentTimestamp(): string {
    return new Date().toISOString();
  }

  protected async executeQuery<T = any>(query: string, params: any[] = []): Promise<D1Result<T>> {
    try {
      return await this.db
        .prepare(query)
        .bind(...params)
        .all();
    } catch (error) {
      console.error('Database query error:', error);
      throw error;
    }
  }

  protected async executeSingleQuery<T = any>(query: string, params: any[] = []): Promise<T | null> {
    try {
      const result = await this.db
        .prepare(query)
        .bind(...params)
        .first();
      return result as T | null;
    } catch (error) {
      console.error('Database query error:', error);
      throw error;
    }
  }

  protected async executeUpdate(query: string, params: any[] = []): Promise<D1Result> {
    try {
      return await this.db
        .prepare(query)
        .bind(...params)
        .run();
    } catch (error) {
      console.error('Database update error:', error);
      throw error;
    }
  }
}
