import axios from 'axios';
import { Task, SyncQueueItem, SyncResult, BatchSyncRequest, BatchSyncResponse } from '../types';
import { Database } from '../db/database';

export class SyncService {
  private apiUrl: string;
  
  constructor(
    private db: Database,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
  }

  private async getSyncQueueItems(): Promise<SyncQueueItem[]> {
    const rows = await this.db.all<{id: string, task_id: string, operation: 'create' | 'update' | 'delete', data: string, created_at: string, retry_count: number}>('SELECT * FROM sync_queue ORDER BY created_at ASC');
    return rows.map(row => ({
        ...row,
        created_at: new Date(row.created_at),
        data: JSON.parse(row.data)
    }));
  }

  async sync(): Promise<SyncResult> {
    const items = await this.getSyncQueueItems();
    if (items.length === 0) {
        return { success: true, synced_items: 0, failed_items: 0, errors: [] };
    }

    const batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '50', 10);
    const batches: SyncQueueItem[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
        batches.push(items.slice(i, i + batchSize));
    }

    const results: SyncResult = { success: true, synced_items: 0, failed_items: 0, errors: [] };

    for (const batch of batches) {
        try {
            const batchResponse = await this.processBatch(batch);
            for (const processed of batchResponse.processed_items) {
                const originalItem = batch.find(item => item.task_id === processed.client_id)!;
                if (processed.status === 'success' || processed.status === 'conflict') {
                    results.synced_items++;
                    await this.updateSyncStatus(originalItem.id, 'synced', processed.resolved_data);
                } else {
                    results.failed_items++;
                    await this.handleSyncError(originalItem, new Error(processed.error));
                    results.errors.push({
                        task_id: processed.client_id,
                        operation: originalItem.operation,
                        error: processed.error || 'Unknown error',
                        timestamp: new Date()
                    });
                }
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            results.success = false;
            results.failed_items += batch.length;
            for (const item of batch) {
                await this.handleSyncError(item, new Error(message));
                results.errors.push({
                    task_id: item.task_id,
                    operation: item.operation,
                    error: message,
                    timestamp: new Date()
                });
            }
        }
    }

    results.success = results.failed_items === 0;
    return results;
  }

  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    const request: BatchSyncRequest = {
        items: items,
        client_timestamp: new Date()
    };
    const response = await axios.post<BatchSyncResponse>(`${this.apiUrl}/batch`, request);
    return response.data;
  }

  private async updateSyncStatus(queueItemId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    if (status === 'synced') {
        const item = await this.db.get<{task_id: string}>('SELECT task_id FROM sync_queue WHERE id = ?', [queueItemId]);
        if (!item) return;
        const { task_id: taskId } = item;

        const updateFields: Record<string, unknown> = {
            sync_status: 'synced',
            last_synced_at: new Date().toISOString(),
        };

        if (serverData) {
            if(serverData.server_id) updateFields.server_id = serverData.server_id;
            if(serverData.title !== undefined) updateFields.title = serverData.title;
            if(serverData.description !== undefined) updateFields.description = serverData.description;
            if(serverData.completed !== undefined) updateFields.completed = serverData.completed ? 1 : 0;
            if(serverData.updated_at !== undefined) updateFields.updated_at = new Date(serverData.updated_at).toISOString();
        }

        const fields = Object.keys(updateFields);
        const setClause = fields.map(k => `${k} = ?`).join(', ');
        const params = fields.map(k => updateFields[k]);

        const sql = `UPDATE tasks SET ${setClause} WHERE id = ?`;
        params.push(taskId);
        await this.db.run(sql, params);

        await this.db.run('DELETE FROM sync_queue WHERE id = ?', [queueItemId]);
    }
  }

  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    const maxRetries = 3;
    const newRetryCount = item.retry_count + 1;

    if (newRetryCount >= maxRetries) {
        await this.db.run('UPDATE tasks SET sync_status = ? WHERE id = ?', ['error', item.task_id]);
        await this.db.run(
            'UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?',
            [newRetryCount, `Permanent failure: ${error.message}`, item.id]
        );
    } else {
        await this.db.run(
            'UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?',
            [newRetryCount, error.message, item.id]
        );
    }
  }

  async checkConnectivity(): Promise<boolean> {
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}