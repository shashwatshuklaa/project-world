import mongoose from 'mongoose';

interface ConnectionState {
  isConnected: boolean;
}

const state: ConnectionState = {
  isConnected: false,
};

export async function connectDB(): Promise<typeof mongoose> {
  if (state.isConnected && mongoose.connection.readyState === 1) {
    return mongoose;
  }

  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error(
      'MONGODB_URI is not defined in the environment variables. Please provide a valid MongoDB connection string in server/.env'
    );
  }

  try {
    const conn = await mongoose.connect(uri, {
      autoIndex: process.env.NODE_ENV !== 'production',
      serverSelectionTimeoutMS: 5000,
    });

    state.isConnected = conn.connection.readyState === 1;

    console.log(`[Database] Connected to MongoDB: ${conn.connection.host}/${conn.connection.name}`);

    mongoose.connection.on('error', (err) => {
      console.error('[Database] MongoDB connection error:', err);
      state.isConnected = false;
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('[Database] MongoDB disconnected');
      state.isConnected = false;
    });

    return conn;
  } catch (error) {
    state.isConnected = false;
    console.error('[Database] Failed to connect to MongoDB:', error instanceof Error ? error.message : error);
    throw error;
  }
}

export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    state.isConnected = false;
    console.log('[Database] MongoDB connection closed');
  }
}

export default connectDB;
