// Do NOT barrel-export server + browser clients from the same path.
// Import from the correct module directly:
//   Server: import { sql, supabaseServer } from '@/lib/db/server'
//   Browser: import { supabaseClient } from '@/lib/db/browser'
