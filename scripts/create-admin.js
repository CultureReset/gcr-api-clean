#!/usr/bin/env node

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');

const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.error('Usage: node scripts/create-admin.js <email> <password>');
  process.exit(1);
}

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

async function createAdmin() {
  try {
    console.log(`Creating admin user: ${email}`);

    // Hash the password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert into admin_users table
    const { data, error } = await db
      .from('admin_users')
      .insert({
        email: email.toLowerCase(),
        password_hash: passwordHash,
        role: 'admin'
      })
      .select();

    if (error) {
      console.error('Error creating admin:', error.message);
      process.exit(1);
    }

    console.log('✅ Admin user created successfully!');
    console.log(`Email: ${email}`);
    console.log('\nYou can now login to cybercheck-login with the password you provided.');
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

createAdmin();
