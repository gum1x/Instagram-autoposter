# Database Setup Guide

##  **Quick Setup for Hosting**

### **Option 1: Supabase (Recommended)**

1. **Create Supabase account**: https://supabase.com
2. **Create new project**
3. **Get your credentials**:
   - Project URL
   - API Key (anon/public key)
4. **Run the SQL schema**: Copy `supabase-schema.sql` into Supabase SQL editor
5. **Set environment variables**:
   ```
   SUPABASE_URL=your_project_url
   SUPABASE_KEY=your_api_key
   ```

### **Option 2: Keep SQLite (Local Only)**

If you want to keep using SQLite locally:
```
# No additional setup needed
# Uses sqlite.db file
```

## 🔧 **Environment Variables**

Add these to your `.env` file:

```bash
# Required
TELEGRAM_BOT_TOKEN=your_bot_token
ENCRYPTION_KEY=your_encryption_key

# Database (choose one)
# For Supabase:
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_anon_key

# For SQLite (local):
DATABASE_URL=sqlite.db

# Optional
HEADLESS=true
```

## 📦 **Deployment Files**

For hosting, you need:
- `dist/` folder (compiled JavaScript)
- `package.json`
- `.env` file
- `uploads/` folder (for media files)

## 🚀 **Deploy Commands**

```bash
# Build the project
npm run build

# Start bot only
npm run bot

# Start scheduler only  
npm run start

# Start both (if hosting supports it)
npm run bot & npm run start
```

## 💡 **Pro Tips**

- **Supabase** is easier for hosting (no file system needed)
- **SQLite** works great locally
- **Memory usage**: Supabase uses less memory than SQLite + file system
- **Backups**: Supabase has automatic backups
- **Scaling**: Supabase scales better than SQLite

## 🔍 **Testing**

Test locally first:
```bash
# Test with Supabase
SUPABASE_URL=your_url SUPABASE_KEY=your_key npm run bot

# Test with SQLite
npm run bot
```
