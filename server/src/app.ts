import express, { Request, Response } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';

const app = express();

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  const dbStatusMap: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };

  res.status(200).json({
    status: 'ok',
    message: 'ProjectWorld MERN Backend is running',
    database: dbStatusMap[mongoose.connection.readyState] || 'unknown',
    timestamp: new Date().toISOString(),
  });
});

export default app;
