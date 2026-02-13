// Import the Express framework, which helps us build web servers and APIs
import express from 'express';
import type { Request, Response } from 'express';

// Create an instance of an Express application
// Think of this as creating your web server that will listen for incoming requests
const app = express();

// Define the port number where your server will listen for requests
// Port 3000 is a common choice for development, but you can change this if needed
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON request bodies
// This allows your server to understand JSON data sent in POST/PUT requests
app.use(express.json());

// Define a simple route that responds to GET requests at the root path "/"
// When someone visits http://localhost:3000/, they'll see this response
app.get('/', (req: Request, res: Response) => {
  res.json({ 
    message: 'AI Ops Copilot API is running!',
    status: 'success',
    timestamp: new Date().toISOString()
  });
});

// Define a health check endpoint
// This is useful for monitoring tools to verify your API is alive and responding
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Define a sample API endpoint to test with
// This demonstrates how you might structure a simple API route
app.get('/api/status', (req: Request, res: Response) => {
  res.json({
    service: 'ai-ops-copilot',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Start the server and have it listen on the specified port
// The callback function runs once the server successfully starts
app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  console.log(`📊 Health check available at http://localhost:${PORT}/health`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('\nPress CTRL+C to stop the server');
});

// Handle graceful shutdown when the process receives a termination signal
// This ensures your server closes cleanly when you stop it with CTRL+C
process.on('SIGTERM', () => {
  console.log('\n👋 SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n👋 SIGINT signal received: closing HTTP server');
  process.exit(0);
});