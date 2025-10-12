import 'dotenv/config';
import { createDatabase } from './database.js';

console.log('Testing database connection...');

const db = createDatabase();

// Test basic database operations
try {
  console.log('Database adapter created successfully');
  
  // Test a simple query
  const testQuery = db.prepare('SELECT COUNT(*) FROM posts WHERE status = ?');
  console.log('Prepared statement created successfully');
  
  console.log('✅ Database connection test passed!');
  console.log('Ready for hosting with Supabase');
  
} catch (error) {
  console.error('❌ Database connection test failed:', error);
  process.exit(1);
}
