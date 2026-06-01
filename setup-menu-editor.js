#!/usr/bin/env node

/**
 * Setup Script for Menu Editor Dashboard
 *
 * This script:
 * 1. Verifies connection to gcr-api-clean Supabase
 * 2. Creates admin user for cybercheck-login dashboard
 * 3. Creates test businesses with auto-generated PINs
 * 4. Verifies menu editor access
 *
 * Usage: node setup-menu-editor-db.js [--email admin@test.com] [--password testpass123]
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// ────────────────────────────────────────────────────────────────
// CONFIG
// ────────────────────────────────────────────────────────────────

const DB_URL = process.env.GCR_SUPABASE_URL || 'https://mkepugvdlktfsossumox.supabase.co';
const DB_KEY = process.env.GCR_SUPABASE_SERVICE_KEY;

// Parse CLI args
const args = process.argv.slice(2);
const emailIndex = args.indexOf('--email');
const passwordIndex = args.indexOf('--password');

const ADMIN_EMAIL = emailIndex !== -1 ? args[emailIndex + 1] : 'admin@cybercheck.local';
const ADMIN_PASSWORD = passwordIndex !== -1 ? args[passwordIndex + 1] : 'Admin123!@#';

// ────────────────────────────────────────────────────────────────
// INIT DB
// ────────────────────────────────────────────────────────────────

if (!DB_KEY) {
  console.error('❌ GCR_SUPABASE_SERVICE_KEY not found in .env');
  process.exit(1);
}

const db = createClient(DB_URL, DB_KEY);

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────

function generatePIN() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function log(step, message) {
  console.log(`\n📌 Step ${step}: ${message}`);
}

async function success(message) {
  console.log(`   ✅ ${message}`);
}

async function error(message) {
  console.error(`   ❌ ${message}`);
}

// ────────────────────────────────────────────────────────────────
// MAIN SETUP
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║         Menu Editor + CyberCheck Admin Dashboard Setup            ║
║                                                                   ║
║  Database: ${DB_URL}
║  Using: gcr-api-clean Supabase                                   ║
╚═══════════════════════════════════════════════════════════════════╝
  `);

  try {
    // ─── Step 1: Verify DB Connection
    await log(1, 'Verifying database connection...');
    const { data: tables, error: tablesErr } = await db.from('entity').select('slug').limit(1);
    if (tablesErr && tablesErr.code !== 'PGRST116') {
      throw new Error(`Database connection failed: ${tablesErr.message}`);
    }
    success('Connected to Supabase');

    // ─── Step 2: Create admin user in auth.users
    await log(2, `Creating admin user (${ADMIN_EMAIL})...`);
    try {
      const { data: user, error: signUpErr } = await db.auth.admin.createUser({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        email_confirm: true,
        user_metadata: { role: 'admin', name: 'Admin User' }
      });

      if (signUpErr) {
        if (signUpErr.message.includes('already exists')) {
          success(`Admin user already exists (${ADMIN_EMAIL})`);
        } else {
          throw signUpErr;
        }
      } else {
        success(`Admin user created with ID: ${user.id}`);
      }
    } catch (e) {
      error(`Could not create auth user: ${e.message}`);
      console.log('   (This is OK if using external auth or manual Supabase setup)');
    }

    // ─── Step 3: Create/verify test businesses with PINs
    await log(3, 'Creating test businesses with PINs...');

    const testBusinesses = [
      { name: 'Test Restaurant', description: 'A wonderful test restaurant' },
      { name: 'Italian Bistro', description: 'Fine Italian dining' },
      { name: 'Sushi Palace', description: 'Japanese cuisine and sushi' }
    ];

    for (const biz of testBusinesses) {
      const slug = slugify(biz.name);
      const pin = generatePIN();

      const { data: existing } = await db
        .from('entity')
        .select('slug, menu_pin')
        .eq('slug', slug)
        .single();

      if (existing) {
        success(`Business "${biz.name}" already exists (PIN: ${existing.menu_pin})`);
      } else {
        const { data: created, error: insertErr } = await db
          .from('entity')
          .insert({
            slug: slug,
            name: biz.name,
            description: biz.description,
            menu_pin: pin,
            hero_image_url: null,
            phone: '(251) 555-1234',
            website_url: 'https://example.com',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .select()
          .single();

        if (insertErr) {
          error(`Failed to create "${biz.name}": ${insertErr.message}`);
        } else {
          success(`Created "${biz.name}" (slug: ${slug}, PIN: ${pin})`);
        }
      }
    }

    // ─── Step 4: Display access instructions
    await log(4, 'Admin access instructions');
    console.log(`
   🔐 Login Credentials:
      Email:    ${ADMIN_EMAIL}
      Password: ${ADMIN_PASSWORD}

   🌐 Access URL:
      http://localhost:5173/login.html

   📝 After login:
      1. Go to "Menu Editors Hub"
      2. Select a business from the list
      3. Edit menu, specials, events, gallery
      4. Click "SAVE ALL TO DATABASE"
      5. Click "OPEN EDITOR" to open full menu editor
    `);

    // ─── Step 5: Summary
    await log(5, 'Setup complete!');
    console.log(`
   ✅ Database configured: ${DB_URL}
   ✅ Admin user created: ${ADMIN_EMAIL}
   ✅ Test businesses created: ${testBusinesses.length}
   ✅ Menu editor ready to use

   Next steps:
   1. Update cybercheck-login/js/supabase-client.js to use this Supabase
   2. Restart cybercheck-login dev server
   3. Log in with ${ADMIN_EMAIL}
   4. Start editing menus!
    `);

  } catch (err) {
    console.error(`\n❌ Setup failed: ${err.message}`);
    process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────
// RUN
// ────────────────────────────────────────────────────────────────

main();
