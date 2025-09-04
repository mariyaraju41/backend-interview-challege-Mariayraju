import { v4 as uuidv4 } from 'uuid';
import { Task, SyncQueueItem, RawTask } from '../types';
import { Database } from '../db/database';

export class TaskService {
  constructor(private db: Database) {}

  private async addToSyncQueue(
    taskId: string,
    operation: 'create' | 'update' | 'delete',
    data: Partial<Task>
  ): Promise<void> {
    const item: SyncQueueItem = {
      id: uuidv4(),
      task_id: taskId,
      operation: operation,
      data: data,
      created_at: new Date(),
      retry_count: 0,
    };

    const sql = `
      INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const params = [
      item.id,
      item.task_id,
      item.operation,
      JSON.stringify(item.data),
      item.created_at.toISOString(),
      item.retry_count,
    ];
    await this.db.run(sql, params);
  }

  async createTask(taskData: Partial<Task>): Promise<Task> {
    const now = new Date();
    const newTask: Task = {
      id: uuidv4(),
      title: taskData.title!,
      description: taskData.description || '',
      completed: false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      sync_status: 'pending',
    };

    const sql = `
      INSERT INTO tasks (id, title, description, completed, created_at, updated_at, is_deleted, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      newTask.id,
      newTask.title,
      newTask.description,
      newTask.completed ? 1 : 0,
      newTask.created_at.toISOString(),
      newTask.updated_at.toISOString(),
      newTask.is_deleted ? 1 : 0,
      newTask.sync_status,
    ];

    await this.db.run(sql, params);
    await this.addToSyncQueue(newTask.id, 'create', {
      title: newTask.title,
      description: newTask.description,
    });

    return (await this.getTaskById(newTask.id))!;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const task = await this.getTaskById(id);
    if (!task) {
      return null;
    }

    const now = new Date();
    const updateData: Partial<Task> = { ...updates, updated_at: now, sync_status: 'pending' };

    const fields = Object.keys(updateData);
    const setClause = fields.map((k) => `${k} = ?`).join(', ');
    const params = fields.map((k) => {
      const value = (updateData as Record<string, unknown>)[k];
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value instanceof Date) return value.toISOString();
      return value;
    });

    const sql = `UPDATE tasks SET ${setClause} WHERE id = ?`;
    params.push(id);

    await this.db.run(sql, params);

    await this.addToSyncQueue(id, 'update', updates);
    return this.getTask(id);
  }

  async deleteTask(id: string): Promise<boolean> {
    const task = await this.getTaskById(id);
    if (!task) {
      return false;
    }

    const now = new Date();
    const sql = `
      UPDATE tasks
      SET is_deleted = 1, updated_at = ?, sync_status = 'pending'
      WHERE id = ?
    `;
    const params = [now.toISOString(), id];

    await this.db.run(sql, params);
    await this.addToSyncQueue(id, 'delete', {});
    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const sql = `SELECT * FROM tasks WHERE id = ? AND is_deleted = 0`;
    const row = await this.db.get<RawTask>(sql, [id]);
    return this.mapRowToTask(row);
  }

  async getTaskById(id: string): Promise<Task | null> {
    const sql = `SELECT * FROM tasks WHERE id = ?`;
    const row = await this.db.get<RawTask>(sql, [id]);
    return this.mapRowToTask(row);
  }

  async getAllTasks(): Promise<Task[]> {
    const sql = `SELECT * FROM tasks WHERE is_deleted = 0`;
    const rows = await this.db.all<RawTask>(sql);
    return rows.map((row) => this.mapRowToTask(row)!);
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const sql = `SELECT * FROM tasks WHERE sync_status = 'pending' OR sync_status = 'error'`;
    const rows = await this.db.all<RawTask>(sql);
    return rows.map((row) => this.mapRowToTask(row)!);
  }

  private mapRowToTask(row: RawTask | undefined): Task | null {
    if (!row) {
      return null;
    }
    return {
      ...row,
      completed: !!row.completed,
      is_deleted: !!row.is_deleted,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      last_synced_at: row.last_synced_at
        ? new Date(row.last_synced_at)
        : undefined,
    };
  }
}