import 'dotenv/config';
import { createDatabase } from './dist/database.js';
import { readEncryptedJson, writeEncryptedJson } from './dist/utils.js';
import fs from 'fs/promises';
import path from 'path';

const db = createDatabase();

async function revokeAccess(accountNickname, tgUserId = '7682286393') {
  console.log(`🔒 Revoking access for account: ${accountNickname}`);
  
  try {
    // Find the account in database
    const account = await db.prepare(`
      SELECT * FROM accounts 
      WHERE tg_user_id = ? AND platform = ? AND nickname = ?
    `).get(tgUserId, 'instagram', accountNickname);
    
    if (!account) {
      console.log(`❌ Account not found: ${accountNickname}`);
      return { success: false, error: 'Account not found' };
    }
    
    console.log(`📝 Found account: ${account.username} (${account.nickname})`);
    
    // Delete the session file
    if (account.cookie_path) {
      try {
        await fs.unlink(account.cookie_path);
        console.log(`🗑️ Deleted session file: ${account.cookie_path}`);
      } catch (error) {
        console.log(`⚠️ Could not delete session file: ${error.message}`);
      }
    }
    
    // Update account status in database (mark as needs re-auth)
    await db.prepare(`
      UPDATE accounts 
      SET cookie_path = NULL, 
          username = NULL
      WHERE id = ?
    `).run(account.id);
    
    console.log(`✅ Access revoked for ${accountNickname}`);
    console.log(`📊 Account ${account.id} marked as needing re-authentication`);
    
    return { 
      success: true, 
      message: `Access revoked for ${accountNickname}. Please re-login via Telegram bot.`,
      accountId: account.id
    };
    
  } catch (error) {
    console.error(`💥 Failed to revoke access:`, error.message);
    return { success: false, error: error.message };
  }
}

async function revokeAllAccess(tgUserId = '7682286393') {
  console.log(`🔒 Revoking access for ALL Instagram accounts`);
  
  try {
    // Get all Instagram accounts for user
    const accounts = await db.prepare(`
      SELECT * FROM accounts 
      WHERE tg_user_id = ? AND platform = ?
    `).all(tgUserId, 'instagram');
    
    if (accounts.length === 0) {
      console.log(`❌ No Instagram accounts found`);
      return { success: false, error: 'No accounts found' };
    }
    
    console.log(`📝 Found ${accounts.length} Instagram accounts`);
    
    let revokedCount = 0;
    const results = [];
    
    for (const account of accounts) {
      console.log(`\n🔄 Processing: ${account.nickname}`);
      
      // Delete session file
      if (account.cookie_path) {
        try {
          await fs.unlink(account.cookie_path);
          console.log(`🗑️ Deleted session file: ${account.cookie_path}`);
        } catch (error) {
          console.log(`⚠️ Could not delete session file: ${error.message}`);
        }
      }
      
      // Update account status
      await db.prepare(`
        UPDATE accounts 
        SET cookie_path = NULL, 
            username = NULL
        WHERE id = ?
      `).run(account.id);
      
      revokedCount++;
      results.push({ account: account.nickname, success: true });
    }
    
    console.log(`\n✅ Revoked access for ${revokedCount} accounts`);
    return { 
      success: true, 
      message: `Access revoked for ${revokedCount} Instagram accounts`,
      revokedCount,
      results
    };
    
  } catch (error) {
    console.error(`💥 Failed to revoke all access:`, error.message);
    return { success: false, error: error.message };
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node revoke-access.js <account_nickname>  # Revoke specific account');
    console.log('  node revoke-access.js --all             # Revoke all accounts');
    console.log('  node revoke-access.js --list             # List all accounts');
    return;
  }
  
  if (args[0] === '--list') {
    console.log('📋 Listing all Instagram accounts:');
    const accounts = await db.prepare(`
      SELECT nickname, username, cookie_path, created_at 
      FROM accounts 
      WHERE platform = 'instagram'
      ORDER BY created_at DESC
    `).all();
    
    accounts.forEach((account, i) => {
      console.log(`${i + 1}. ${account.nickname} (${account.username || 'No username'})`);
      console.log(`   Session: ${account.cookie_path ? '✅ Active' : '❌ None'}`);
      console.log(`   Created: ${account.created_at}`);
      console.log('');
    });
    return;
  }
  
  if (args[0] === '--all') {
    const result = await revokeAllAccess();
    console.log('\n🎯 Result:', result);
    return;
  }
  
  // Revoke specific account
  const accountNickname = args[0];
  const result = await revokeAccess(accountNickname);
  console.log('\n🎯 Result:', result);
}

// Export functions for use in other modules
export { revokeAccess, revokeAllAccess };

// Run CLI if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
