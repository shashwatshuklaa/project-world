import dotenv from 'dotenv';
dotenv.config();

import app from './app.js';
import { connectDB } from './config/db.js';

const PORT = process.env.PORT || 5000;

// Attempt database connection if URI is configured
if (process.env.MONGODB_URI) {
  connectDB().catch((err) => {
    console.error('[Server] Initial MongoDB connection failed:', err instanceof Error ? err.message : err);
  });
} else {
  console.warn('[Server] MONGODB_URI is not set. Running without active database connection.');
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
