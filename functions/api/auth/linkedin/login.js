// functions/api/auth/linkedin/login.js
// Initiates LinkedIn OpenID Connect login flow.
// Generates a CSRF state token, stores it in a short-lived HttpOnly cookie,
// then redirects the user to LinkedIn's authorization endpoint.

export async function onRequestGet({ env }) {
    const state = crypto.randomUUID();

  const params = new URLSearchParams({
        response_type: 'code',
        client_id: env.LINKEDIN_CLIENT_ID,
        redirect_uri: env.LINKEDIN_REDIRECT_URI,
        scope: 'openid profile email',
        state,
  });

  const headers = new Headers({
        Location: 'https://www.linkedin.com/oauth/v2/authorization?' + params.toString(),
  });

  // Store state in a short-lived HttpOnly cookie for CSRF validation on callback
  headers.append(
        'Set-Cookie',
        `li_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
      );

  return new Response(null, { status: 302, headers });
}
