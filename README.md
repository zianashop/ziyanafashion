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

## Steadfast courier workflow

Order booking is an explicit admin action: first change an order to **Confirmed**, open its details, then click **Send to Steadfast**. A database claim prevents duplicate concurrent bookings. If a request times out or its result is uncertain, check the Steadfast merchant panel and use **Check courier status** before taking any further action; do not retry an uncertain booking blindly.

The browser only calls the `steadfast-booking` Supabase Edge Function. Steadfast API credentials must remain server-side:

1. Apply the latest complete `supabase-schema.sql` in the Supabase SQL Editor. It adds invoice/courier fields and the service-role-only booking claim function.
2. In the Supabase Dashboard, open **Edge Functions → Secrets** and set `STEADFAST_API_KEY` and `STEADFAST_SECRET_KEY` from the merchant account. Never paste these credentials into this repository, `supabase-config.js`, or browser code.
   The function calls `https://portal.packzy.com/api/v1`, the merchant API base URL.
3. Install the Supabase CLI in the repository if it is not installed already, then deploy from the repository root. When installed with npm, use `npx`:

   ```bash
   npm install --save-dev supabase
   npx supabase login
   npx supabase link --project-ref YOUR_SUPABASE_PROJECT_REF
   npx supabase functions deploy steadfast-booking
   ```

   The Edge Function uses native `fetch` for Supabase Auth/REST requests and has no third-party module import to download during bundling.

4. In the admin panel, use **Print invoice** for the internal invoice number/barcode. After a successful courier booking, **Print parcel label** prints the tracking-code barcode and recipient details. This is a merchant-generated parcel label, not a claim that it is an official Steadfast label.
5. The admin order search accepts order ID, invoice number, consignment ID, tracking code, mobile, or email. USB/Bluetooth barcode scanners that type into the focused search field and send Enter can be used for lookup.

The Edge Function verifies the caller's Supabase session and admin profile before accessing the service role or merchant API. Courier booking and delivery status remain separate from the shop's order fulfillment status.
