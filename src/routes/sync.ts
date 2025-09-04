import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';
import { BatchSyncRequest, BatchSyncResponse } from '../types';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db);

  // Trigger manual sync
  router.post('/sync', async (_req: Request, res: Response) => {
    try {
      const isOnline = await syncService.checkConnectivity();
      if (!isOnline) {
        return res.status(503).json({ error: 'Service unavailable. No internet connection.' });
      }
      const result = await syncService.sync();
      return res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return res.status(500).json({ error: 'Sync failed', details: message });
    }
  });

  // Check sync status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const isOnline = await syncService.checkConnectivity();
      const pendingCountResult = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM sync_queue');
      const pendingCount = pendingCountResult?.count || 0;
      const lastSyncResult = await db.get<{ last_sync: string }>('SELECT MAX(last_synced_at) as last_sync FROM tasks');
      const lastSync = lastSyncResult?.last_sync;

      res.json({
          is_online: isOnline,
          pending_sync_count: pendingCount,
          last_sync_timestamp: lastSync,
          sync_queue_size: pendingCount
      });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: 'Failed to get sync status', details: message });
    }
  });

  // Batch sync endpoint (for server-side)
  router.post('/batch', async (req: Request, res: Response) => {
    const { items } = req.body as BatchSyncRequest;
    const processed_items: BatchSyncResponse['processed_items'] = [];

    for (const item of items) {
        try {
            const { operation, task_id, data } = item;
            const localTask = await taskService.getTaskById(task_id);

            if (operation === 'create') {
                const newTask = await taskService.createTask(data);
                processed_items.push({
                    client_id: task_id,
                    server_id: newTask.id,
                    status: 'success',
                    resolved_data: newTask
                });
            } else if (operation === 'update') {
                if (!localTask) {
                    const newTask = await taskService.createTask(data);
                    processed_items.push({
                        client_id: task_id,
                        server_id: newTask.id,
                        status: 'success',
                        resolved_data: newTask
                    });
                } else {
                    const clientUpdatedAt = new Date(data.updated_at!);
                    const serverUpdatedAt = new Date(localTask.updated_at);

                    if (clientUpdatedAt > serverUpdatedAt) { // client wins
                        const updatedTask = await taskService.updateTask(task_id, data);
                        processed_items.push({
                            client_id: task_id,
                            server_id: task_id,
                            status: 'success',
                            resolved_data: updatedTask!
                        });
                    } else { // server wins
                        processed_items.push({
                            client_id: task_id,
                            server_id: task_id,
                            status: 'conflict',
                            resolved_data: localTask
                        });
                    }
                }
            } else if (operation === 'delete') {
                if (localTask) {
                    await taskService.deleteTask(task_id);
                }
                processed_items.push({
                    client_id: task_id,
                    server_id: task_id,
                    status: 'success'
                });
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            processed_items.push({
                client_id: item.task_id,
                server_id: '',
                status: 'error',
                error: message
            });
        }
    }
    res.json({ processed_items });
  });

  // Health check endpoint
  router.get('/health', async (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date() });
  });

  return router;
}