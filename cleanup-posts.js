import 'dotenv/config';
import { createDatabase } from './dist/database.js';
import { createLogger } from './dist/utils.js';

const db = createDatabase();
const log = createLogger('cleanup');

async function cleanupCompletedPosts(){
  try {
    log.info('Starting manual cleanup of completed posts');
    
    // Count completed posts before cleanup
    const beforeCount = await db.prepare(`select count(*) as count from posts where status='completed'`).get();
    log.info('Completed posts count before cleanup', { count: beforeCount.count });
    
    if (beforeCount.count === 0) {
      log.info('No completed posts to clean up');
      return;
    }
    
    // Delete completed posts
    const result = await db.prepare(`delete from posts where status='completed'`).run();
    log.info('Cleanup completed', { deletedCount: result.changes });
    
    // Verify cleanup
    const afterCount = await db.prepare(`select count(*) as count from posts where status='completed'`).get();
    log.info('Completed posts count after cleanup', { count: afterCount.count });
    
    // Show remaining posts by status
    const statusCounts = await db.prepare(`
      select status, count(*) as count 
      from posts 
      group by status 
      order by status
    `).all();
    
    log.info('Remaining posts by status', { statusCounts });
    
  } catch (error) {
    log.error('Cleanup failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node cleanup-posts.js                    # Clean up completed posts');
    console.log('  node cleanup-posts.js --status           # Show posts by status');
    console.log('  node cleanup-posts.js --all              # Clean up ALL posts (dangerous!)');
    return;
  }
  
  if (args[0] === '--status') {
    console.log('📊 Posts by status:');
    const statusCounts = await db.prepare(`
      select status, count(*) as count 
      from posts 
      group by status 
      order by status
    `).all();
    
    statusCounts.forEach(({ status, count }) => {
      console.log(`  ${status}: ${count}`);
    });
    return;
  }
  
  if (args[0] === '--all') {
    console.log('⚠️  WARNING: This will delete ALL posts from the database!');
    console.log('This is irreversible. Press Ctrl+C to cancel, or wait 5 seconds...');
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const result = await db.prepare(`delete from posts`).run();
    console.log(`🗑️  Deleted ${result.changes} posts from database`);
    return;
  }
  
  // Default: clean up completed posts
  await cleanupCompletedPosts();
}

// Export function for use in other modules
export { cleanupCompletedPosts };

// Run CLI if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
