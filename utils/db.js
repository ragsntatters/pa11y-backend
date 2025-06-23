import mongoose from 'mongoose';

// Construct MongoDB URI from components
const constructMongoURI = () => {
  // First try to use MONGO_URL if it exists
  if (process.env.MONGO_URL) {
    return process.env.MONGO_URL;
  }

  // Then try to use MONGO_PUBLIC_URL if it exists
  if (process.env.MONGO_PUBLIC_URL) {
    return process.env.MONGO_PUBLIC_URL;
  }

  // Otherwise construct from components
  const username = process.env.MONGOUSER || process.env.MONGO_INITDB_ROOT_USERNAME;
  const password = process.env.MONGOPASSWORD || process.env.MONGO_INITDB_ROOT_PASSWORD;
  const host = process.env.MONGOHOST;
  const port = process.env.MONGOPORT;

  if (!username || !password || !host || !port) {
    console.error('Missing MongoDB connection components:');
    console.error('Username:', username ? '***exists***' : '***missing***');
    console.error('Password:', password ? '***exists***' : '***missing***');
    console.error('Host:', host ? '***exists***' : '***missing***');
    console.error('Port:', port ? '***exists***' : '***missing***');
    return null;
  }

  return `mongodb://${username}:${password}@${host}:${port}`;
};

// Get MongoDB URI
const MONGODB_URI = constructMongoURI();

// Validate MongoDB URI
if (!MONGODB_URI) {
  console.error('Failed to construct MongoDB URI from environment variables');
  console.error('Please ensure all required MongoDB connection variables are set in Railway');
  process.exit(1);
}

// MongoDB connection options
const mongooseOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
  socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
  maxPoolSize: 10, // Maintain up to 10 socket connections
  minPoolSize: 5, // Maintain at least 5 socket connections
  connectTimeoutMS: 10000, // Give up initial connection after 10s
  retryWrites: true,
  retryReads: true
};

// Connection state tracking
let isConnecting = false;
let connectionPromise = null;

// Function to establish connection with retry logic
const connectWithRetry = async () => {
  if (connectionPromise) {
    return connectionPromise;
  }

  if (isConnecting) {
    console.log('Connection already in progress, waiting...');
    return connectionPromise;
  }

  isConnecting = true;
  connectionPromise = new Promise(async (resolve, reject) => {
    let retries = 5;
    while (retries > 0) {
      try {
        console.log(`Attempting to connect to MongoDB (${retries} retries left)...`);
        console.log('Using MongoDB host:', process.env.MONGOHOST);
        await mongoose.connect(MONGODB_URI, mongooseOptions);
        console.log('Successfully connected to MongoDB');
        resolve();
        return;
      } catch (err) {
        console.error('MongoDB connection error:', err.message);
        retries--;
        if (retries === 0) {
          console.error('Failed to connect to MongoDB after all retries');
          reject(err);
          return;
        }
        console.log(`Retrying in 5 seconds... (${retries} retries left)`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  });

  try {
    await connectionPromise;
  } finally {
    isConnecting = false;
    connectionPromise = null;
  }
};

// Initialize connection
connectWithRetry().catch(err => {
  console.error('Initial MongoDB connection failed:', err);
  process.exit(1);
});

// Connection event handlers
mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
  // Attempt to reconnect
  if (!isConnecting) {
    console.log('Attempting to reconnect to MongoDB...');
    connectWithRetry().catch(console.error);
  }
});

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected, attempting to reconnect...');
  if (!isConnecting) {
    connectWithRetry().catch(console.error);
  }
});

mongoose.connection.on('connected', () => {
  console.log('MongoDB connected successfully');
});

// Ensure connection before operations
const ensureConnection = async () => {
  if (mongoose.connection.readyState !== 1) {
    console.log('MongoDB not connected, attempting to connect...');
    await connectWithRetry();
  }
};

const reportSchema = new mongoose.Schema({
  url: String,
  email: String,
  result: Object,
  type: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const Report = mongoose.model('Report', reportSchema);

export const saveReport = async (data) => {
  await ensureConnection();
  return new Report(data).save();
};

export const getAllReports = async () => {
  await ensureConnection();
  return Report.find().sort({ createdAt: -1 }).limit(100);
};

export const getReportById = async (id) => {
  await ensureConnection();
  return Report.findById(id);
};

export const canScanToday = async (email) => {
  await ensureConnection();
  const last = await Report.findOne({ email, type: 'public' }).sort({ createdAt: -1 });
  if (!last) return true;
  const now = new Date();
  return (now - last.createdAt) > 24 * 60 * 60 * 1000;
};