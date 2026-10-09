# Ziyana Shop

## Run locally

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`.

## Supabase setup

1. Open your Supabase project dashboard and choose **SQL Editor** from the left menu.
2. Choose **New query**, paste the complete contents of `supabase-schema.sql`, then click **Run**. Repeat this after schema updates. The migration creates missing profiles for existing Auth accounts, copies their email into the profile, and keeps it in sync for future signups or email changes.
3. In **Authentication**, enable Email provider and create the first admin user.
4. Copy that user's UUID and run the admin promotion query at the bottom of `supabase-schema.sql`.
5. Keep the Project URL and publishable key in `supabase-config.js`.

The app loads the public product catalog and store settings from Supabase when the schema is available. It keeps a local fallback so the storefront can still open when Supabase is temporarily unavailable.

Never put the Supabase `service_role` key in this repository or in browser code.
