# Admin Login Setup for GCR API Clean

Follow these steps to enable admin login in cybercheck-login:

## Step 1: Create the admin_users table

Run the SQL in `admin_users_setup.sql` in your Supabase SQL editor:

```sql
CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);
```

## Step 2: Install dependencies

```bash
npm install
```

This installs:
- `jsonwebtoken` — for JWT token generation
- `bcrypt` — for password hashing

## Step 3: Create an admin user

Run the script to create your admin account:

```bash
node scripts/create-admin.js
```

This creates admin with:
- Email: `info@cybercheckinc.com`
- Password: `Cybercheckinc!`

Or customize:
```bash
node scripts/create-admin.js your-email@example.com your-password
```

## Step 4: Set environment variable

Add to `.env`:
```
JWT_SECRET=your-secure-random-string-here
```

Generate a secure secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Step 5: Login to cybercheck-login

1. Go to `https://cybercheck-login.vercel.app/login.html` (or local)
2. Email: `info@cybercheckinc.com`
3. Password: `Cybercheckinc!`
4. Click "Sign In"

You should now have access to the admin dashboard connected to gcr-api-clean-fresh!

## Testing the Login Endpoint

```bash
curl -X POST https://gcr-api-clean-fresh.vercel.app/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"info@cybercheckinc.com","password":"Cybercheckinc!"}'
```

Response should be:
```json
{
  "token": "eyJhbGc...",
  "admin": {
    "id": "uuid-here",
    "email": "info@cybercheckinc.com",
    "role": "admin"
  }
}
```

## Troubleshooting

- **Table already exists**: That's fine, the script handles it
- **Login fails**: Check the password hash was created correctly
- **JWT_SECRET not set**: Login will still work but tokens won't be secure for production
- **Email already exists**: Delete the user first: `DELETE FROM admin_users WHERE email = 'info@cybercheckinc.com'`
