const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {...corsHeaders, 'Content-Type': 'application/json'}
  });

const errorMessage = (body: Record<string, unknown>) => {
  const details = body.errors;
  const validationErrors = details && typeof details === 'object'
    ? Object.values(details as Record<string, unknown>)
        .flatMap(value => Array.isArray(value) ? value : [value])
        .map(value => String(value))
        .join('; ')
    : '';
  return String(body.message || body.error || validationErrors || 'Steadfast request failed').slice(0, 500);
};

class SupabaseRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function requestSupabase<T>(
  supabaseUrl: string,
  apiKey: string,
  accessToken: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers:{
      apikey:apiKey,
      Authorization:`Bearer ${accessToken}`,
      'Content-Type':'application/json',
      ...(init.headers || {})
    },
    signal:init.signal || AbortSignal.timeout(15000)
  });
  const responseText = await response.text();
  const body = responseText ? JSON.parse(responseText) : null;
  if (!response.ok) {
    const message = body && typeof body === 'object'
      ? errorMessage(body as Record<string, unknown>)
      : `Supabase request failed (${response.status})`;
    throw new SupabaseRequestError(message, response.status);
  }
  return body as T;
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', {headers: corsHeaders});
  }

  if (request.method !== 'POST') {
    return jsonResponse({error:'Method not allowed'}, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = Deno.env.get('STEADFAST_API_KEY');
  const secretKey = Deno.env.get('STEADFAST_SECRET_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('Supabase Edge Function environment is incomplete');
    return jsonResponse({error:'Supabase function configuration is incomplete'}, 500);
  }

  const authorization = request.headers.get('Authorization') || '';
  const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) {
    return jsonResponse({error:'Admin login required'}, 401);
  }

  let user: {id: string};
  try {
    user = await requestSupabase<{id: string}>(
      supabaseUrl, anonKey, accessToken, '/auth/v1/user'
    );
  } catch (error) {
    if (error instanceof SupabaseRequestError && [401, 403].includes(error.status)) {
      return jsonResponse({error:'Admin login expired; sign in again'}, 401);
    }
    console.error('Supabase user authentication failed:', error);
    return jsonResponse({error:'Could not verify the admin session'}, 502);
  }

  let profiles: {role: string}[];
  try {
    profiles = await requestSupabase<{role: string}[]>(
      supabaseUrl,
      serviceRoleKey,
      serviceRoleKey,
      `/rest/v1/profiles?select=role&id=eq.${encodeURIComponent(user.id)}&limit=1`
    );
  } catch (error) {
    console.error('Supabase admin profile check failed:', error);
    return jsonResponse({error:'Could not verify admin permissions'}, 502);
  }

  if (profiles[0]?.role !== 'admin') {
    return jsonResponse({error:'Admin permission required'}, 403);
  }

  let payload: {action?: unknown; order_id?: unknown};
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({error:'Invalid JSON request'}, 400);
  }

  const action = payload.action;
  const orderId = String(payload.order_id || '');
  if (!['create', 'status'].includes(String(action)) || !/^[0-9a-f-]{36}$/i.test(orderId)) {
    return jsonResponse({error:'Invalid action or order ID'}, 400);
  }

  if (!apiKey || !secretKey) {
    return jsonResponse({error:'Steadfast API credentials are not configured in Supabase Edge Function secrets'}, 503);
  }

  let matchingOrders: Record<string, any>[];
  try {
    matchingOrders = await requestSupabase<Record<string, any>[]>(
      supabaseUrl,
      serviceRoleKey,
      serviceRoleKey,
      `/rest/v1/orders?select=*&id=eq.${encodeURIComponent(orderId)}&limit=1`
    );
  } catch (error) {
    console.error('Steadfast order lookup failed:', error);
    return jsonResponse({error:'Order lookup failed'}, 500);
  }

  const existingOrder = matchingOrders[0];
  if (!existingOrder) {
    return jsonResponse({error:'Order not found'}, 404);
  }

  const baseUrl = 'https://portal.packzy.com/api/v1';
  const headers = {
    'Api-Key':apiKey,
    'Secret-Key':secretKey,
    'Content-Type':'application/json',
    'Accept':'application/json'
  };

  if (action === 'status') {
    if (!existingOrder.consignment_id && !existingOrder.invoice_number) {
      return jsonResponse({error:'This order has no Steadfast booking to track'}, 409);
    }

    const statusPath = existingOrder.consignment_id
      ? `/status_by_cid/${encodeURIComponent(existingOrder.consignment_id)}`
      : `/status_by_invoice/${encodeURIComponent(existingOrder.invoice_number)}`;

    try {
      const response = await fetch(`${baseUrl}${statusPath}`, {
        method:'GET',
        headers,
        signal:AbortSignal.timeout(15000)
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok || Number(result.status) !== 200 || !result.delivery_status) {
        return jsonResponse({
          error:errorMessage(result),
          diagnostic:`Steadfast status endpoint returned HTTP ${response.status}`
        }, response.status >= 500 ? 502 : 422);
      }

      let updatedOrders: Record<string, unknown>[];
      try {
        updatedOrders = await requestSupabase<Record<string, unknown>[]>(
          supabaseUrl,
          serviceRoleKey,
          serviceRoleKey,
          `/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=id,invoice_number,courier_name,consignment_id,tracking_code,courier_status,courier_error`,
          {
            method:'PATCH',
            headers:{Prefer:'return=representation'},
            body:JSON.stringify({courier_status:String(result.delivery_status), courier_error:null})
          }
        );
      } catch (error) {
        console.error('Steadfast status save failed:', error);
        return jsonResponse({error:'Courier status received but could not be saved'}, 500);
      }

      return jsonResponse({order:updatedOrders[0]});
    } catch (error) {
      console.error('Steadfast status request failed:', error);
      const diagnostic = error instanceof Error
        ? `${error.name}: ${error.message}`.slice(0, 240)
        : 'Unknown network error';
      return jsonResponse({
        error:'Steadfast status request failed before a response was received',
        diagnostic
      }, 502);
    }
  }

  if (existingOrder.consignment_id) {
    return jsonResponse({
      already_booked:true,
      order:{
        id:existingOrder.id,
        invoice_number:existingOrder.invoice_number,
        courier_name:existingOrder.courier_name,
        consignment_id:existingOrder.consignment_id,
        tracking_code:existingOrder.tracking_code,
        courier_status:existingOrder.courier_status,
        courier_error:null
      }
    });
  }

  if (existingOrder.status !== 'confirmed') {
    return jsonResponse({error:'Confirm the order in the admin panel before booking it'}, 409);
  }

  let claimedOrders: Record<string, any>[];
  try {
    claimedOrders = await requestSupabase<Record<string, any>[]>(
      supabaseUrl,
      serviceRoleKey,
      serviceRoleKey,
      '/rest/v1/rpc/claim_steadfast_booking',
      {method:'POST', body:JSON.stringify({p_order_id:orderId})}
    );
  } catch (error) {
    console.error('Steadfast booking claim failed:', error);
    return jsonResponse({error:'Could not safely reserve this order for courier booking'}, 500);
  }

  const order = Array.isArray(claimedOrders) ? claimedOrders[0] : null;
  if (!order) {
    let latestOrders: Record<string, any>[] = [];
    try {
      latestOrders = await requestSupabase<Record<string, any>[]>(
        supabaseUrl,
        serviceRoleKey,
        serviceRoleKey,
        `/rest/v1/orders?select=courier_status,consignment_id&id=eq.${encodeURIComponent(orderId)}&limit=1`
      );
    } catch (error) {
      console.error('Steadfast claimed-order status lookup failed:', error);
      return jsonResponse({error:'Could not determine whether this order is already being booked'}, 500);
    }
    const latestOrder = latestOrders[0];

    if (latestOrder?.consignment_id) {
      return jsonResponse({already_booked:true, order:latestOrder});
    }

    return jsonResponse({
      error:latestOrder?.courier_status === 'booking' || latestOrder?.courier_status === 'unknown'
        ? 'Booking is already in progress or needs checking in the Steadfast merchant panel; do not resend it.'
        : 'Only confirmed orders can be sent to Steadfast.'
    }, 409);
  }

  const customer = order.customer || {};
  const recipientName = String(customer.name || '').trim();
  const recipientPhone = String(customer.phone || '')
    .replace(/[০-৯]/g, digit => String('০১২৩৪৫৬৭৮৯'.indexOf(digit)))
    .replace(/[^\d+]/g, '');
  const recipientAddress = [customer.address, order.district]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(', ');
  const codAmount = order.payment === 'cod' ? Number(order.total) : 0;
  const note = (Array.isArray(order.items) ? order.items : [])
    .map((item: {name?: string; quantity?: number}) => `${item.name || 'Product'} x${item.quantity || 1}`)
    .join(', ')
    .slice(0, 240);

  if (!recipientName || recipientPhone.replace(/\D/g, '').length < 10 || !recipientAddress || !Number.isFinite(codAmount)) {
    try {
      await requestSupabase<unknown>(
        supabaseUrl,
        serviceRoleKey,
        serviceRoleKey,
        `/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&courier_status=eq.booking`,
        {
          method:'PATCH',
          body:JSON.stringify({
            courier_status:'failed',
            courier_error:'Customer name, phone, address, or COD amount is invalid'
          })
        }
      );
    } catch (error) {
      console.error('Steadfast booking validation state could not be saved:', error);
      return jsonResponse({error:'Customer details are invalid and booking state could not be updated'}, 500);
    }
    return jsonResponse({error:'Customer name, valid phone, address, and COD amount are required'}, 422);
  }

  try {
    const response = await fetch(`${baseUrl}/create_order`, {
      method:'POST',
      headers,
      body:JSON.stringify({
        invoice:order.invoice_number,
        recipient_name:recipientName,
        recipient_phone:recipientPhone,
        recipient_address:recipientAddress,
        cod_amount:Math.max(0, Math.round(codAmount)),
        note
      }),
      signal:AbortSignal.timeout(20000)
    });
    const responseText = await response.text();
    let result: Record<string, any> = {};
    try {
      result = responseText ? JSON.parse(responseText) : {};
    } catch {
      result = {message:responseText.slice(0, 400)};
    }
    const consignment = result.consignment || {};

    if (!response.ok || Number(result.status) !== 200 || !consignment.consignment_id || !consignment.tracking_code) {
      const isAmbiguous = response.status >= 500 || (response.ok && !result.status);
      const message = `Steadfast API HTTP ${response.status}: ${errorMessage(result)}`;
      try {
        await requestSupabase<unknown>(
          supabaseUrl,
          serviceRoleKey,
          serviceRoleKey,
          `/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&courier_status=eq.booking`,
          {
            method:'PATCH',
            body:JSON.stringify({
              courier_status:isAmbiguous ? 'unknown' : 'failed',
              courier_error:message
            })
          }
        );
      } catch (saveError) {
        console.error('Steadfast response failure state could not be saved:', saveError);
        return jsonResponse({
          error:'Steadfast did not confirm the booking and its failure state could not be saved. Verify in the merchant panel before retrying.'
        }, 500);
      }

      return jsonResponse({
        error:isAmbiguous
          ? 'Steadfast response is uncertain. Check the merchant panel before retrying to avoid a duplicate parcel.'
          : message,
        diagnostic:isAmbiguous ? message : undefined,
        courier_status:isAmbiguous ? 'unknown' : 'failed'
      }, isAmbiguous ? 502 : 422);
    }

    let updatedOrders: Record<string, unknown>[];
    try {
      updatedOrders = await requestSupabase<Record<string, unknown>[]>(
        supabaseUrl,
        serviceRoleKey,
        serviceRoleKey,
        `/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&courier_status=eq.booking&select=id,invoice_number,courier_name,booking_number,consignment_id,tracking_code,courier_status,courier_error`,
        {
          method:'PATCH',
          headers:{Prefer:'return=representation'},
          body:JSON.stringify({
            courier_name:'Steadfast',
            booking_number:String(consignment.consignment_id),
            consignment_id:String(consignment.consignment_id),
            tracking_code:String(consignment.tracking_code),
            courier_status:String(consignment.status || 'in_review'),
            courier_error:null
          })
        }
      );
    } catch (error) {
      console.error('Steadfast booking saved remotely but local save failed:', error);
      return jsonResponse({
        error:'Steadfast created the parcel but the result could not be saved. Check the merchant panel before retrying.',
        courier_status:'unknown'
      }, 500);
    }

    if (!updatedOrders.length) {
      console.error('Steadfast booking was created, but the booking claim was no longer held');
      return jsonResponse({
        error:'Steadfast created the parcel but the order update did not match its booking claim. Check the merchant panel.',
        courier_status:'unknown'
      }, 500);
    }

    return jsonResponse({order:updatedOrders[0]});
  } catch (error) {
    console.error('Steadfast booking request failed:', error);
    const diagnostic = error instanceof Error
      ? `${error.name}: ${error.message}`.slice(0, 240)
      : 'Unknown network error';
    const definitelyNotConnected = /dns error|failed to lookup address|name or service not known|could not resolve/i.test(diagnostic);
    const courierStatus = definitelyNotConnected ? 'failed' : 'unknown';
    const courierError = definitelyNotConnected
      ? `Steadfast host DNS lookup failed before connecting: ${diagnostic}`
      : 'Steadfast request timed out or the network failed; verify in the merchant panel before retrying';

    try {
      await requestSupabase<unknown>(
        supabaseUrl,
        serviceRoleKey,
        serviceRoleKey,
        `/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&courier_status=eq.booking`,
        {
          method:'PATCH',
          body:JSON.stringify({
            courier_status:courierStatus,
            courier_error:courierError
          })
        }
      );
    } catch (saveError) {
      console.error('Uncertain Steadfast booking state could not be saved:', saveError);
    }

    return jsonResponse({
      error:definitelyNotConnected
        ? 'Steadfast DNS lookup failed before the request connected. Once DNS is working, verify the merchant panel has no parcel before retrying.'
        : 'Steadfast response is uncertain. Check the merchant panel before retrying to avoid a duplicate parcel.',
      diagnostic,
      courier_status:courierStatus
    }, 502);
  }
});
